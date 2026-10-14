/**
 * Science validation (PLAN.md M5):
 *  1. Energy conservation: sunlight_in − heat_out = Δ(stored) across a long
 *     full-simulation run with births, deaths, eating and decomposition.
 *  2. Kleiber's law: basal metabolic spend scales with mass^0.75.
 *  3. Selection response: directional selection shifts heritable trait means
 *     (an organism gene, and an evolved brain behaviour).
 *  4. Determinism: same seed ⇒ bit-identical world trajectories.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CREATURE_MAX_HEALTH,
  DT,
  KLEIBER_COEFF,
  MAX_PART_DIM,
  MIN_PART_DIM,
} from '../src/shared/constants';
import type { BodyGene, Genome, OrganismGenes } from '../src/shared/types';
import { RNG } from '../src/shared/rng';
import { World } from '../src/sim/world';
import { Creature } from '../src/sim/creature';
import { Ledger } from '../src/sim/ecology/ledger';
import { develop } from '../src/sim/genome/development';
import { InnovationTracker, Network, createBrain, crossoverBrain, mutateBrain } from '../src/sim/genome/brain';
import { mutateGenome, randomGenome } from '../src/sim/genome';
import { initRapier } from '../src/sim/physics';
import type { CreaturePhysics } from '../src/sim/physics';

beforeAll(async () => {
  await initRapier();
});

// ---------------------------------------------------------------- helpers

function makeGene(id: number, parent: number, dim: number): BodyGene {
  const d = Math.max(MIN_PART_DIM, Math.min(MAX_PART_DIM, dim));
  return {
    id,
    parent,
    shape: 'box',
    size: { x: d, y: d, z: d },
    density: 1,
    anchor: { x: 0, y: -1, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    jointAxis: { x: 1, y: 0, z: 0 },
    jointLimits: [-1, 1],
    muscle: 0.5,
    recursion: 0,
    mirror: false,
    eyes: 0,
    eyeDir: { x: 0, y: 0, z: 1 },
    smell: false,
    mouth: parent === -1,
    color: [0.3, 0.5, 0.5],
    patternFreq: 3,
    patternAmp: 0.4,
  };
}

function makeCreature(dim: number, id: number, tracker: InnovationTracker, rng: RNG): Creature {
  const body = [makeGene(1, -1, dim), makeGene(2, 1, dim)];
  const organism: OrganismGenes = { gutHerbivory: 0.8, sexual: 0, offspringEnergyFrac: 0.3, sizeScale: 1 };
  const plan = develop(body, organism);
  expect(plan.viable).toBe(true);
  const brain = createBrain(plan.numInputs, plan.numOutputs, rng, tracker);
  const genome: Genome = { body, organism, brain, generation: 0 };
  // metabolize() never touches physics — a stub is fine for the scaling law
  const phys = { bodies: [], joints: [], colliders: [] } as unknown as CreaturePhysics;
  return new Creature(id, genome, plan, phys, plan.totalMass * 9 * 0.5, []);
}

// ------------------------------------------------------- 1. conservation

describe('energy conservation', () => {
  it('sunlight_in − heat_out equals Δstored over a 3000-tick ecosystem run', async () => {
    const w = new World();
    await w.init(1234);
    const l0 = w.ledger.state();
    const total0 = w.ledger.total();
    expect(total0).toBeGreaterThan(0);

    for (let i = 0; i < 3000; i++) w.step();

    const l1 = w.ledger.state();
    const err = w.ledger.conservationError();
    const scale = Math.max(1, l1.sunlightIn + total0);
    expect(err / scale).toBeLessThan(1e-6);

    // pools stay physical
    expect(l1.soil).toBeGreaterThanOrEqual(0);
    expect(l1.plants).toBeGreaterThanOrEqual(0);
    expect(l1.seeds).toBeGreaterThanOrEqual(0);
    expect(l1.creatures).toBeGreaterThanOrEqual(0);
    expect(l1.corpses).toBeGreaterThanOrEqual(0);
    // the run actually exercised the cycle
    expect(l1.sunlightIn).toBeGreaterThan(l0.sunlightIn);
    expect(l1.heatOut).toBeGreaterThan(0);
    expect(w.birthsTotal + w.deathsTotal).toBeGreaterThan(0);
  });

  it('ledger movers clamp without leaking energy', () => {
    const l = new Ledger();
    l.setInitial(100);
    l.soilToPlants(60);
    l.eatPlant(30, 0.6); // 12 heat, 18 creatures
    l.creatureHeat(5);
    l.creaturesToCorpse(13);
    l.corpseToSoil(13, 0.2);
    l.soilToPlants(1e9); // over-ask must clamp
    expect(l.conservationError()).toBeLessThan(1e-9);
    const s = l.state();
    expect(s.soil).toBeGreaterThanOrEqual(0);
    expect(s.plants).toBeGreaterThanOrEqual(0);
  });
});

// ------------------------------------------------------------ 2. Kleiber

describe("Kleiber's law", () => {
  it('basal spend scales as mass^0.75', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(7);
    const small = makeCreature(0.12, 1, tracker, rng);
    const big = makeCreature(0.48, 2, tracker, rng);
    const massRatio = big.plan.totalMass / small.plan.totalMass;
    expect(massRatio).toBeGreaterThan(8); // distinctly different masses

    const ledger = new Ledger();
    ledger.setInitial(0);
    // brains are identical topology; isolate basal by subtracting brain cost:
    const spend = (c: Creature): number => {
      const before = c.energy;
      c.metabolize(0, 0, ledger);
      return before - c.energy;
    };
    const sSmall = spend(small);
    const sBig = spend(big);
    const brainCost = brainSpendOf(small) * DT;
    const basalSmall = sSmall - brainCost;
    const basalBig = sBig - brainCost;
    const expected = Math.pow(massRatio, 0.75);
    expect(basalBig / basalSmall).toBeGreaterThan(expected * 0.95);
    expect(basalBig / basalSmall).toBeLessThan(expected * 1.05);
    // absolute value matches the coefficient
    expect(basalSmall).toBeCloseTo(KLEIBER_COEFF * Math.pow(small.plan.totalMass, 0.75) * DT, 8);
  });
});

function brainSpendOf(c: Creature): number {
  // mirror of creature.ts brain-cost formula, kept in sync by this test's role
  const nodes = c.genome.brain.nodes.length;
  const conns = c.genome.brain.conns.filter((x) => x.on).length;
  return nodes * 0.00022 + conns * 0.00006;
}

// -------------------------------------------------- 3. selection response

describe('selection pressure changes trait means', () => {
  it('selecting for carnivory drives mean gutHerbivory down across generations', () => {
    const rng = new RNG(42);
    const tracker = new InnovationTracker();
    let geneId = 1;
    const nextGeneId = () => geneId++;

    let pop = Array.from({ length: 48 }, () => randomGenome(rng, tracker, nextGeneId).genome);
    const mean = (gs: Genome[]) => gs.reduce((s, g) => s + g.organism.gutHerbivory, 0) / gs.length;
    const m0 = mean(pop);

    for (let gen = 0; gen < 30; gen++) {
      // fitness = carnivory; truncation selection, asexual reproduction
      pop.sort((a, b) => a.organism.gutHerbivory - b.organism.gutHerbivory);
      const parents = pop.slice(0, 16);
      pop = parents.flatMap((p) => [
        mutateGenome(p, rng, tracker, nextGeneId).genome,
        mutateGenome(p, rng, tracker, nextGeneId).genome,
        mutateGenome(p, rng, tracker, nextGeneId).genome,
      ]);
    }
    const m1 = mean(pop);
    expect(m0).toBeGreaterThan(0.4); // founders are herbivore-biased
    expect(m1).toBeLessThan(m0 - 0.2); // selection moved the mean substantially
  });

  it('a control without selection drifts far less than the selected line', () => {
    const rng = new RNG(43);
    const tracker = new InnovationTracker();
    let geneId = 1;
    const nextGeneId = () => geneId++;
    let pop = Array.from({ length: 48 }, () => randomGenome(rng, tracker, nextGeneId).genome);
    const mean = (gs: Genome[]) => gs.reduce((s, g) => s + g.organism.gutHerbivory, 0) / gs.length;
    const m0 = mean(pop);
    for (let gen = 0; gen < 30; gen++) {
      const parents = Array.from({ length: 16 }, () => pop[rng.int(pop.length)]);
      pop = parents.flatMap((p) => [
        mutateGenome(p, rng, tracker, nextGeneId).genome,
        mutateGenome(p, rng, tracker, nextGeneId).genome,
        mutateGenome(p, rng, tracker, nextGeneId).genome,
      ]);
    }
    expect(Math.abs(mean(pop) - m0)).toBeLessThan(0.15);
  });

  it('brains evolve a stimulus-response under selection (NEAT works end to end)', () => {
    const rng = new RNG(99);
    const tracker = new InnovationTracker();
    const N_IN = 3;
    const N_OUT = 1;

    const fitness = (g: Genome['brain']): number => {
      const net = new Network(g, N_IN, N_OUT);
      const respond = (x: number): number => {
        for (let i = 0; i < N_IN; i++) net.setInput(i, 0);
        net.setInput(0, x);
        for (let s = 0; s < 6; s++) net.step();
        return net.getOutput(0);
      };
      return respond(1) - respond(0); // reward reacting to input 0
    };

    let pop = Array.from({ length: 40 }, () => createBrain(N_IN, N_OUT, rng, tracker));
    const meanFit = (ps: typeof pop) => ps.reduce((s, b) => s + fitness(b), 0) / ps.length;
    const f0 = meanFit(pop);

    for (let gen = 0; gen < 30; gen++) {
      pop.sort((a, b) => fitness(b) - fitness(a));
      const parents = pop.slice(0, 12);
      const next = parents.slice(0, 4); // elitism
      while (next.length < 40) {
        const pa = parents[rng.int(parents.length)];
        const pb = parents[rng.int(parents.length)];
        const child = rng.chance(0.4)
          ? mutateBrain(crossoverBrain(pa, pb, rng), rng, tracker)
          : mutateBrain(pa, rng, tracker);
        next.push(child);
      }
      pop = next;
    }
    const f1 = meanFit(pop);
    expect(f1).toBeGreaterThan(f0 + 0.25); // selection measurably improved the behaviour
    expect(f1).toBeGreaterThan(0.3);
  });
});

// ----------------------------------------------------------- 4. determinism

describe('determinism', () => {
  it('same seed produces identical trajectories', async () => {
    const a = new World();
    const b = new World();
    await a.init(777);
    await b.init(777);
    for (let i = 0; i < 400; i++) {
      a.step();
      b.step();
    }
    expect(a.creatures.size).toBe(b.creatures.size);
    expect(Array.from(a.encodeSnapshot())).toEqual(Array.from(b.encodeSnapshot()));
    expect(a.ledger.state()).toEqual(b.ledger.state());
  });

  it('creatures do not tunnel through the terrain', async () => {
    const w = new World();
    await w.init(555);
    for (let i = 0; i < 600; i++) w.step();
    const { sampleHeight } = await import('../src/sim/ecology/terrain');
    for (const c of w.creatures.values()) {
      const p = c.rootPos();
      const h = sampleHeight(w.terrain, p.x, p.z);
      expect(p.y).toBeGreaterThan(h - 2.5);
      expect(c.health).toBeLessThanOrEqual(CREATURE_MAX_HEALTH + 1e-9);
    }
  });
});
