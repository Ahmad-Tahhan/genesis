/**
 * Ecosystem: soil nutrient grid, plants, seeds, corpses and smell fields
 * (DECISIONS.md D5, D18, D22). Every energy transfer goes through the Ledger;
 * the module mirrors each ledger movement on its SOIL_GRID_RES^2 soil grid
 * with the exact same float amounts, so grid-sum and ledger soil pool stay in
 * sync and conservation holds for any call sequence.
 *
 * Terrain fields are sampled with a local bilinear sampler (this module must
 * not depend on the terrain generator): (res+1)^2 row-major arrays, index =
 * iz*(res+1)+ix, world x = (ix/res - 0.5)*size (y up, world centered on 0).
 */
import type { TerrainData } from '../../shared/types';
import { RNG } from '../../shared/rng';
import { Ledger } from './ledger';
import {
  BITE_RANGE,
  CARRION_SMELL_GAIN,
  DECOMPOSE_LOSS,
  DECOMPOSE_RATE,
  GERMINATION_MOISTURE,
  MAX_PLANTS,
  PLANT_GROWTH_RATE,
  PLANT_MAX_BIOMASS,
  PLANT_NUTRIENT_STOICH,
  PLANT_SEED_COST,
  PLANT_SEED_INTERVAL,
  PLANT_SEED_THRESHOLD,
  SEED_DISPERSAL,
  SOIL_GRID_RES,
  SOIL_INITIAL_NUTRIENTS,
} from '../../shared/constants';

/** A rooted plant. Position is fixed; biomass is its energy content (E). */
export interface Plant {
  id: number;
  x: number;
  y: number;
  z: number;
  biomass: number;
  alive: boolean;
  /** Stable per-plant random 0..1: desyncs seeding timers, feeds rendering sway. */
  phase: number;
}

/** A decomposing corpse; energy is what remains of the corpses-pool entry. */
export interface Corpse {
  x: number;
  y: number;
  z: number;
  energy: number;
}

/** A seed in flight/dormancy; packet energy lives in the ledger seeds pool. */
interface Seed {
  x: number;
  z: number;
  packet: number;
  born: number; // sim time at emission (s)
}

// --- module tunables (local by design: not part of the shared contract) ---
/** Plant dies at or below this biomass; the residue returns to soil. */
const DEATH_BIOMASS = 0.05;
/** Seeds germinate (or fail) this many sim-seconds after emission. */
const GERMINATION_DELAY = 6;
/** Local crowding cap: live plants per soil cell before germination fails. */
const MAX_PLANTS_PER_CELL = 5;
/** Michaelis-Menten half-saturation for nutrient gating (E per cell). */
const NUTRIENT_HALF_SAT = (SOIL_INITIAL_NUTRIENTS / (SOIL_GRID_RES * SOIL_GRID_RES)) * 0.5;
/** Smell field per-tick retention (diffuses via 3x3 blur each step). */
const SMELL_RETAIN = 0.985;
/** Smell source injection per tick (sources normalized to ~1 per full plant). */
const SMELL_INJECT = 0.12;
/** Carrion smell normalization (E of corpse that reads as source strength 1). */
const CARRION_NORM = 24;
/** Wind rotates slowly; jitter keeps dispersal direction drifting. */
const WIND_ROT_RATE = 0.03; // rad/s
const WIND_JITTER = 0.25; // rad/s uniform jitter amplitude
/** Target initial plant count for seedInitial(). */
const INITIAL_PLANTS = Math.floor(MAX_PLANTS * 0.75);
/** Remaining corpse energy below which the last fragment is flushed to soil. */
const CORPSE_EPS = 0.02;

/**
 * Bilinear sample of a (res+1)^2 row-major vertex field at world (x,z).
 * Clamps to the field edge outside the world.
 */
function sampleBilinear(
  field: Float32Array,
  res: number,
  size: number,
  x: number,
  z: number,
): number {
  const fx = Math.min(res, Math.max(0, (x / size + 0.5) * res));
  const fz = Math.min(res, Math.max(0, (z / size + 0.5) * res));
  const x0 = Math.min(res - 1, Math.floor(fx));
  const z0 = Math.min(res - 1, Math.floor(fz));
  const tx = fx - x0;
  const tz = fz - z0;
  const w = res + 1;
  const a = field[z0 * w + x0];
  const b = field[z0 * w + x0 + 1];
  const c = field[(z0 + 1) * w + x0];
  const d = field[(z0 + 1) * w + x0 + 1];
  return a + (b - a) * tx + (c - a + (a - b + d - c) * tx) * tz;
}

/**
 * Plants, soil, seeds, corpses and smell. All randomness comes from the RNG
 * passed to the constructor; same seed + same call sequence => identical state.
 */
export class Ecosystem {
  /** All plant entities, dead entries included until compaction (snapshots filter on alive). */
  plants: Plant[] = [];
  /** Active corpses; entries are removed in-place once fully decomposed. */
  corpses: Corpse[] = [];

  private readonly terrain: TerrainData;
  private readonly rng: RNG;
  private readonly ledger: Ledger;
  private readonly res = SOIL_GRID_RES;
  private readonly cellSize: number;
  private readonly half: number;
  /** Soil nutrients per cell (E); grid-sum mirrors the ledger soil pool. */
  private readonly cells: Float64Array;
  private readonly smellP: Float64Array;
  private readonly smellC: Float64Array;
  private readonly smellScratch: Float64Array;
  private readonly smellSrc: Float64Array;
  /** Live-plant indices per cell, rebuilt by rebuildIndex(). */
  private readonly bucket: number[][];
  private readonly cellPlantCount: Uint16Array;
  private liveCount = 0;
  private seedsInFlight: Seed[] = [];
  private time = 0;
  private windAngle: number;
  private nextId = 1;
  private indexDirty = true;

  /**
   * Builds the soil grid by distributing SOIL_INITIAL_NUTRIENTS over cells
   * weighted by terrain fertility (uniform if fertility sums to zero), then
   * registers the exact grid total as the ledger's initial energy baseline.
   */
  constructor(terrain: TerrainData, rng: RNG, ledger: Ledger) {
    this.terrain = terrain;
    this.rng = rng;
    this.ledger = ledger;
    this.cellSize = terrain.size / this.res;
    this.half = terrain.size / 2;
    const n = this.res * this.res;
    this.cells = new Float64Array(n);
    this.smellP = new Float64Array(n);
    this.smellC = new Float64Array(n);
    this.smellScratch = new Float64Array(n);
    this.smellSrc = new Float64Array(n);
    this.bucket = Array.from({ length: n }, () => []);
    this.cellPlantCount = new Uint16Array(n);

    const weights = new Float64Array(n);
    let wsum = 0;
    for (let iz = 0; iz < this.res; iz++) {
      for (let ix = 0; ix < this.res; ix++) {
        const w = Math.max(0, this.fertilityAt(this.cellX(ix), this.cellZ(iz)));
        weights[iz * this.res + ix] = w;
        wsum += w;
      }
    }
    let total = 0;
    for (let i = 0; i < n; i++) {
      this.cells[i] = wsum > 0 ? (SOIL_INITIAL_NUTRIENTS * weights[i]) / wsum : SOIL_INITIAL_NUTRIENTS / n;
      total += this.cells[i];
    }
    ledger.setInitial(total);
    this.windAngle = rng.range(0, Math.PI * 2);
  }

  // ----------------------------------------------------- terrain sampling

  private heightAt(x: number, z: number): number {
    return sampleBilinear(this.terrain.heights, this.terrain.res, this.terrain.size, x, z);
  }

  private moistureAt(x: number, z: number): number {
    return sampleBilinear(this.terrain.moisture, this.terrain.res, this.terrain.size, x, z);
  }

  private fertilityAt(x: number, z: number): number {
    return sampleBilinear(this.terrain.fertility, this.terrain.res, this.terrain.size, x, z);
  }

  // ----------------------------------------------------------- soil grid

  private cellX(ix: number): number {
    return ((ix + 0.5) / this.res - 0.5) * this.terrain.size;
  }

  private cellZ(iz: number): number {
    return ((iz + 0.5) / this.res - 0.5) * this.terrain.size;
  }

  private cellIndex(x: number, z: number): number {
    const ix = Math.min(this.res - 1, Math.max(0, Math.floor((x / this.terrain.size + 0.5) * this.res)));
    const iz = Math.min(this.res - 1, Math.max(0, Math.floor((z / this.terrain.size + 0.5) * this.res)));
    return iz * this.res + ix;
  }

  /** Soil nutrients (E) in the cell containing (x,z). */
  nutrientsAt(x: number, z: number): number {
    return this.cells[this.cellIndex(x, z)];
  }

  /** Sum of the soil grid (must mirror the ledger's soil pool exactly). */
  soilTotal(): number {
    let t = 0;
    for (let i = 0; i < this.cells.length; i++) t += this.cells[i];
    return t;
  }

  /**
   * Withdraws up to `want` E of soil for a creature spawn (founders/rescues,
   * DECISIONS.md D23), debiting the grid proportionally across cells and the
   * ledger soil->creatures pool by the identical amount. Returns the E moved.
   */
  drawSoilForSpawn(want: number): number {
    if (want <= 0) return 0;
    const total = this.soilTotal();
    if (total < want) return 0; // all-or-nothing: no partial spawns
    const moved = this.ledger.soilToCreatures(want);
    if (moved < want - 1e-9) {
      // ledger clamped below what the grid holds (mirror drift): refund and
      // report failure rather than desync the mirror further
      this.ledger.creaturesToSoil(moved);
      return 0;
    }
    const frac = moved / total;
    for (let i = 0; i < this.cells.length; i++) this.cells[i] -= this.cells[i] * frac;
    return moved;
  }

  /**
   * Draws up to `want` E from a soil cell into the plants pool (zero-sum:
   * the grid cell and ledger soil drop by the identical moved amount).
   */
  private drawSoil(ci: number, want: number): number {
    const req = Math.min(Math.max(0, want), this.cells[ci]);
    if (req <= 0) return 0;
    const moved = this.ledger.soilToPlants(req);
    this.cells[ci] = Math.max(0, this.cells[ci] - moved);
    return moved;
  }

  // ------------------------------------------------------------ indexing

  /** Rebuild per-cell buckets, counts and liveCount from the plants array. */
  private rebuildIndex(): void {
    for (const b of this.bucket) b.length = 0;
    this.cellPlantCount.fill(0);
    this.liveCount = 0;
    for (let i = 0; i < this.plants.length; i++) {
      const p = this.plants[i];
      if (!p.alive) continue;
      const ci = this.cellIndex(p.x, p.z);
      this.bucket[ci].push(i);
      this.cellPlantCount[ci]++;
      this.liveCount++;
    }
    this.indexDirty = false;
  }

  /** Drop dead entries in place (array identity preserved for snapshot code). */
  private compact(): void {
    let w = 0;
    for (let i = 0; i < this.plants.length; i++) {
      if (this.plants[i].alive) this.plants[w++] = this.plants[i];
    }
    this.plants.length = w;
    this.indexDirty = true;
  }

  private spawnPlant(x: number, y: number, z: number, biomass: number): void {
    this.plants.push({ id: this.nextId++, x, y, z, biomass, alive: true, phase: this.rng.next() });
    const ci = this.cellIndex(x, z);
    this.cellPlantCount[ci]++;
    this.liveCount++;
    this.indexDirty = true;
  }

  private killPlant(p: Plant, ci: number): void {
    const residue = p.biomass;
    if (residue > 0) {
      this.ledger.plantsToSoil(residue);
      this.cells[ci] += residue;
    }
    p.biomass = 0;
    p.alive = false;
    if (this.cellPlantCount[ci] > 0) this.cellPlantCount[ci]--;
    this.liveCount--;
    this.indexDirty = true;
  }

  // ------------------------------------------------------------- seeding

  /**
   * Scatters the initial flora on fertile land (above water, moisture >=
   * GERMINATION_MOISTURE), drawing each plant's starting biomass from its
   * soil cell through the ledger (zero-sum; no energy is invented).
   */
  seedInitial(): void {
    const target = INITIAL_PLANTS;
    let made = 0;
    for (let attempt = 0; attempt < target * 12 && made < target; attempt++) {
      const x = this.rng.range(-this.half, this.half);
      const z = this.rng.range(-this.half, this.half);
      const h = this.heightAt(x, z);
      if (h <= this.terrain.waterLevel) continue;
      if (this.moistureAt(x, z) < GERMINATION_MOISTURE) continue;
      const ci = this.cellIndex(x, z);
      if (this.cellPlantCount[ci] >= MAX_PLANTS_PER_CELL) continue;
      // cap the draw at 40% of the cell so bootstrap never exhausts the soil
      const want = Math.min(this.rng.range(0.2, 0.5) * PLANT_MAX_BIOMASS, this.cells[ci] * 0.4);
      const moved = this.drawSoil(ci, want);
      if (moved <= DEATH_BIOMASS) {
        // too small to live: put it straight back, books stay closed
        this.ledger.plantsToSoil(moved);
        this.cells[ci] += moved;
        continue;
      }
      this.spawnPlant(x, h, z, moved);
      made++;
    }
    this.rebuildIndex();
  }

  /** True when this plant's phase-shifted seeding timer crossed an interval edge this tick. */
  private seedTimerFired(phase: number, dt: number): boolean {
    const shift = phase * PLANT_SEED_INTERVAL;
    const prev = Math.floor((this.time - dt + shift) / PLANT_SEED_INTERVAL);
    const now = Math.floor((this.time + shift) / PLANT_SEED_INTERVAL);
    return now > prev;
  }

  // ---------------------------------------------------------------- step

  /**
   * One sim tick. `light` in 0..1 (sun * season * climate). Order: growth +
   * seeding + deaths, then germination, corpse decomposition, smell diffusion.
   * Call once per tick with a fixed dt for deterministic results.
   */
  step(dt: number, light: number): void {
    if (this.plants.length > 512 && this.plants.length > this.liveCount * 2) this.compact();
    this.rebuildIndex(); // unconditional: picks up external changes to `plants`
    this.time += dt;
    this.windAngle += (WIND_ROT_RATE + WIND_JITTER * (this.rng.next() * 2 - 1)) * dt;
    const sun = Math.min(1, Math.max(0, light));
    const seedBiomass = PLANT_SEED_THRESHOLD * PLANT_MAX_BIOMASS;

    for (let i = 0; i < this.plants.length; i++) {
      const p = this.plants[i];
      if (!p.alive) continue;
      const ci = this.cellIndex(p.x, p.z);

      // photosynthesis, gated by light, moisture and soil nutrients; the
      // soil draw (dE * stoichiometry) joins the biomass, so total gain is
      // dE*(1+stoich) and must fit under PLANT_MAX_BIOMASS
      if (sun > 0) {
        const nutr = this.cells[ci];
        const gate = nutr / (nutr + NUTRIENT_HALF_SAT);
        let dE = PLANT_GROWTH_RATE * sun * this.moistureAt(p.x, p.z) * gate * dt;
        const headroom = PLANT_MAX_BIOMASS - p.biomass;
        dE = Math.min(dE, Math.max(0, headroom) / (1 + PLANT_NUTRIENT_STOICH));
        dE = Math.min(dE, nutr / PLANT_NUTRIENT_STOICH); // hard stop on an exhausted cell
        if (dE > 0) {
          const moved = this.drawSoil(ci, dE * PLANT_NUTRIENT_STOICH);
          this.ledger.sunToPlants(dE);
          p.biomass += dE + moved;
        }
      }

      // seeding (D18): above the biomass threshold, spend a seed packet on a
      // per-plant interval timer; dispersal follows the drifting wind
      if (p.biomass >= seedBiomass && this.seedTimerFired(p.phase, dt)) {
        const cost = Math.min(PLANT_SEED_COST, p.biomass);
        p.biomass -= cost;
        this.ledger.plantsToSeeds(cost);
        const dist = SEED_DISPERSAL * (0.25 + 0.75 * this.rng.next());
        const ang = this.windAngle + this.rng.gaussian(0, 0.45);
        const sx = Math.min(this.half, Math.max(-this.half, p.x + Math.cos(ang) * dist));
        const sz = Math.min(this.half, Math.max(-this.half, p.z + Math.sin(ang) * dist));
        this.seedsInFlight.push({ x: sx, z: sz, packet: cost, born: this.time });
      }

      if (p.biomass <= DEATH_BIOMASS) this.killPlant(p, ci);
    }

    // germination after a dormancy delay; a seed either becomes a plant or
    // decays into the soil cell where it landed (ledger seeds -> soil)
    if (this.seedsInFlight.length > 0) {
      const keep: Seed[] = [];
      for (const s of this.seedsInFlight) {
        if (this.time - s.born < GERMINATION_DELAY) {
          keep.push(s);
          continue;
        }
        const ci = this.cellIndex(s.x, s.z);
        const h = this.heightAt(s.x, s.z);
        const ok =
          h > this.terrain.waterLevel &&
          this.moistureAt(s.x, s.z) >= GERMINATION_MOISTURE &&
          this.liveCount < MAX_PLANTS &&
          this.cellPlantCount[ci] < MAX_PLANTS_PER_CELL &&
          s.packet > DEATH_BIOMASS;
        if (ok) {
          this.ledger.seedsToPlants(s.packet);
          this.spawnPlant(s.x, h, s.z, s.packet);
        } else {
          this.ledger.seedsToSoil(s.packet);
          this.cells[ci] += s.packet;
        }
      }
      this.seedsInFlight = keep;
    }

    // corpse decomposition: DECOMPOSE_RATE fraction/s into the local soil
    // cell, DECOMPOSE_LOSS of it as heat; tiny remainders are flushed
    let removedCorpse = false;
    for (const c of this.corpses) {
      if (c.energy <= 0) {
        removedCorpse = true;
        continue;
      }
      let gross = c.energy * Math.min(1, DECOMPOSE_RATE * dt);
      if (c.energy - gross <= CORPSE_EPS) gross = c.energy;
      if (gross > 0) {
        const loss = gross * DECOMPOSE_LOSS;
        this.ledger.corpseToSoil(gross, DECOMPOSE_LOSS);
        this.cells[this.cellIndex(c.x, c.z)] += gross - loss; // identical float as the ledger's soil credit
        c.energy -= gross;
      }
      if (c.energy <= 0) removedCorpse = true;
    }
    if (removedCorpse) {
      let w = 0;
      for (let i = 0; i < this.corpses.length; i++) {
        if (this.corpses[i].energy > 0) this.corpses[w++] = this.corpses[i];
      }
      this.corpses.length = w;
    }

    this.updateSmell();
  }

  // ------------------------------------------------------------- feeding

  /**
   * Graze the nearest live plant within BITE_RANGE*2 of (x,z): removes up to
   * `wanted` biomass (gross) and routes it through ledger.eatPlant. Returns
   * net energy absorbed, 0 when no plant is in range.
   */
  grazeAt(x: number, z: number, wanted: number, eff: number): number {
    if (this.indexDirty) this.rebuildIndex();
    const p = this.nearestPlant(x, z, BITE_RANGE * 2);
    if (!p || wanted <= 0) return 0;
    const gross = Math.min(wanted, p.biomass);
    if (gross <= 0) return 0;
    p.biomass -= gross;
    return this.ledger.eatPlant(gross, eff);
  }

  private nearestPlant(x: number, z: number, range: number): Plant | null {
    const r2 = range * range;
    const cx = Math.min(this.res - 1, Math.max(0, Math.floor((x / this.terrain.size + 0.5) * this.res)));
    const cz = Math.min(this.res - 1, Math.max(0, Math.floor((z / this.terrain.size + 0.5) * this.res)));
    let best: Plant | null = null;
    let bestD = r2;
    // cellSize >> range, so the 3x3 neighborhood always covers the bite circle
    for (let iz = Math.max(0, cz - 1); iz <= Math.min(this.res - 1, cz + 1); iz++) {
      for (let ix = Math.max(0, cx - 1); ix <= Math.min(this.res - 1, cx + 1); ix++) {
        for (const pi of this.bucket[iz * this.res + ix]) {
          const p = this.plants[pi];
          if (!p.alive || p.biomass <= 0) continue;
          const dx = p.x - x;
          const dz = p.z - z;
          const d = dx * dx + dz * dz;
          if (d <= bestD) {
            bestD = d;
            best = p;
          }
        }
      }
    }
    return best;
  }

  /**
   * Registers a corpse entity. The energy must already have been moved into
   * the corpses pool by the caller (ledger.creaturesToCorpse); this method
   * does no ledger accounting itself. Note the (x, z, y) argument order.
   */
  addCorpse(x: number, z: number, y: number, energy: number): void {
    if (energy <= 0) return;
    this.corpses.push({ x, y, z, energy });
  }

  /**
   * Scavenge the nearest corpse within BITE_RANGE*2: removes up to `wanted`
   * (gross) from it and routes it through ledger.eatCorpse. Returns net
   * absorbed, 0 when no corpse is in range.
   */
  scavengeAt(x: number, z: number, wanted: number, eff: number): number {
    if (wanted <= 0) return 0;
    const r2 = BITE_RANGE * 2 * (BITE_RANGE * 2);
    let best: Corpse | null = null;
    let bestD = r2;
    for (const c of this.corpses) {
      if (c.energy <= 0) continue;
      const dx = c.x - x;
      const dz = c.z - z;
      const d = dx * dx + dz * dz;
      if (d <= bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) return 0;
    const gross = Math.min(wanted, best.energy);
    if (gross <= 0) return 0;
    best.energy -= gross;
    return this.ledger.eatCorpse(gross, eff);
  }

  // --------------------------------------------------------------- smell

  /**
   * Diffuse both smell fields one tick: sources (plant biomass / corpse
   * energy, normalized) are injected, the field is 3x3-blurred and decayed,
   * and values clamp to 0..1 (D22: the same fields double as event hints).
   */
  private updateSmell(): void {
    this.smellSrc.fill(0);
    for (const p of this.plants) {
      if (p.alive && p.biomass > 0) this.smellSrc[this.cellIndex(p.x, p.z)] += p.biomass / PLANT_MAX_BIOMASS;
    }
    this.diffuse(this.smellP);
    this.smellSrc.fill(0);
    for (const c of this.corpses) {
      if (c.energy > 0) this.smellSrc[this.cellIndex(c.x, c.z)] += (c.energy * CARRION_SMELL_GAIN) / CARRION_NORM;
    }
    this.diffuse(this.smellC);
  }

  /** field = clamp(blur3x3(field)*RETAIN + src*INJECT, 0, 1), edge-clamped kernel. */
  private diffuse(field: Float64Array): void {
    const r = this.res;
    const out = this.smellScratch;
    for (let iz = 0; iz < r; iz++) {
      const zm = Math.max(0, iz - 1) * r;
      const z0 = iz * r;
      const zp = Math.min(r - 1, iz + 1) * r;
      for (let ix = 0; ix < r; ix++) {
        const xm = Math.max(0, ix - 1);
        const xp = Math.min(r - 1, ix + 1);
        const blur =
          (field[zm + xm] + field[zm + xp] + field[zp + xm] + field[zp + xp]) * 0.0625 +
          (field[zm + ix] + field[zp + ix] + field[z0 + xm] + field[z0 + xp]) * 0.125 +
          field[z0 + ix] * 0.25;
        const v = blur * SMELL_RETAIN + this.smellSrc[z0 + ix] * SMELL_INJECT;
        out[z0 + ix] = v > 1 ? 1 : v;
      }
    }
    field.set(out);
  }

  /** Bilinear sample of a cell-centered smell field at world (x,z). */
  private sampleSmell(field: Float64Array, x: number, z: number): number {
    const fx = Math.min(this.res - 1, Math.max(0, (x / this.terrain.size + 0.5) * this.res - 0.5));
    const fz = Math.min(this.res - 1, Math.max(0, (z / this.terrain.size + 0.5) * this.res - 0.5));
    const x0 = Math.min(this.res - 2, Math.floor(fx));
    const z0 = Math.min(this.res - 2, Math.floor(fz));
    const tx = fx - x0;
    const tz = fz - z0;
    const a = field[z0 * this.res + x0];
    const b = field[z0 * this.res + x0 + 1];
    const c = field[(z0 + 1) * this.res + x0];
    const d = field[(z0 + 1) * this.res + x0 + 1];
    return a + (b - a) * tx + (c - a + (a - b + d - c) * tx) * tz;
  }

  private smellAt(field: Float64Array, x: number, z: number): { v: number; gx: number; gz: number } {
    const h = this.cellSize;
    const v = this.sampleSmell(field, x, z);
    const gx = (this.sampleSmell(field, x + h, z) - this.sampleSmell(field, x - h, z)) / (2 * h);
    const gz = (this.sampleSmell(field, x, z + h) - this.sampleSmell(field, x, z - h)) / (2 * h);
    return { v, gx, gz };
  }

  /** Plant smell: intensity ~0..1 and world-space gradient (points uphill, toward plants). */
  smellPlant(x: number, z: number): { v: number; gx: number; gz: number } {
    return this.smellAt(this.smellP, x, z);
  }

  /** Carrion smell: intensity ~0..1 and world-space gradient (points toward corpses). */
  smellCarrion(x: number, z: number): { v: number; gx: number; gz: number } {
    return this.smellAt(this.smellC, x, z);
  }

  // --------------------------------------------------------------- stats

  /** Number of live plants (as of the last index rebuild plus internal changes). */
  plantCount(): number {
    if (this.indexDirty) this.rebuildIndex();
    return this.liveCount;
  }

  /** Sum of live plant biomass (E); mirrors the ledger plants pool. */
  totalPlantBiomass(): number {
    let sum = 0;
    for (const p of this.plants) if (p.alive) sum += p.biomass;
    return sum;
  }
}
