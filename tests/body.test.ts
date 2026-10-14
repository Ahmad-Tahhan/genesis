import { describe, expect, it } from 'vitest';
import type { BodyGene } from '../src/shared/types';
import { RNG } from '../src/shared/rng';
import {
  MAX_BODY_GENES,
  MAX_EYES_PER_PART,
  MAX_PART_DIM,
  MAX_RECURSION,
  MIN_PART_DIM,
} from '../src/shared/constants';
import {
  bodyDistance,
  crossoverBody,
  mutateBody,
  mutateOrganism,
  randomBodyGenes,
  randomOrganism,
} from '../src/sim/genome/body';

/** Fresh monotone gene-id source starting at `start`. */
function counter(start = 0): () => number {
  let n = start;
  return () => n++;
}

/** Asserts every field of one gene is inside its documented range. */
function expectGeneInRange(g: BodyGene): void {
  expect(g.shape === 'capsule' || g.shape === 'box').toBe(true);
  for (const c of [g.size.x, g.size.y, g.size.z]) {
    expect(c).toBeGreaterThanOrEqual(MIN_PART_DIM);
    expect(c).toBeLessThanOrEqual(MAX_PART_DIM);
  }
  expect(g.density).toBeGreaterThanOrEqual(0.6);
  expect(g.density).toBeLessThanOrEqual(1.6);
  for (const c of [g.anchor.x, g.anchor.y, g.anchor.z]) {
    expect(Math.abs(c)).toBeLessThanOrEqual(1);
  }
  for (const c of [g.rotation.x, g.rotation.y, g.rotation.z]) {
    expect(Math.abs(c)).toBeLessThanOrEqual(Math.PI);
  }
  const axisLen = Math.hypot(g.jointAxis.x, g.jointAxis.y, g.jointAxis.z);
  expect(axisLen).toBeCloseTo(1, 6);
  expect(g.jointLimits[0]).toBeGreaterThanOrEqual(-2.4);
  expect(g.jointLimits[0]).toBeLessThanOrEqual(0);
  expect(g.jointLimits[1]).toBeGreaterThanOrEqual(0);
  expect(g.jointLimits[1]).toBeLessThanOrEqual(2.4);
  expect(g.muscle).toBeGreaterThanOrEqual(0);
  expect(g.muscle).toBeLessThanOrEqual(1);
  expect(Number.isInteger(g.recursion)).toBe(true);
  expect(g.recursion).toBeGreaterThanOrEqual(0);
  expect(g.recursion).toBeLessThanOrEqual(MAX_RECURSION);
  expect(Number.isInteger(g.eyes)).toBe(true);
  expect(g.eyes).toBeGreaterThanOrEqual(0);
  expect(g.eyes).toBeLessThanOrEqual(MAX_EYES_PER_PART);
  const eyeLen = Math.hypot(g.eyeDir.x, g.eyeDir.y, g.eyeDir.z);
  expect(eyeLen).toBeCloseTo(1, 6);
  for (const c of g.color) {
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  }
  expect(g.patternFreq).toBeGreaterThanOrEqual(1);
  expect(g.patternFreq).toBeLessThanOrEqual(12);
  expect(g.patternAmp).toBeGreaterThanOrEqual(0);
  expect(g.patternAmp).toBeLessThanOrEqual(1);
}

/**
 * Asserts the graph invariants: unique ids, exactly one root (parent -1),
 * every parent id exists, every gene reaches the root (no cycles), and the
 * genome fits in MAX_BODY_GENES.
 */
function expectValidGraph(genes: BodyGene[]): void {
  expect(genes.length).toBeGreaterThanOrEqual(1);
  expect(genes.length).toBeLessThanOrEqual(MAX_BODY_GENES);
  const ids = new Set(genes.map((g) => g.id));
  expect(ids.size).toBe(genes.length);
  const roots = genes.filter((g) => g.parent === -1);
  expect(roots.length).toBe(1);
  const byId = new Map(genes.map((g) => [g.id, g]));
  for (const g of genes) {
    if (g.parent === -1) continue;
    expect(ids.has(g.parent)).toBe(true);
    // walk to the root; a cycle would exceed genes.length hops
    let cur = g;
    let hops = 0;
    while (cur.parent !== -1) {
      cur = byId.get(cur.parent)!;
      hops++;
      expect(hops).toBeLessThanOrEqual(genes.length);
    }
  }
}

describe('randomBodyGenes / randomOrganism', () => {
  it('respects all documented ranges and invariants across 500 random genomes', () => {
    const rng = new RNG(1234);
    const nextId = counter();
    for (let i = 0; i < 500; i++) {
      const genes = randomBodyGenes(rng, nextId);
      expect(genes.length).toBeGreaterThanOrEqual(2);
      expect(genes.length).toBeLessThanOrEqual(4);
      expect(genes[0].parent).toBe(-1); // gene 0 is the root torso
      expect(genes.some((g) => g.mouth)).toBe(true); // founders can eat
      expect(genes.some((g) => g.eyes >= 1)).toBe(true); // founders can see
      expectValidGraph(genes);
      for (const g of genes) expectGeneInRange(g);

      const o = randomOrganism(rng);
      expect(o.gutHerbivory).toBeGreaterThanOrEqual(0.35); // herbivore-biased founders
      expect(o.gutHerbivory).toBeLessThanOrEqual(1);
      expect(o.sexual).toBeGreaterThanOrEqual(0);
      expect(o.sexual).toBeLessThanOrEqual(1);
      expect(o.offspringEnergyFrac).toBeGreaterThanOrEqual(0.15);
      expect(o.offspringEnergyFrac).toBeLessThanOrEqual(0.6);
      expect(o.sizeScale).toBeGreaterThanOrEqual(0.6);
      expect(o.sizeScale).toBeLessThanOrEqual(1.8);
    }
  });

  it('is deterministic: same seed, same output', () => {
    const a = randomBodyGenes(new RNG(42), counter());
    const b = randomBodyGenes(new RNG(42), counter());
    expect(b).toEqual(a);
    expect(randomOrganism(new RNG(7))).toEqual(randomOrganism(new RNG(7)));
  });
});

describe('mutateBody', () => {
  it('returns a new deep copy with no aliasing into the input', () => {
    const rng = new RNG(5);
    const nextId = counter();
    const genes = randomBodyGenes(rng, nextId);
    const before = JSON.parse(JSON.stringify(genes));
    const out = mutateBody(genes, rng, nextId);
    expect(out).not.toBe(genes);
    for (const g of out) {
      expect(genes.includes(g)).toBe(false); // no shared gene objects
    }
    // scribbling on the output must not touch the input
    for (const g of out) {
      g.size.x = 99;
      g.color[0] = 99;
      g.jointLimits[0] = -99;
      g.parent = 12345;
    }
    expect(genes).toEqual(before);
  });

  it('keeps invariants, ranges, the cap and the root over long mutation chains', () => {
    const rng = new RNG(99);
    const nextId = counter();
    let genes = randomBodyGenes(rng, nextId);
    const rootId = genes[0].id;
    for (let i = 0; i < 600; i++) {
      genes = mutateBody(genes, rng, nextId);
      expect(genes.length).toBeLessThanOrEqual(MAX_BODY_GENES);
      expectValidGraph(genes);
      for (const g of genes) expectGeneInRange(g);
      // the root gene is never deleted or re-parented
      const root = genes.find((g) => g.parent === -1)!;
      expect(root.id).toBe(rootId);
    }
    // structural mutation must have fired at some point over 600 rounds
    expect(nextId()).toBeGreaterThan(4);
  });

  it('assigns fresh unique ids on duplication', () => {
    const rng = new RNG(3);
    const nextId = counter();
    let genes = randomBodyGenes(rng, nextId);
    for (let i = 0; i < 400; i++) {
      genes = mutateBody(genes, rng, nextId);
      const ids = new Set(genes.map((g) => g.id));
      expect(ids.size).toBe(genes.length);
    }
  });

  it('is deterministic: same seed, same mutation', () => {
    const base = randomBodyGenes(new RNG(11), counter());
    const m1 = mutateBody(base, new RNG(77), counter(100));
    const m2 = mutateBody(base, new RNG(77), counter(100));
    expect(m2).toEqual(m1);
  });
});

describe('mutateOrganism', () => {
  it('returns a new object and stays within documented ranges over many steps', () => {
    const rng = new RNG(21);
    let o = randomOrganism(rng);
    for (let i = 0; i < 1000; i++) {
      const next = mutateOrganism(o, rng);
      expect(next).not.toBe(o);
      o = next;
      expect(o.gutHerbivory).toBeGreaterThanOrEqual(0);
      expect(o.gutHerbivory).toBeLessThanOrEqual(1);
      expect(o.sexual).toBeGreaterThanOrEqual(0);
      expect(o.sexual).toBeLessThanOrEqual(1);
      expect(o.offspringEnergyFrac).toBeGreaterThanOrEqual(0.15);
      expect(o.offspringEnergyFrac).toBeLessThanOrEqual(0.6);
      expect(o.sizeScale).toBeGreaterThanOrEqual(0.6);
      expect(o.sizeScale).toBeLessThanOrEqual(1.8);
    }
  });

  it('is deterministic: same seed, same jitter', () => {
    const o = randomOrganism(new RNG(31));
    expect(mutateOrganism(o, new RNG(5))).toEqual(mutateOrganism(o, new RNG(5)));
  });
});

describe('crossoverBody', () => {
  it('produces valid graphs keyed by the fitter parent, for related parents', () => {
    const rng = new RNG(1);
    const nextId = counter();
    for (let trial = 0; trial < 200; trial++) {
      const ancestor = randomBodyGenes(rng, nextId);
      // derive two relatives sharing many gene ids
      let a = ancestor;
      let b = ancestor;
      for (let i = 0; i < 10; i++) {
        a = mutateBody(a, rng, nextId);
        b = mutateBody(b, rng, nextId);
      }
      const aSnapshot = JSON.parse(JSON.stringify(a));
      const bSnapshot = JSON.parse(JSON.stringify(b));
      const child = crossoverBody(a, b, rng);
      // child has exactly a's gene ids
      expect(child.map((g) => g.id).sort((x, y) => x - y)).toEqual(
        a.map((g) => g.id).sort((x, y) => x - y),
      );
      expectValidGraph(child);
      for (const g of child) expectGeneInRange(g);
      // inputs untouched
      expect(a).toEqual(aSnapshot);
      expect(b).toEqual(bSnapshot);
    }
  });

  it('repairs parent links that mixing breaks (missing ids and cycles)', () => {
    // a: 0 -> 1 -> 2; b: same ids but reversed interior parentage, so a 50/50
    // parent mix can produce 1 -> 2 -> 1 cycles or dangling references.
    const rng0 = new RNG(8);
    const base = randomBodyGenes(new RNG(500), counter());
    const mk = (id: number, parent: number): BodyGene =>
      ({ ...JSON.parse(JSON.stringify(base[0])), id, parent }) as BodyGene;
    const a = [mk(0, -1), mk(1, 0), mk(2, 1), mk(5, 2)];
    // b's gene 1 parents onto b-only id 9 (dangling after mixing); genes 2 and
    // 5 parent onto each other's subtree so a 50/50 parent mix can cycle.
    const b = [mk(0, -1), mk(1, 9), mk(2, 5), mk(5, 2), mk(9, 0)];
    for (let i = 0; i < 300; i++) {
      const child = crossoverBody(a, b, rng0.fork(i));
      expectValidGraph(child);
      expect(child.find((g) => g.parent === -1)!.id).toBe(0);
      // no gene id from b-only genes leaks in
      expect(child.some((g) => g.id === 9)).toBe(false);
    }
  });

  it('is deterministic: same seed, same child', () => {
    const nextId = counter();
    const a = randomBodyGenes(new RNG(60), nextId);
    const b = randomBodyGenes(new RNG(61), nextId);
    expect(crossoverBody(a, b, new RNG(9))).toEqual(crossoverBody(a, b, new RNG(9)));
  });
});

describe('bodyDistance', () => {
  it('is zero on identical genomes (including deep copies)', () => {
    const genes = randomBodyGenes(new RNG(70), counter());
    expect(bodyDistance(genes, genes)).toBe(0);
    const copy = JSON.parse(JSON.stringify(genes)) as BodyGene[];
    expect(bodyDistance(genes, copy)).toBe(0);
  });

  it('is symmetric and positive on random pairs, around 1-2 for unrelated genomes', () => {
    const rng = new RNG(80);
    for (let i = 0; i < 100; i++) {
      // shared id space (overlapping ids): parametric term dominates
      const a1 = randomBodyGenes(rng.fork(i * 2), counter());
      const b1 = randomBodyGenes(rng.fork(i * 2 + 1), counter());
      const d1 = bodyDistance(a1, b1);
      expect(d1).toBeGreaterThan(0);
      expect(bodyDistance(b1, a1)).toBeCloseTo(d1, 10);

      // disjoint id space: structural term dominates
      const shared = counter();
      const a2 = randomBodyGenes(rng.fork(i * 2 + 1000), shared);
      const b2 = randomBodyGenes(rng.fork(i * 2 + 1001), shared);
      const d2 = bodyDistance(a2, b2);
      expect(d2).toBeGreaterThan(0);
      expect(bodyDistance(b2, a2)).toBeCloseTo(d2, 10);
      expect(d2).toBeLessThanOrEqual(2);
    }
    // unrelated genomes typically land around 1-2: check the mean
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const a = randomBodyGenes(rng.fork(9000 + i * 2), counter());
      const b = randomBodyGenes(rng.fork(9001 + i * 2), counter());
      samples.push(bodyDistance(a, b));
    }
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(2);
  });

  it('grows with mutation count (relatives are closer than strangers)', () => {
    const rng = new RNG(90);
    const nextId = counter();
    const ancestor = randomBodyGenes(rng, nextId);
    let drifted = ancestor;
    for (let i = 0; i < 3; i++) drifted = mutateBody(drifted, rng, nextId);
    const near = bodyDistance(ancestor, drifted);
    const stranger = randomBodyGenes(rng.fork(1), counter(500));
    const far = bodyDistance(ancestor, stranger);
    expect(near).toBeLessThan(far);
  });
});
