/**
 * The simulation world: owns physics, ecology, genetics, speciation and event
 * detection. Framework-agnostic — the worker drains the outbox queues and
 * encodes snapshots; tests drive step() directly.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type {
  CreatureDetail,
  CreatureInfo,
  DeathCause,
  PhyloNode,
  SimEvent,
  SpeciesStat,
  SpeciesTraits,
  Vec3,
  WorldStats,
} from '../shared/types';
import type { HistorySeries } from '../shared/protocol';
import { PART_FLOATS, PLANT_FLOATS, PLANT_HEADER, SNAP_HEADER } from '../shared/protocol';
import {
  BITE_DAMAGE,
  BITE_RANGE,
  BUOYANCY_ACCEL,
  CLIMATE_DRIFT_AMPLITUDE,
  CLIMATE_DRIFT_PERIOD,
  COLD_SEASON_STRESS,
  DAY_LENGTH,
  DROWN_DPS,
  DROWN_GRACE,
  DT,
  EAT_RATE,
  GESTATION_OVERHEAD,
  HISTORY_SAMPLE_TICKS,
  HUNT_TRACK_SECONDS,
  INITIAL_POPULATION,
  MATE_RANGE,
  MATURITY_AGE,
  MAX_AGE,
  MAX_CREATURES,
  MIGRATION_DISTANCE,
  MIN_POPULATION,
  PLANTS_SNAPSHOT_INTERVAL,
  REPRO_COOLDOWN,
  REPRO_ENERGY_FRAC,
  SEASON_LIGHT_AMPLITUDE,
  SPECIES_THRESHOLD,
  STATS_INTERVAL_TICKS,
  STORE_PER_MASS,
  TERRAIN_SIZE,
  TISSUE_ENERGY_DENSITY,
  WATER_DRAG,
  YEAR_LENGTH,
} from '../shared/constants';
import { RNG } from '../shared/rng';
import { dist2d, dist3 } from './math3';
import { Creature } from './creature';
import { Ledger } from './ecology/ledger';
import { Ecosystem } from './ecology/plants';
import { generateTerrain, sampleHeight, type TerrainResult } from './ecology/terrain';
import { InnovationTracker, OUT_BASE } from './genome/brain';
import { crossoverGenomes, genomeDistance, mutateGenome, randomGenome, type Born } from './genome';
import { addTerrain, buildCreature, createWorld, destroyCreature, initRapier } from './physics';
import { Senses, type ColliderOwner } from './senses';
import { SpeciesTracker } from './species';

interface HuntTrack {
  preyId: number;
  seconds: number;
  lastEventTime: number;
}

export class World {
  phys!: RAPIER.World;
  terrain!: TerrainResult;
  ledger = new Ledger();
  eco!: Ecosystem;
  species!: SpeciesTracker;
  senses!: Senses;
  readonly tracker = new InnovationTracker();
  readonly creatures = new Map<number, Creature>();
  readonly owners = new Map<number, ColliderOwner>();
  private readonly selfColliders = new Map<number, Set<number>>();
  private eventQueue!: RAPIER.EventQueue;

  private rngEvo!: RNG;
  private rngMisc!: RNG;
  private nextCreatureId = 1;
  private geneIdCounter = 1000;
  seed = 0;

  tick = 0;
  time = 0;
  birthsTotal = 0;
  deathsTotal = 0;
  selectedId: number | null = null;

  // outboxes drained by the worker
  readonly outBirths: CreatureInfo[] = [];
  readonly outDeaths: { id: number; cause: DeathCause }[] = [];
  readonly outEvents: SimEvent[] = [];
  statsDirty: WorldStats | null = null;

  // climate cache (recomputed per tick)
  sunAngle = 0;
  seasonPhase = 0;
  light = 0;
  private coldStress = 0;
  private climateDrift = 0;
  private climateWalk = 0;

  // event detection state
  private huntTracks = new Map<number, HuntTrack>();
  private firstPredationSeen = false;
  private speciesCentroid = new Map<number, { x: number; z: number; time: number }>();
  private popPeak = 0;
  private lastMassExtinctionTime = -1e9;

  // history for charts
  private histTicks: number[] = [];
  private histSpecies = new Map<number, number[]>();
  private histPlant: number[] = [];

  nextGeneId = (): number => this.geneIdCounter++;

  async init(seed: number): Promise<void> {
    this.seed = seed;
    await initRapier();
    const rng = new RNG(seed);
    const rngTerrain = rng.fork(11);
    const rngEco = rng.fork(22);
    const rngSpecies = rng.fork(33);
    this.rngEvo = rng.fork(44);
    this.rngMisc = rng.fork(55);

    this.terrain = generateTerrain(rngTerrain);
    this.phys = createWorld();
    addTerrain(this.phys, this.terrain);
    this.eventQueue = new RAPIER.EventQueue(true);

    this.eco = new Ecosystem(this.terrain, rngEco, this.ledger);
    this.eco.seedInitial();
    this.species = new SpeciesTracker(rngSpecies, genomeDistance);
    this.senses = new Senses(this.phys, this.eco, this.terrain, this.owners);
    this.senses.rebuildPlantIndex();

    for (let i = 0; i < INITIAL_POPULATION; i++) this.spawnFounder();
  }

  // ------------------------------------------------------------- spawning

  private randomLandSpot(): Vec3 {
    for (let i = 0; i < 80; i++) {
      const x = this.rngMisc.range(-TERRAIN_SIZE / 2 + 8, TERRAIN_SIZE / 2 - 8);
      const z = this.rngMisc.range(-TERRAIN_SIZE / 2 + 8, TERRAIN_SIZE / 2 - 8);
      const h = sampleHeight(this.terrain, x, z);
      if (h > this.terrain.waterLevel + 0.6) return { x, y: h, z };
    }
    return { x: 0, y: sampleHeight(this.terrain, 0, 0), z: 0 };
  }

  private spawnFounder(nearGenomeOf?: Creature): Creature | null {
    const born = nearGenomeOf
      ? mutateGenome(nearGenomeOf.genome, this.rngEvo, this.tracker, this.nextGeneId)
      : randomGenome(this.rngEvo, this.tracker, this.nextGeneId);
    if (!born.plan.viable) return null;
    const biomass = TISSUE_ENERGY_DENSITY * born.plan.totalMass;
    const store = 0.62 * STORE_PER_MASS * born.plan.totalMass;
    // founders and rescues condense out of the substrate: drawn from the soil
    // pool so the books stay closed (DECISIONS.md D23)
    const need = biomass + store;
    if (this.ledger.state().soil < need) return null;
    this.ledger.soilToCreatures(need);
    const spot = this.randomLandSpot();
    return this.materialize(born, { x: spot.x, y: spot.y + 1.0, z: spot.z }, store, [], -1);
  }

  private materialize(born: Born, pos: Vec3, store: number, parents: number[], parentSpecies: number): Creature {
    const id = this.nextCreatureId++;
    const phys = buildCreature(this.phys, born.plan, pos, this.rngMisc.range(0, Math.PI * 2));
    const c = new Creature(id, born.genome, born.plan, phys, store, parents);
    const speciesBefore = this.species.count();
    c.speciesId = this.species.assign(born.genome, parentSpecies, this.tick);
    this.creatures.set(id, c);
    const set = new Set<number>();
    for (let i = 0; i < phys.colliders.length; i++) {
      const col = phys.colliders[i];
      this.owners.set(col.handle, { creature: c, part: i });
      set.add(col.handle);
    }
    this.selfColliders.set(id, set);
    this.birthsTotal++;

    this.outBirths.push({
      id,
      speciesId: c.speciesId,
      generation: c.generation,
      parents,
      plan: born.plan,
      organism: born.genome.organism,
    });
    if (this.species.count() > speciesBefore) {
      const rec = this.species.get(c.speciesId);
      this.pushEvent({
        tick: this.tick,
        kind: 'speciesBorn',
        pos: c.rootPos(),
        speciesId: c.speciesId,
        data: { name: rec?.name ?? '?', parent: parentSpecies },
        interest: 0.75,
      });
    }
    return c;
  }

  private removeCreature(c: Creature, killer: Creature | null): void {
    const pos = c.rootPos();
    const cause = c.deathCause ?? 'starved';
    const corpse = c.corpseEnergy();
    this.ledger.creaturesToCorpse(corpse);
    this.eco.addCorpse(pos.x, pos.z, pos.y, corpse);
    this.species.memberDied(c.speciesId, this.tick);
    const rec = this.species.get(c.speciesId);
    if (rec && rec.extinctTick === this.tick && rec.population <= 0) {
      this.pushEvent({
        tick: this.tick,
        kind: 'speciesExtinct',
        speciesId: c.speciesId,
        data: { name: rec.name },
        interest: 0.7,
      });
    }
    for (const h of this.selfColliders.get(c.id) ?? []) this.owners.delete(h);
    this.selfColliders.delete(c.id);
    destroyCreature(this.phys, c.phys);
    this.creatures.delete(c.id);
    this.deathsTotal++;
    this.huntTracks.delete(c.id);
    if (this.selectedId === c.id) this.selectedId = null;

    this.outDeaths.push({ id: c.id, cause });
    if (cause === 'killed' && killer) {
      this.pushEvent({
        tick: this.tick,
        kind: 'kill',
        pos,
        actors: [killer.id, c.id],
        speciesId: killer.speciesId,
        interest: 1,
      });
    } else {
      this.pushEvent({ tick: this.tick, kind: 'death', pos, actors: [c.id], data: { cause }, interest: 0.1 });
    }
  }

  // ------------------------------------------------------------- stepping

  step(): void {
    this.tick++;
    this.time += DT;
    this.updateClimate();
    this.eco.step(DT, this.light);
    if (this.tick % PLANTS_SNAPSHOT_INTERVAL === 0) this.senses.rebuildPlantIndex();

    const list = [...this.creatures.values()];

    // sense -> think -> act -> eat -> metabolize
    for (const c of list) {
      if (!c.alive) continue;
      for (let i = 0; i < c.touch.length; i++) c.touch[i] *= 0.8;
    }
    for (const c of list) {
      if (!c.alive) continue;
      const self = this.selfColliders.get(c.id)!;
      this.senses.fillInputs(c, this.time, self);
      c.brain.step();
      const muscleCost = c.actuate();
      this.applyWater(c);
      this.feed(c, list);
      c.age += DT;
      c.reproCooldown -= DT;
      if (c.age > MAX_AGE && this.rngMisc.chance(((c.age - MAX_AGE) / MAX_AGE) * DT)) c.die('oldAge');
      c.metabolize(this.coldStress, muscleCost, this.ledger);
    }

    this.phys.step(this.eventQueue);
    this.eventQueue.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
      if (!started) return;
      const o1 = this.owners.get(h1);
      const o2 = this.owners.get(h2);
      if (o1) o1.creature.touch[o1.part] = 1;
      if (o2) o2.creature.touch[o2.part] = 1;
    });

    // deaths
    for (const c of list) {
      if (!c.alive && this.creatures.has(c.id)) this.removeCreature(c, this.killerOf.get(c.id) ?? null);
    }
    this.killerOf.clear();

    // reproduction (bounded per tick)
    let births = 0;
    for (const c of this.creatures.values()) {
      if (births >= 3 || this.creatures.size >= MAX_CREATURES) break;
      if (this.tryReproduce(c)) births++;
    }

    // rescue: keep the experiment alive if the population collapses
    if (this.creatures.size < MIN_POPULATION && this.tick % 30 === 0) {
      const living = [...this.creatures.values()];
      const template = living.length > 0 && this.rngMisc.chance(0.7) ? this.rngMisc.pick(living) : undefined;
      this.spawnFounder(template);
    }

    this.detectHunts();
    if (this.tick % 300 === 0) this.detectMigrations();
    if (this.tick % 60 === 0) this.detectMassExtinction();
    this.seasonTickEvents();

    if (this.tick % STATS_INTERVAL_TICKS === 0) this.computeStats();
    if (this.tick % HISTORY_SAMPLE_TICKS === 0) this.sampleHistory();
  }

  private readonly killerOf = new Map<number, Creature>();

  private updateClimate(): void {
    const dayPhase = (this.time % DAY_LENGTH) / DAY_LENGTH;
    this.seasonPhase = (this.time % YEAR_LENGTH) / YEAR_LENGTH;
    this.sunAngle = dayPhase * Math.PI * 2;
    const sunElev = Math.sin(this.sunAngle);
    // slow random walk + long sine = climate drift
    this.climateWalk += this.rngMisc.gaussian(0, 0.0004);
    this.climateWalk = Math.max(-0.3, Math.min(0.3, this.climateWalk));
    this.climateDrift =
      CLIMATE_DRIFT_AMPLITUDE * Math.sin((Math.PI * 2 * this.time) / CLIMATE_DRIFT_PERIOD) + this.climateWalk;
    const seasonSin = Math.sin(this.seasonPhase * Math.PI * 2); // >0 warm half, <0 cold half
    const seasonLight = 1 + SEASON_LIGHT_AMPLITUDE * seasonSin;
    this.light = Math.max(0, sunElev) * Math.max(0.1, seasonLight + this.climateDrift);
    this.coldStress = Math.max(0, -seasonSin * COLD_SEASON_STRESS - this.climateDrift);
  }

  private applyWater(c: Creature): void {
    const wl = this.terrain.waterLevel;
    let rootSub = false;
    for (let i = 0; i < c.phys.bodies.length; i++) {
      const b = c.phys.bodies[i];
      const t = b.translation();
      if (t.y < wl) {
        const depth = Math.min(1, (wl - t.y) / 1.2);
        const m = b.mass();
        b.applyImpulse({ x: 0, y: depth * m * BUOYANCY_ACCEL * DT, z: 0 }, true);
        const lv = b.linvel();
        b.setLinvel({ x: lv.x * (1 - WATER_DRAG), y: lv.y * (1 - WATER_DRAG), z: lv.z * (1 - WATER_DRAG) }, true);
        if (i === 0) rootSub = true;
      }
    }
    if (rootSub) {
      c.submergedTime += DT;
      if (c.submergedTime > DROWN_GRACE) c.damage(DROWN_DPS * DT, 'drowned');
    } else {
      c.submergedTime = Math.max(0, c.submergedTime - DT * 2);
    }
  }

  /** One bite per tick from the first mouth part with a reachable target. */
  private feed(c: Creature, list: Creature[]): void {
    if (c.energy >= c.capacity - 1e-6) return;
    // intake scales allometrically, like metabolism (Kleiber-style)
    const biteBudget = EAT_RATE * Math.pow(c.plan.totalMass, 0.75) * DT;
    for (let i = 0; i < c.plan.parts.length; i++) {
      const part = c.plan.parts[i];
      if (!part.mouth) continue;
      const body = c.phys.bodies[i];
      const t = body.translation();
      const mouth: Vec3 = { x: t.x, y: t.y, z: t.z };

      // 1. bite a live creature
      let victim: Creature | null = null;
      let best = BITE_RANGE * 1.6;
      for (const o of list) {
        if (o === c || !o.alive) continue;
        const op = o.rootPos();
        const d = dist3(mouth, op);
        if (d < best + 0.9) {
          // refine against nearest part
          for (const ob of o.phys.bodies) {
            const obt = ob.translation();
            const dd = dist3(mouth, { x: obt.x, y: obt.y, z: obt.z });
            if (dd < best) {
              best = dd;
              victim = o;
            }
          }
        }
      }
      if (victim) {
        const gross = Math.min(biteBudget, Math.max(0, victim.corpseEnergy()));
        const net = this.ledger.biteCreature(gross, c.meatEff);
        victim.energy = Math.max(0, victim.energy - gross);
        c.absorb(net, 'meat');
        const killed = victim.damage(BITE_DAMAGE * DT, 'killed');
        if (killed) this.killerOf.set(victim.id, c);
        if (!this.firstPredationSeen) {
          this.firstPredationSeen = true;
          this.pushEvent({
            tick: this.tick,
            kind: 'firstPredation',
            pos: mouth,
            actors: [c.id, victim.id],
            speciesId: c.speciesId,
            interest: 1,
          });
        }
        return;
      }

      // 2. scavenge a corpse
      const scav = this.eco.scavengeAt(mouth.x, mouth.z, biteBudget, c.meatEff);
      if (scav > 0) {
        c.absorb(scav, 'meat');
        return;
      }

      // 3. graze plants
      const net = this.eco.grazeAt(mouth.x, mouth.z, biteBudget, c.plantEff);
      if (net > 0) {
        c.absorb(net, 'plant');
        return;
      }
    }
  }

  private tryReproduce(c: Creature): boolean {
    if (!c.alive || c.age < MATURITY_AGE || c.reproCooldown > 0) return false;
    if (c.energy < REPRO_ENERGY_FRAC * c.capacity) return false;

    let born: Born;
    let parents: number[];
    let mate: Creature | null = null;
    if (this.rngEvo.chance(c.genome.organism.sexual)) {
      mate = this.findMate(c);
      if (!mate) return false; // wants sex, no compatible mate nearby — wait
      const fitterFirst = c.energy / c.capacity >= mate.energy / mate.capacity;
      born = fitterFirst
        ? crossoverGenomes(c.genome, mate.genome, this.rngEvo, this.tracker, this.nextGeneId)
        : crossoverGenomes(mate.genome, c.genome, this.rngEvo, this.tracker, this.nextGeneId);
      parents = [c.id, mate.id];
    } else {
      born = mutateGenome(c.genome, this.rngEvo, this.tracker, this.nextGeneId);
      parents = [c.id];
    }
    if (!born.plan.viable) {
      c.reproCooldown = 4;
      return false;
    }

    const childBiomass = TISSUE_ENERGY_DENSITY * born.plan.totalMass;
    const childCap = STORE_PER_MASS * born.plan.totalMass;
    const endowment = c.genome.organism.offspringEnergyFrac * c.energy;
    const overhead = GESTATION_OVERHEAD * endowment;
    const need = overhead + childBiomass + 0.12 * childCap;
    if (endowment < need) {
      c.reproCooldown = 4;
      return false;
    }

    c.energy -= endowment;
    this.ledger.birthOverhead(overhead);
    const childStore = endowment - overhead - childBiomass;

    const p = c.rootPos();
    const pos = this.childSpot(p);
    this.materialize(born, pos, childStore, parents, c.speciesId);
    c.childCount++;
    c.reproCooldown = REPRO_COOLDOWN;
    if (mate) mate.reproCooldown = REPRO_COOLDOWN * 0.5;
    this.pushEvent({
      tick: this.tick,
      kind: 'birth',
      pos,
      actors: parents,
      speciesId: c.speciesId,
      interest: 0.25,
    });
    return true;
  }

  private childSpot(p: Vec3): Vec3 {
    for (let i = 0; i < 6; i++) {
      const a = this.rngMisc.range(0, Math.PI * 2);
      const r = this.rngMisc.range(1.6, 4);
      const x = clampW(p.x + Math.cos(a) * r);
      const z = clampW(p.z + Math.sin(a) * r);
      const h = sampleHeight(this.terrain, x, z);
      if (h > this.terrain.waterLevel + 0.3) return { x, y: h + 1.0, z };
    }
    return { x: p.x, y: p.y + 1.5, z: p.z };
  }

  private findMate(c: Creature): Creature | null {
    const p = c.rootPos();
    let best: Creature | null = null;
    let bestD = MATE_RANGE;
    for (const o of this.creatures.values()) {
      if (o === c || !o.alive || o.age < MATURITY_AGE) continue;
      if (o.energy < 0.5 * o.capacity) continue;
      const d = dist3(p, o.rootPos());
      if (d < bestD && genomeDistance(c.genome, o.genome) < SPECIES_THRESHOLD * 1.2) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  // ----------------------------------------------------- event detection

  private pushEvent(e: SimEvent): void {
    this.outEvents.push(e);
  }

  private detectHunts(): void {
    if (this.tick % 6 !== 0) return;
    for (const c of this.creatures.values()) {
      if (!c.alive || c.genome.organism.gutHerbivory > 0.55) continue;
      const p = c.rootPos();
      const v = c.phys.bodies[0].linvel();
      const speed = Math.hypot(v.x, v.z);
      if (speed < 1.2) {
        this.huntTracks.delete(c.id);
        continue;
      }
      // nearest other creature within 12 m that we are closing on
      let prey: Creature | null = null;
      let bestD = 12;
      for (const o of this.creatures.values()) {
        if (o === c || !o.alive) continue;
        const d = dist3(p, o.rootPos());
        if (d < bestD) {
          bestD = d;
          prey = o;
        }
      }
      if (!prey) {
        this.huntTracks.delete(c.id);
        continue;
      }
      const op = prey.rootPos();
      const toward = ((op.x - p.x) * v.x + (op.z - p.z) * v.z) / (bestD + 1e-6);
      const track = this.huntTracks.get(c.id);
      if (toward > 0.8) {
        if (track && track.preyId === prey.id) {
          track.seconds += 0.1;
          if (track.seconds > HUNT_TRACK_SECONDS && this.time - track.lastEventTime > 30) {
            track.lastEventTime = this.time;
            this.pushEvent({
              tick: this.tick,
              kind: 'hunt',
              pos: p,
              actors: [c.id, prey.id],
              speciesId: c.speciesId,
              interest: 0.85,
            });
          }
        } else {
          this.huntTracks.set(c.id, { preyId: prey.id, seconds: 0, lastEventTime: track?.lastEventTime ?? -1e9 });
        }
      } else {
        this.huntTracks.delete(c.id);
      }
    }
  }

  private detectMigrations(): void {
    const sums = new Map<number, { x: number; z: number; n: number }>();
    for (const c of this.creatures.values()) {
      const s = sums.get(c.speciesId) ?? { x: 0, z: 0, n: 0 };
      const p = c.rootPos();
      s.x += p.x;
      s.z += p.z;
      s.n++;
      sums.set(c.speciesId, s);
    }
    for (const [id, s] of sums) {
      if (s.n < 5) continue;
      const cx = s.x / s.n;
      const cz = s.z / s.n;
      const prev = this.speciesCentroid.get(id);
      if (prev && this.time - prev.time < 45 && dist2d(cx, cz, prev.x, prev.z) > MIGRATION_DISTANCE) {
        const rec = this.species.get(id);
        this.pushEvent({
          tick: this.tick,
          kind: 'migration',
          pos: { x: cx, y: sampleHeight(this.terrain, cx, cz), z: cz },
          speciesId: id,
          data: { name: rec?.name ?? '?' },
          interest: 0.6,
        });
        this.speciesCentroid.set(id, { x: cx, z: cz, time: this.time });
      } else if (!prev || this.time - prev.time >= 45) {
        this.speciesCentroid.set(id, { x: cx, z: cz, time: this.time });
      }
    }
  }

  private detectMassExtinction(): void {
    const pop = this.creatures.size;
    this.popPeak = Math.max(this.popPeak * 0.9995, pop);
    if (this.popPeak > 40 && pop < this.popPeak * 0.45 && this.time - this.lastMassExtinctionTime > 120) {
      this.lastMassExtinctionTime = this.time;
      this.pushEvent({
        tick: this.tick,
        kind: 'massExtinction',
        data: { from: Math.round(this.popPeak), to: pop },
        interest: 0.95,
      });
      this.popPeak = pop;
    }
  }

  private lastSeason = -1;

  private seasonTickEvents(): void {
    const season = Math.floor(this.seasonPhase * 4) % 4;
    if (season !== this.lastSeason) {
      if (this.lastSeason !== -1) {
        this.pushEvent({ tick: this.tick, kind: 'seasonChange', data: { season }, interest: 0.3 });
      }
      this.lastSeason = season;
    }
  }

  // ------------------------------------------------------------- queries

  private computeStats(): void {
    const acc = new Map<number, { n: number; mass: number; herb: number; speed: number; brain: number; parts: number }>();
    for (const c of this.creatures.values()) {
      const a = acc.get(c.speciesId) ?? { n: 0, mass: 0, herb: 0, speed: 0, brain: 0, parts: 0 };
      const v = c.phys.bodies[0].linvel();
      a.n++;
      a.mass += c.plan.totalMass;
      a.herb += c.genome.organism.gutHerbivory;
      a.speed += Math.hypot(v.x, v.z);
      a.brain += c.genome.brain.nodes.length;
      a.parts += c.plan.parts.length;
      acc.set(c.speciesId, a);
    }
    const speciesStats: SpeciesStat[] = [];
    for (const [id, a] of acc) {
      const rec = this.species.get(id);
      if (!rec) continue;
      const traits: SpeciesTraits = {
        meanMass: a.mass / a.n,
        meanHerbivory: a.herb / a.n,
        meanSpeed: a.speed / a.n,
        meanBrainSize: a.brain / a.n,
        meanParts: a.parts / a.n,
      };
      this.species.updateTraits(id, traits);
      speciesStats.push({ id, name: rec.name, hue: rec.hue, count: a.n, meanHerbivory: traits.meanHerbivory });
    }
    speciesStats.sort((a, b) => b.count - a.count);

    // refresh species representatives occasionally so drift doesn't strand them
    if (this.tick % (STATS_INTERVAL_TICKS * 20) === 0) {
      for (const [id] of acc) {
        const member = [...this.creatures.values()].find((c) => c.speciesId === id);
        if (member) this.species.refreshRepresentative(id, member.genome);
      }
    }

    this.statsDirty = {
      tick: this.tick,
      time: this.time,
      day: Math.floor(this.time / DAY_LENGTH),
      season: Math.floor(this.seasonPhase * 4) % 4,
      year: Math.floor(this.time / YEAR_LENGTH),
      population: this.creatures.size,
      plantCount: this.eco.plantCount(),
      births: this.birthsTotal,
      deaths: this.deathsTotal,
      species: speciesStats,
      ledger: this.ledger.state(),
      tps: 0,
      climate: this.climateDrift,
    };
  }

  private sampleHistory(): void {
    this.histTicks.push(this.tick);
    const counts = new Map<number, number>();
    for (const c of this.creatures.values()) counts.set(c.speciesId, (counts.get(c.speciesId) ?? 0) + 1);
    for (const [id, arr] of this.histSpecies) arr.push(counts.get(id) ?? 0);
    for (const [id, n] of counts) {
      if (!this.histSpecies.has(id)) {
        const arr = new Array(this.histTicks.length - 1).fill(0);
        arr.push(n);
        this.histSpecies.set(id, arr);
      }
    }
    this.histPlant.push(this.eco.totalPlantBiomass());
    // cap history length
    if (this.histTicks.length > 1200) {
      this.histTicks.splice(0, 200);
      this.histPlant.splice(0, 200);
      for (const arr of this.histSpecies.values()) arr.splice(0, 200);
    }
  }

  history(): HistorySeries {
    const series = [];
    for (const [id, counts] of this.histSpecies) {
      const rec = this.species.get(id);
      if (!rec) continue;
      if (rec.extinctTick !== null && counts.every((c) => c === 0)) continue;
      series.push({ id, name: rec.name, hue: rec.hue, counts: [...counts] });
    }
    return { ticks: [...this.histTicks], series, plantBiomass: [...this.histPlant] };
  }

  phylo(): PhyloNode[] {
    return this.species.phylo();
  }

  detail(id: number): CreatureDetail | null {
    const c = this.creatures.get(id);
    if (!c) return null;
    const rec = this.species.get(c.speciesId);
    const values = c.brain.values();
    const nodes = c.brain.nodeIds.map((nid, i) => {
      const g = c.genome.brain.nodes.find((n) => n.id === nid);
      let label: string | undefined;
      if (g?.type === 'in') label = c.plan.inputLabels[nid];
      if (g?.type === 'out') label = c.plan.outputLabels[nid - OUT_BASE];
      return { id: nid, type: g?.type ?? 'hid', act: g?.act ?? 'tanh', value: values[i], label };
    });
    return {
      id: c.id,
      speciesId: c.speciesId,
      speciesName: rec?.name ?? '?',
      generation: c.generation,
      age: c.age,
      energy: c.energy,
      energyCapacity: c.capacity,
      health: c.health,
      mass: c.plan.totalMass,
      dietPlant: c.dietPlant,
      dietMeat: c.dietMeat,
      parents: c.parents,
      childCount: c.childCount,
      brain: {
        nodes,
        conns: c.genome.brain.conns.map((x) => ({ from: x.from, to: x.to, w: x.w, on: x.on })),
      },
      genome: c.genome,
    };
  }

  pick(origin: Vec3, dir: Vec3): number | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.phys.castRay(ray, 600, true);
    if (!hit) return null;
    return this.owners.get(hit.collider.handle)?.creature.id ?? null;
  }

  // ------------------------------------------------------------ snapshots

  encodeSnapshot(): Float32Array {
    let size = SNAP_HEADER;
    const list = [...this.creatures.values()];
    for (const c of list) size += 2 + c.plan.parts.length * PART_FLOATS;
    const buf = new Float32Array(size);
    buf[0] = this.time;
    buf[1] = list.length;
    buf[2] = this.sunAngle;
    buf[3] = this.seasonPhase;
    let k = SNAP_HEADER;
    for (const c of list) {
      buf[k++] = c.id;
      buf[k++] = c.plan.parts.length;
      for (const b of c.phys.bodies) {
        const t = b.translation();
        const r = b.rotation();
        buf[k++] = t.x;
        buf[k++] = t.y;
        buf[k++] = t.z;
        buf[k++] = r.x;
        buf[k++] = r.y;
        buf[k++] = r.z;
        buf[k++] = r.w;
      }
    }
    return buf;
  }

  encodePlants(): Float32Array {
    const alive = this.eco.plants.filter((p) => p.alive && p.biomass > 0.1);
    const buf = new Float32Array(PLANT_HEADER + alive.length * PLANT_FLOATS);
    buf[0] = alive.length;
    let k = PLANT_HEADER;
    for (const p of alive) {
      buf[k++] = p.x;
      buf[k++] = p.y;
      buf[k++] = p.z;
      buf[k++] = Math.min(1, p.biomass / 16);
      buf[k++] = p.phase;
      buf[k++] = (p.id % 17) / 17;
    }
    return buf;
  }
}

function clampW(v: number): number {
  const lim = TERRAIN_SIZE / 2 - 4;
  return Math.max(-lim, Math.min(lim, v));
}
