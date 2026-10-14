import { describe, expect, it } from 'vitest';
import type { BodyGene, Genome, PhyloNode } from '../src/shared/types';
import { SPECIES_THRESHOLD } from '../src/shared/constants';
import { RNG } from '../src/shared/rng';
import { SpeciesTracker, makeSpeciesName, type GenomeDistance } from '../src/sim/species';

/**
 * Trivial injected distance: |generation difference|. Keeps the tests
 * independent of the real genome-compatibility modules; SPECIES_THRESHOLD is
 * 2.6, so generation gaps <= 2 cluster together and gaps >= 3 split.
 */
const genDistance: GenomeDistance = (a, b) => Math.abs(a.generation - b.generation);

/** Minimal valid genome stub; `generation` drives distance, `hue` the species color. */
function makeGenome(generation: number, hue = 0.5): Genome {
  const gene: BodyGene = {
    id: 0,
    parent: -1,
    shape: 'capsule',
    size: { x: 0.2, y: 0.3, z: 0.2 },
    density: 1,
    anchor: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    jointAxis: { x: 1, y: 0, z: 0 },
    jointLimits: [-1, 1],
    muscle: 0.5,
    recursion: 0,
    mirror: false,
    eyes: 0,
    eyeDir: { x: 0, y: 0, z: 1 },
    smell: false,
    mouth: true,
    color: [hue, 0.6, 0.5],
    patternFreq: 1,
    patternAmp: 0.2,
  };
  return {
    body: [gene],
    organism: { gutHerbivory: 0.5, sexual: 0.5, offspringEnergyFrac: 0.3, sizeScale: 1 },
    brain: { nodes: [], conns: [], nextNode: 0 },
    generation,
  };
}

function makeTracker(seed = 42): SpeciesTracker {
  return new SpeciesTracker(new RNG(seed), genDistance);
}

describe('SpeciesTracker.assign', () => {
  it('puts identical genomes in one species and counts population', () => {
    const t = makeTracker();
    const s0 = t.assign(makeGenome(0), -1, 0);
    expect(t.assign(makeGenome(0), s0, 5)).toBe(s0);
    expect(t.assign(makeGenome(0), s0, 9)).toBe(s0);
    expect(t.count()).toBe(1);
    const rec = t.get(s0)!;
    expect(rec.population).toBe(3);
    expect(rec.peakPopulation).toBe(3);
    expect(rec.parentId).toBe(-1);
    expect(rec.bornTick).toBe(0);
    expect(rec.extinctTick).toBeNull();
  });

  it('founds a new species beyond SPECIES_THRESHOLD with correct parent linkage', () => {
    const t = makeTracker();
    const s0 = t.assign(makeGenome(0), -1, 0);
    // distance 5 > SPECIES_THRESHOLD (2.6) from every representative -> split
    const s1 = t.assign(makeGenome(5), s0, 120);
    expect(s1).not.toBe(s0);
    expect(t.count()).toBe(2);
    const rec = t.get(s1)!;
    expect(rec.parentId).toBe(s0);
    expect(rec.bornTick).toBe(120);
    expect(rec.population).toBe(1);
    expect(rec.peakPopulation).toBe(1);
    expect(t.get(s0)!.population).toBe(1); // unchanged
    expect(genDistance(makeGenome(5), makeGenome(0))).toBeGreaterThan(SPECIES_THRESHOLD);
  });

  it('falls back to scanning all living species when the parent species does not match', () => {
    const t = makeTracker();
    const s0 = t.assign(makeGenome(0), -1, 0);
    const s1 = t.assign(makeGenome(10), s0, 1);
    // Child of an s1 member, but genetically back near s0: must rejoin s0.
    expect(t.assign(makeGenome(1), s1, 2)).toBe(s0);
    expect(t.count()).toBe(2);
  });

  it('never assigns to an extinct species; the lineage founds anew', () => {
    const t = makeTracker();
    const s0 = t.assign(makeGenome(0), -1, 0);
    t.memberDied(s0, 50);
    expect(t.get(s0)!.extinctTick).toBe(50);
    const s1 = t.assign(makeGenome(0), s0, 60); // identical genome, dead species
    expect(s1).not.toBe(s0);
    expect(t.get(s1)!.parentId).toBe(s0);
  });

  it('uses a refreshed representative for clustering', () => {
    const t = makeTracker();
    const s0 = t.assign(makeGenome(0), -1, 0);
    expect(t.assign(makeGenome(5), s0, 1)).not.toBe(s0); // 5 from rep(0): split
    t.refreshRepresentative(s0, makeGenome(4));
    expect(t.assign(makeGenome(5), s0, 2)).toBe(s0); // 1 from rep(4): join
  });

  it('derives hue from the founding genome first body gene color[0] (small jitter, wrapped)', () => {
    const t = makeTracker();
    const s0 = t.assign(makeGenome(0, 0.31), -1, 0);
    const hue = t.get(s0)!.hue;
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(1);
    const circDist = Math.min(Math.abs(hue - 0.31), 1 - Math.abs(hue - 0.31));
    expect(circDist).toBeLessThanOrEqual(0.05 + 1e-12);
    // hue near the 0/1 seam stays wrapped into [0, 1)
    const s1 = t.assign(makeGenome(99, 0.995), -1, 0);
    const seamHue = t.get(s1)!.hue;
    expect(seamHue).toBeGreaterThanOrEqual(0);
    expect(seamHue).toBeLessThan(1);
  });
});

describe('SpeciesTracker extinction and views', () => {
  it('memberDied decrements and marks extinctTick at zero; peak is kept', () => {
    const t = makeTracker();
    const s0 = t.assign(makeGenome(0), -1, 0);
    t.assign(makeGenome(0), s0, 1);
    t.memberDied(s0, 10);
    expect(t.get(s0)!.population).toBe(1);
    expect(t.get(s0)!.extinctTick).toBeNull();
    t.memberDied(s0, 20);
    const rec = t.get(s0)!;
    expect(rec.population).toBe(0);
    expect(rec.extinctTick).toBe(20);
    expect(rec.peakPopulation).toBe(2);
    expect(t.living()).toHaveLength(0);
    expect(t.all()).toHaveLength(1);
    // further deaths and unknown ids are ignored, extinctTick is not moved
    t.memberDied(s0, 30);
    t.memberDied(999, 30);
    expect(t.get(s0)!.extinctTick).toBe(20);
    expect(t.get(s0)!.population).toBe(0);
  });

  it('updateTraits copies the summary onto the record', () => {
    const t = makeTracker();
    const s0 = t.assign(makeGenome(0), -1, 0);
    const traits = { meanMass: 3, meanHerbivory: 0.8, meanSpeed: 1.2, meanBrainSize: 14, meanParts: 6 };
    t.updateTraits(s0, traits);
    expect(t.get(s0)!.traits).toEqual(traits);
    expect(t.get(s0)!.traits).not.toBe(traits); // defensive copy
  });

  it('get returns undefined for unknown ids', () => {
    expect(makeTracker().get(7)).toBeUndefined();
  });
});

describe('SpeciesTracker.phylo', () => {
  it('returns all species as a forest: parentId is -1 or an earlier existing species', () => {
    const t = makeTracker(7);
    const rng = new RNG(1);
    const ids: number[] = [];
    let gen = 0;
    let parent = -1;
    for (let i = 0; i < 25; i++) {
      gen += rng.chance(0.6) ? 5 : 0; // ~60% of assigns split a new species
      const id = t.assign(makeGenome(gen), parent, i * 10);
      ids.push(id);
      parent = id;
      if (rng.chance(0.3)) t.memberDied(id, i * 10 + 5); // some lineages die out
    }
    const nodes = t.phylo();
    expect(nodes).toHaveLength(t.count());
    const byId = new Map<number, PhyloNode>(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      if (n.parentId === -1) continue;
      const p = byId.get(n.parentId);
      expect(p).toBeDefined();
      expect(p!.id).toBeLessThan(n.id); // strictly earlier-founded
      expect(p!.bornTick).toBeLessThanOrEqual(n.bornTick);
    }
    // phylo mirrors the records
    for (const r of t.all()) {
      const n = byId.get(r.id)!;
      expect(n.name).toBe(r.name);
      expect(n.population).toBe(r.population);
      expect(n.peakPopulation).toBe(r.peakPopulation);
      expect(n.extinctTick).toBe(r.extinctTick);
      expect(n.hue).toBe(r.hue);
    }
  });
});

describe('makeSpeciesName', () => {
  it('produces sane, unique binomials over 200 draws', () => {
    const rng = new RNG(123);
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const name = makeSpeciesName(rng);
      expect(name).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
      const [genus, epithet] = name.split(' ');
      expect(genus.length).toBeGreaterThanOrEqual(3);
      expect(epithet.length).toBeGreaterThanOrEqual(3);
      names.add(name);
    }
    expect(names.size).toBe(200);
  });

  it('is deterministic for a given seed', () => {
    const seqA: string[] = [];
    const seqB: string[] = [];
    const rngA = new RNG(77);
    const rngB = new RNG(77);
    for (let i = 0; i < 20; i++) {
      seqA.push(makeSpeciesName(rngA));
      seqB.push(makeSpeciesName(rngB));
    }
    expect(seqA).toEqual(seqB);
  });
});

describe('determinism', () => {
  /** Drives one tracker through a fixed mixed workload from a seeded RNG. */
  function run(seed: number): { all: string; phylo: string } {
    const t = new SpeciesTracker(new RNG(seed), genDistance);
    const drive = new RNG(5150);
    let parent = -1;
    let gen = 0;
    const livingIds: number[] = [];
    for (let i = 0; i < 120; i++) {
      if (drive.chance(0.25)) gen += 4;
      const id = t.assign(makeGenome(gen, drive.next()), parent, i);
      if (!livingIds.includes(id)) livingIds.push(id);
      parent = id;
      if (drive.chance(0.2)) t.memberDied(drive.pick(livingIds), i);
      if (drive.chance(0.1)) t.refreshRepresentative(id, makeGenome(gen + 1));
      if (drive.chance(0.1)) {
        t.updateTraits(id, {
          meanMass: drive.next(),
          meanHerbivory: drive.next(),
          meanSpeed: drive.next(),
          meanBrainSize: drive.next(),
          meanParts: drive.next(),
        });
      }
    }
    return { all: JSON.stringify(t.all()), phylo: JSON.stringify(t.phylo()) };
  }

  it('same seed => identical species records and phylogeny', () => {
    const a = run(2024);
    const b = run(2024);
    expect(a.all).toBe(b.all);
    expect(a.phylo).toBe(b.phylo);
  });

  it('different tracker seeds change names/hues but not clustering structure', () => {
    const a = JSON.parse(run(1).all) as { id: number; parentId: number; population: number }[];
    const b = JSON.parse(run(2).all) as { id: number; parentId: number; population: number }[];
    expect(a.map((r) => [r.id, r.parentId, r.population])).toEqual(
      b.map((r) => [r.id, r.parentId, r.population]),
    );
  });
});
