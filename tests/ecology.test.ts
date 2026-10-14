/**
 * Ecology module tests: ledger conservation under any op sequence, plant
 * growth gating (light, soil), decomposition accounting, smell gradients,
 * seeding/germination, and determinism.
 */
import { describe, expect, it } from 'vitest';
import type { TerrainData } from '../src/shared/types';
import {
  DECOMPOSE_LOSS,
  DT,
  MAX_PLANTS,
  PLANT_MAX_BIOMASS,
  SEED_DISPERSAL,
  SOIL_INITIAL_NUTRIENTS,
  TERRAIN_SIZE,
} from '../src/shared/constants';
import { RNG } from '../src/shared/rng';
import { Ledger } from '../src/sim/ecology/ledger';
import { Ecosystem, type Plant } from '../src/sim/ecology/plants';

/** Absolute tolerance: 1e-6 of the system's total energy scale. */
const TOL = 1e-6 * SOIL_INITIAL_NUTRIENTS;

/** Flat, uniformly fertile terrain: land everywhere (height > waterLevel). */
function flatTerrain(moisture = 0.7): TerrainData {
  const res = 32;
  const n = (res + 1) * (res + 1);
  return {
    heights: new Float32Array(n).fill(10),
    res,
    size: TERRAIN_SIZE,
    waterLevel: 4,
    moisture: new Float32Array(n).fill(moisture),
    fertility: new Float32Array(n).fill(1),
  };
}

/** Push an entity plant whose biomass is already credited to the plants pool. */
function pushPlant(eco: Ecosystem, id: number, x: number, z: number, biomass: number, phase: number): Plant {
  const p: Plant = { id, x, y: 10, z, biomass, alive: true, phase };
  eco.plants.push(p);
  return p;
}

function assertPoolsNonNegative(led: Ledger): void {
  const s = led.state();
  expect(s.soil).toBeGreaterThanOrEqual(0);
  expect(s.plants).toBeGreaterThanOrEqual(0);
  expect(s.seeds).toBeGreaterThanOrEqual(0);
  expect(s.creatures).toBeGreaterThanOrEqual(0);
  expect(s.corpses).toBeGreaterThanOrEqual(0);
}

describe('Ledger', () => {
  it('holds conservation exactly through a mixed op sequence', () => {
    const led = new Ledger();
    led.setInitial(1000);
    expect(led.conservationError()).toBe(0);

    expect(led.soilToPlants(300)).toBe(300);
    led.sunToPlants(50); // influx
    led.plantsToSeeds(40);
    led.seedsToPlants(10);
    led.seedsToSoil(30);
    expect(led.eatPlant(100, 0.6)).toBeCloseTo(60, 12);
    expect(led.biteCreature(20, 0.5)).toBeCloseTo(10, 12);
    led.creatureHeat(5);
    led.birthOverhead(3);
    led.creaturesToCorpse(30);
    led.corpseToSoil(30, DECOMPOSE_LOSS);
    led.creaturesToSoil(4);
    led.soilToCreatures(7);
    led.plantsToSoil(12);

    assertPoolsNonNegative(led);
    expect(led.conservationError()).toBeLessThan(1e-9 * 1000);
    expect(led.total()).toBeCloseTo(1000 + 50 - led.state().heatOut, 9);
  });

  it('clamps every mover so no pool goes negative, keeping books exact', () => {
    const led = new Ledger();
    led.setInitial(100);
    led.soilToPlants(1e9); // clamps to 100
    expect(led.state().soil).toBe(0);
    expect(led.state().plants).toBe(100);

    const net = led.eatPlant(1e9, 0.5); // clamps gross to 100
    expect(net).toBeCloseTo(50, 12);
    expect(led.state().plants).toBe(0);
    expect(led.state().creatures).toBeCloseTo(50, 12);
    expect(led.state().heatOut).toBeCloseTo(50, 12);

    led.creatureHeat(1e9); // clamps to 50; heatOut now 50 (digest) + 50 (burn)
    expect(led.state().creatures).toBe(0);
    expect(led.state().heatOut).toBeCloseTo(100, 12);
    led.creatureHeat(-5); // negative amounts move nothing
    led.sunToPlants(-5);
    expect(led.state().sunlightIn).toBe(0);
    led.eatCorpse(10, 0.9); // empty pool: nothing moves
    expect(led.state().creatures).toBe(0);
    led.biteCreature(10, 2); // eff clamps to 1: lossless, nothing burned
    expect(led.state().heatOut).toBeCloseTo(100, 12);

    assertPoolsNonNegative(led);
    expect(led.conservationError()).toBeLessThan(1e-9 * 100);
  });

  it('eaters return net absorbed; corpseToSoil splits loss exactly', () => {
    const led = new Ledger();
    led.setInitial(200);
    led.soilToPlants(200);
    expect(led.eatPlant(10, 0.7)).toBeCloseTo(7, 12);
    led.creaturesToCorpse(7);
    expect(led.eatCorpse(4, 0.25)).toBeCloseTo(1, 12);
    const before = led.state();
    led.corpseToSoil(3, 0.2);
    const after = led.state();
    expect(after.soil - before.soil).toBeCloseTo(2.4, 12);
    expect(after.heatOut - before.heatOut).toBeCloseTo(0.6, 12);
    expect(before.corpses - after.corpses).toBeCloseTo(3, 12);
    expect(led.conservationError()).toBeLessThan(1e-9 * 200);
  });
});

describe('Ecosystem', () => {
  it('initializes soil fertility-weighted and seeds plants zero-sum', () => {
    const led = new Ledger();
    const eco = new Ecosystem(flatTerrain(), new RNG(42), led);
    expect(led.state().soil).toBeCloseTo(SOIL_INITIAL_NUTRIENTS, 6);
    expect(led.total()).toBeCloseTo(SOIL_INITIAL_NUTRIENTS, 6);

    eco.seedInitial();
    const s = led.state();
    expect(eco.plantCount()).toBeGreaterThan(100);
    expect(s.plants).toBeGreaterThan(0);
    // zero-sum: biomass came out of soil, nothing created
    expect(s.soil + s.plants).toBeCloseTo(SOIL_INITIAL_NUTRIENTS, 6);
    expect(led.conservationError()).toBeLessThan(TOL);
    // entity biomass mirrors the ledger plants pool
    expect(Math.abs(eco.totalPlantBiomass() - s.plants)).toBeLessThan(TOL);
    for (const p of eco.plants) {
      expect(p.alive).toBe(true);
      expect(p.y).toBeGreaterThan(4); // above water on this flat terrain
    }
  });

  it('plants grow under light and do not without', () => {
    const ledA = new Ledger();
    const ecoA = new Ecosystem(flatTerrain(), new RNG(7), ledA);
    ecoA.seedInitial();
    const beforeA = ecoA.totalPlantBiomass();
    for (let i = 0; i < 300; i++) ecoA.step(DT, 1);
    expect(ecoA.totalPlantBiomass()).toBeGreaterThan(beforeA + 1);
    expect(ledA.state().sunlightIn).toBeGreaterThan(0);
    expect(ledA.conservationError()).toBeLessThan(TOL);

    const ledB = new Ledger();
    const ecoB = new Ecosystem(flatTerrain(), new RNG(7), ledB);
    ecoB.seedInitial();
    const beforeB = ecoB.totalPlantBiomass();
    for (let i = 0; i < 300; i++) ecoB.step(DT, 0);
    expect(ledB.state().sunlightIn).toBe(0);
    expect(ecoB.totalPlantBiomass()).toBeLessThanOrEqual(beforeB + 1e-9);
    expect(ledB.conservationError()).toBeLessThan(TOL);
  });

  it('growth stops when the soil cell is exhausted', () => {
    const led = new Ledger();
    const eco = new Ecosystem(flatTerrain(1.0), new RNG(3), led);
    // 25 plants packed into one soil cell (center ~31.875, cell spans 3.75 m);
    // entity biomass is test-local, which the ledger never sees, so
    // conservation still holds throughout
    const px = 31.875;
    const pz = 31.875;
    for (let i = 0; i < 25; i++) {
      pushPlant(eco, 900 + i, px + ((i % 5) - 2) * 0.5, pz + (Math.floor(i / 5) - 2) * 0.5, 0.5, i * 0.039);
    }

    const nutr0 = eco.nutrientsAt(px, pz);
    expect(nutr0).toBeGreaterThan(1);
    for (let i = 0; i < 3600; i++) eco.step(DT, 1);
    expect(eco.nutrientsAt(px, pz)).toBeLessThan(0.01);

    // all plants still have headroom, light is full — yet growth has stopped
    for (const p of eco.plants) expect(p.biomass).toBeLessThan(PLANT_MAX_BIOMASS * 0.5);
    const biomass0 = eco.totalPlantBiomass();
    const sun0 = led.state().sunlightIn;
    for (let i = 0; i < 120; i++) eco.step(DT, 1);
    expect(eco.totalPlantBiomass() - biomass0).toBeLessThan(0.01);
    expect(led.state().sunlightIn - sun0).toBeLessThan(0.01);
    expect(led.conservationError()).toBeLessThan(TOL);
    assertPoolsNonNegative(led);
  });

  it('decomposition returns exactly (1-DECOMPOSE_LOSS) of what decomposed to soil', () => {
    const led = new Ledger();
    const eco = new Ecosystem(flatTerrain(), new RNG(5), led);
    // move energy into the creatures pool through legitimate transfers
    led.soilToPlants(60);
    led.eatPlant(60, 1);
    led.creaturesToCorpse(40);
    eco.addCorpse(10, 10, 10, 40);
    led.creaturesToCorpse(0.025);
    eco.addCorpse(-20, -20, 10, 0.025); // tiny corpse: exercises the flush path

    const s0 = led.state();
    const nutr0 = eco.nutrientsAt(10, 10);
    for (let i = 0; i < 400; i++) eco.step(DT, 0);
    const s1 = led.state();
    const decomposed = s0.corpses - s1.corpses;
    expect(decomposed).toBeGreaterThan(5);
    expect(Math.abs(s1.soil - s0.soil - decomposed * (1 - DECOMPOSE_LOSS))).toBeLessThan(1e-9 * 100);
    expect(Math.abs(s1.heatOut - s0.heatOut - decomposed * DECOMPOSE_LOSS)).toBeLessThan(1e-9 * 100);
    // the local soil cell received the big corpse's share
    expect(eco.nutrientsAt(10, 10)).toBeGreaterThan(nutr0 + 5 * (1 - DECOMPOSE_LOSS));
    // tiny corpse fully flushed and removed; big one still decomposing
    expect(eco.corpses.length).toBe(1);
    expect(led.conservationError()).toBeLessThan(TOL);
  });

  it('grazing and scavenging transfer through the ledger; 0 when out of range', () => {
    const led = new Ledger();
    const eco = new Ecosystem(flatTerrain(), new RNG(11), led);
    led.soilToPlants(8);
    const plant = pushPlant(eco, 1000, 5, 5, 8, 0.5);
    eco.step(DT, 0); // index the plant

    expect(eco.grazeAt(100, 100, 1, 0.6)).toBe(0); // nothing there
    expect(eco.scavengeAt(5, 5, 1, 0.6)).toBe(0); // no corpse
    const net = eco.grazeAt(5.2, 5.1, 2, 0.6);
    expect(net).toBeCloseTo(1.2, 9);
    expect(plant.biomass).toBeCloseTo(6, 9);
    expect(led.state().creatures).toBeCloseTo(1.2, 9);

    led.creaturesToCorpse(1);
    eco.addCorpse(5, 5, 10, 1);
    const scav = eco.scavengeAt(5.3, 5.0, 0.5, 0.4);
    expect(scav).toBeCloseTo(0.2, 9);
    expect(led.conservationError()).toBeLessThan(TOL);
  });

  it('seeds, disperses within range, and germinates on fertile moist land', () => {
    const led = new Ledger();
    const eco = new Ecosystem(flatTerrain(0.9), new RNG(21), led);
    led.soilToPlants(45);
    const parents = [
      pushPlant(eco, 2000, -60, -60, 15, 0.1),
      pushPlant(eco, 2001, 0, 60, 15, 0.5),
      pushPlant(eco, 2002, 70, -20, 15, 0.8),
    ];
    let maxSeeds = 0;
    let seedsResolved = false;
    let prevSeeds = 0;
    for (let i = 0; i < 1700; i++) {
      eco.step(DT, 0); // light off: isolates the seeding mechanics
      const seeds = led.state().seeds;
      if (seeds > maxSeeds) maxSeeds = seeds;
      if (seeds < prevSeeds - 1e-12) seedsResolved = true;
      prevSeeds = seeds;
    }
    expect(maxSeeds).toBeGreaterThan(0);
    expect(seedsResolved).toBe(true);
    expect(eco.plantCount()).toBeGreaterThan(3); // at least one germination
    for (const p of eco.plants) {
      if (p.id >= 2000 || !p.alive) continue;
      const near = parents.some((q) => Math.hypot(p.x - q.x, p.z - q.z) <= SEED_DISPERSAL + 1e-6);
      expect(near).toBe(true); // offspring landed within dispersal range of a parent
    }
    expect(led.conservationError()).toBeLessThan(TOL);
    assertPoolsNonNegative(led);
  });

  it('smell gradients point toward a lone plant cluster and toward carrion', () => {
    const led = new Ledger();
    const eco = new Ecosystem(flatTerrain(), new RNG(13), led);
    led.soilToPlants(72);
    const cx = 20;
    const cz = -15;
    const rng = new RNG(99);
    for (let i = 0; i < 12; i++) {
      pushPlant(eco, 3000 + i, cx + rng.range(-2.5, 2.5), cz + rng.range(-2.5, 2.5), 6, rng.next());
    }
    led.soilToPlants(30);
    led.eatPlant(30, 1);
    led.creaturesToCorpse(30);
    eco.addCorpse(-30, 25, 10, 30);

    for (let i = 0; i < 100; i++) eco.step(DT, 0);

    const probes: [number, number][] = [
      [cx + 10, cz],
      [cx - 10, cz],
      [cx, cz + 10],
      [cx, cz - 12],
      [cx + 9, cz + 9],
    ];
    for (const [x, z] of probes) {
      const s = eco.smellPlant(x, z);
      expect(s.v).toBeGreaterThan(1e-4);
      expect(s.v).toBeLessThanOrEqual(1);
      expect(s.gx * (cx - x) + s.gz * (cz - z)).toBeGreaterThan(0); // uphill toward the cluster
    }
    expect(eco.smellPlant(cx, cz).v).toBeGreaterThan(eco.smellPlant(-90, 90).v);

    const sc = eco.smellCarrion(-30 + 8, 25 - 6);
    expect(sc.v).toBeGreaterThan(1e-5);
    expect(sc.gx * (-30 - (-30 + 8)) + sc.gz * (25 - (25 - 6))).toBeGreaterThan(0);
  });

  it('2000 chaotic steps: conservation, non-negative pools, entity/pool sync', () => {
    const led = new Ledger();
    const eco = new Ecosystem(flatTerrain(0.85), new RNG(2024), led);
    eco.seedInitial();
    // a few mature plants (ledger-backed) so seeding fires inside the window
    led.soilToPlants(60);
    pushPlant(eco, 5000, 12, 12, 15, 0.05);
    pushPlant(eco, 5001, -40, 8, 15, 0.35);
    pushPlant(eco, 5002, 30, -55, 15, 0.65);
    pushPlant(eco, 5003, -25, -30, 15, 0.95);

    const chaos = new RNG(777);
    let maxSeeds = 0;
    for (let i = 0; i < 2000; i++) {
      const light = 0.9 + 0.1 * Math.sin(i * 0.01);
      eco.step(DT, light);

      if (i % 3 === 0) {
        // graze near a random live plant
        const alive = eco.plants.filter((p) => p.alive && p.biomass > 0.2);
        if (alive.length > 0) {
          const t = alive[chaos.int(alive.length)];
          eco.grazeAt(t.x + chaos.range(-0.3, 0.3), t.z + chaos.range(-0.3, 0.3), chaos.range(0, 0.3), 0.55);
        }
      }
      if (i > 0 && i % 150 === 0) {
        // drop a corpse funded by whatever the creatures pool actually holds
        const before = led.state().creatures;
        led.creaturesToCorpse(Math.min(4, before));
        const moved = before - led.state().creatures;
        eco.addCorpse(chaos.range(-80, 80), chaos.range(-80, 80), 10, moved);
      }
      if (i % 100 === 0) {
        expect(led.conservationError()).toBeLessThan(TOL);
        assertPoolsNonNegative(led);
      }
      const seeds = led.state().seeds;
      if (seeds > maxSeeds) maxSeeds = seeds;
    }

    expect(maxSeeds).toBeGreaterThan(0); // seeding happened during the run
    expect(eco.plantCount()).toBeLessThanOrEqual(MAX_PLANTS);
    expect(led.conservationError()).toBeLessThan(TOL);
    assertPoolsNonNegative(led);
    const s = led.state();
    expect(Math.abs(eco.totalPlantBiomass() - s.plants)).toBeLessThan(TOL);
    const corpseSum = eco.corpses.reduce((a, c) => a + c.energy, 0);
    expect(Math.abs(corpseSum - s.corpses)).toBeLessThan(TOL);
  });

  it('is deterministic: same seed and op sequence give identical state', () => {
    const run = (): unknown => {
      const led = new Ledger();
      const eco = new Ecosystem(flatTerrain(0.8), new RNG(31415), led);
      eco.seedInitial();
      for (let i = 0; i < 400; i++) {
        eco.step(DT, 0.6 + 0.4 * Math.sin(i * 0.013));
        if (i % 5 === 0) {
          const alive = eco.plants.filter((p) => p.alive);
          const t = alive[(i * 7) % alive.length];
          eco.grazeAt(t.x + 0.1, t.z - 0.1, 0.2, 0.5);
        }
        if (i === 150) {
          const before = led.state().creatures;
          led.creaturesToCorpse(Math.min(2, before));
          eco.addCorpse(5, -5, 10, before - led.state().creatures);
        }
      }
      return {
        ledger: led.state(),
        count: eco.plantCount(),
        biomass: eco.totalPlantBiomass(),
        plants: eco.plants.slice(0, 60).map((p) => ({ id: p.id, x: p.x, z: p.z, b: p.biomass, a: p.alive })),
        corpses: eco.corpses.map((c) => c.energy),
        smellP: eco.smellPlant(0, 0),
        smellC: eco.smellCarrion(5, -5),
        nutr: eco.nutrientsAt(12, 12),
      };
    };
    expect(run()).toEqual(run());
  });
});
