import { describe, expect, it } from 'vitest';
import type { BrainGenome } from '../src/shared/types';
import { RNG } from '../src/shared/rng';
import {
  HIDDEN_BASE,
  InnovationTracker,
  Network,
  OUT_BASE,
  brainDistance,
  createBrain,
  crossoverBrain,
  mutateBrain,
  repairBrainIO,
} from '../src/sim/genome/brain';

/** Asserts the structural invariants every brain genome must satisfy. */
function expectValid(g: BrainGenome): void {
  const nodeIds = new Set<number>();
  for (const n of g.nodes) {
    expect(nodeIds.has(n.id)).toBe(false); // unique node ids
    nodeIds.add(n.id);
    if (n.type === 'in') expect(n.id).toBeLessThan(OUT_BASE);
    if (n.type === 'out') {
      expect(n.id).toBeGreaterThanOrEqual(OUT_BASE);
      expect(n.id).toBeLessThan(HIDDEN_BASE);
    }
    if (n.type === 'hid') {
      expect(n.id).toBeGreaterThanOrEqual(HIDDEN_BASE);
      expect(n.id).toBeLessThan(g.nextNode);
    }
  }
  const pairs = new Set<string>();
  for (const c of g.conns) {
    expect(Number.isFinite(c.w)).toBe(true);
    expect(Math.abs(c.w)).toBeLessThanOrEqual(4);
    expect(c.from).not.toBe(c.to); // no self-loops
    expect(nodeIds.has(c.from)).toBe(true); // no dangling refs
    expect(nodeIds.has(c.to)).toBe(true);
    const key = `${c.from}>${c.to}`;
    expect(pairs.has(key)).toBe(false); // no duplicate connections
    pairs.add(key);
  }
  expect(g.nextNode).toBeGreaterThanOrEqual(HIDDEN_BASE);
}

/** Collects (from,to) -> innov and innov -> (from,to) and asserts both are functions. */
function expectInnovConsistent(genomes: BrainGenome[]): void {
  const byPair = new Map<string, number>();
  const byInnov = new Map<number, string>();
  for (const g of genomes) {
    for (const c of g.conns) {
      const pair = `${c.from}>${c.to}`;
      const seenInnov = byPair.get(pair);
      if (seenInnov !== undefined) expect(c.innov).toBe(seenInnov);
      else byPair.set(pair, c.innov);
      const seenPair = byInnov.get(c.innov);
      if (seenPair !== undefined) expect(pair).toBe(seenPair);
      else byInnov.set(c.innov, pair);
    }
  }
}

function deepCopy(g: BrainGenome): BrainGenome {
  return JSON.parse(JSON.stringify(g)) as BrainGenome;
}

describe('createBrain', () => {
  it('builds a minimal valid topology with correct id conventions', () => {
    const tracker = new InnovationTracker();
    const g = createBrain(10, 4, new RNG(42), tracker);
    expectValid(g);
    expect(g.nodes.filter((n) => n.type === 'in').map((n) => n.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(g.nodes.filter((n) => n.type === 'out').map((n) => n.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 4 }, (_, i) => OUT_BASE + i),
    );
    expect(g.nodes.filter((n) => n.type === 'hid')).toHaveLength(0);
    expect(g.nextNode).toBe(HIDDEN_BASE);
    for (let o = 0; o < 4; o++) {
      const incoming = g.conns.filter((c) => c.to === OUT_BASE + o);
      expect(incoming.length).toBeGreaterThanOrEqual(2);
      expect(incoming.length).toBeLessThanOrEqual(4);
      // distinct inputs
      expect(new Set(incoming.map((c) => c.from)).size).toBe(incoming.length);
      for (const c of incoming) expect(c.from).toBeLessThan(10);
    }
  });

  it('caps fan-in by numIn when there are fewer than 2 inputs', () => {
    const g = createBrain(1, 3, new RNG(7), new InnovationTracker());
    expectValid(g);
    for (let o = 0; o < 3; o++) expect(g.conns.filter((c) => c.to === OUT_BASE + o)).toHaveLength(1);
  });

  it('is deterministic: same seed => identical genome', () => {
    const a = createBrain(9, 5, new RNG(123), new InnovationTracker());
    const b = createBrain(9, 5, new RNG(123), new InnovationTracker());
    expect(a).toEqual(b);
  });
});

describe('InnovationTracker', () => {
  it('assigns the same innovation to the same (from,to) across genomes', () => {
    const tracker = new InnovationTracker();
    const a = createBrain(6, 3, new RNG(1), tracker);
    const b = createBrain(6, 3, new RNG(2), tracker);
    expectInnovConsistent([a, b]);
    expect(tracker.register(0, OUT_BASE)).toBe(tracker.register(0, OUT_BASE));
    expect(tracker.register(0, OUT_BASE)).not.toBe(tracker.register(1, OUT_BASE));
  });

  it('keeps innovation consistency through heavy mutation of separate lineages', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(99);
    let a = createBrain(5, 3, rng, tracker);
    let b = createBrain(5, 3, rng, tracker);
    for (let i = 0; i < 60; i++) {
      a = mutateBrain(a, rng, tracker);
      b = mutateBrain(b, rng, tracker);
    }
    expectValid(a);
    expectValid(b);
    // Hidden ids are per-genome, so cross-genome pairs involving hidden nodes
    // never collide; all shared (from,to) pairs must share innovation numbers.
    expectInnovConsistent([a, b]);
  });
});

describe('mutateBrain', () => {
  it('returns a new deep copy and never touches the argument', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(5);
    const g = createBrain(6, 2, rng, tracker);
    const snapshot = deepCopy(g);
    const m = mutateBrain(g, rng, tracker);
    expect(g).toEqual(snapshot);
    expect(m).not.toBe(g);
    expect(m.nodes).not.toBe(g.nodes);
    expect(m.conns).not.toBe(g.conns);
  });

  it('is deterministic: same seed => identical mutation chain', () => {
    const run = (): BrainGenome => {
      const tracker = new InnovationTracker();
      const rng = new RNG(2024);
      let g = createBrain(7, 3, rng, tracker);
      for (let i = 0; i < 40; i++) g = mutateBrain(g, rng, tracker);
      return g;
    };
    expect(run()).toEqual(run());
  });

  it('200-mutation fuzz keeps validity and finite weights', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(777);
    let g = createBrain(8, 3, rng, tracker);
    for (let i = 0; i < 200; i++) {
      g = mutateBrain(g, rng, tracker);
      expectValid(g);
    }
    // Structural mutations must actually have fired over 200 rounds.
    expect(g.nodes.some((n) => n.type === 'hid')).toBe(true);
    expect(g.nextNode).toBeGreaterThan(HIDDEN_BASE);
  });
});

describe('crossoverBrain', () => {
  function diverged(): { a: BrainGenome; b: BrainGenome; tracker: InnovationTracker } {
    const tracker = new InnovationTracker();
    const rng = new RNG(31);
    const root = createBrain(6, 3, rng, tracker);
    let a = root;
    let b = root;
    for (let i = 0; i < 25; i++) {
      a = mutateBrain(a, rng, tracker);
      b = mutateBrain(b, rng, tracker);
    }
    return { a, b, tracker };
  }

  it('child has exactly the fitter parent structure with mixed matching weights', () => {
    const { a, b } = diverged();
    const child = crossoverBrain(a, b, new RNG(4));
    expectValid(child);
    expect(child.conns.map((c) => c.innov).sort((x, y) => x - y)).toEqual(
      a.conns.map((c) => c.innov).sort((x, y) => x - y),
    );
    const aW = new Map(a.conns.map((c) => [c.innov, c.w]));
    const bW = new Map(b.conns.map((c) => [c.innov, c.w]));
    for (const c of child.conns) {
      const fromA = aW.get(c.innov) === c.w;
      const fromB = bW.get(c.innov) === c.w;
      expect(fromA || fromB).toBe(true);
      if (!bW.has(c.innov)) expect(fromA).toBe(true); // disjoint/excess only from a
    }
    expect(child.nextNode).toBe(Math.max(a.nextNode, b.nextNode));
  });

  it('is pure and deterministic', () => {
    const { a, b } = diverged();
    const sa = deepCopy(a);
    const sb = deepCopy(b);
    const c1 = crossoverBrain(a, b, new RNG(9));
    const c2 = crossoverBrain(a, b, new RNG(9));
    expect(a).toEqual(sa);
    expect(b).toEqual(sb);
    expect(c1).toEqual(c2);
  });
});

describe('brainDistance', () => {
  it('is 0 for identical genomes and symmetric', () => {
    const tracker = new InnovationTracker();
    const g = createBrain(6, 3, new RNG(8), tracker);
    expect(brainDistance(g, g)).toBe(0);
    expect(brainDistance(g, deepCopy(g))).toBe(0);
    const m = mutateBrain(g, new RNG(10), tracker);
    expect(brainDistance(g, m)).toBeCloseTo(brainDistance(m, g), 12);
  });

  it('grows as mutations accumulate', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(55);
    const base = createBrain(6, 3, rng, tracker);
    let g = base;
    for (let i = 0; i < 5; i++) g = mutateBrain(g, rng, tracker);
    const near = brainDistance(base, g);
    for (let i = 0; i < 80; i++) g = mutateBrain(g, rng, tracker);
    const far = brainDistance(base, g);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });
});

describe('repairBrainIO', () => {
  it('removes orphaned IO nodes and their connections when counts shrink', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(13);
    let g = createBrain(6, 4, rng, tracker);
    for (let i = 0; i < 30; i++) g = mutateBrain(g, rng, tracker);
    const r = repairBrainIO(g, 4, 2, rng, tracker);
    expectValid(r);
    for (const n of r.nodes) {
      if (n.type === 'in') expect(n.id).toBeLessThan(4);
      if (n.type === 'out') expect(n.id).toBeLessThan(OUT_BASE + 2);
    }
    const ids = new Set(r.nodes.map((n) => n.id));
    for (const c of r.conns) {
      expect(ids.has(c.from)).toBe(true);
      expect(ids.has(c.to)).toBe(true);
    }
    // hidden nodes survive the repair
    expect(r.nodes.filter((n) => n.type === 'hid').length).toBe(g.nodes.filter((n) => n.type === 'hid').length);
  });

  it('adds missing IO; new outputs get 1-2 small-weight incoming connections', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(21);
    const g = createBrain(3, 2, rng, tracker);
    const r = repairBrainIO(g, 6, 4, rng, tracker);
    expectValid(r);
    expect(r.nodes.filter((n) => n.type === 'in').map((n) => n.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.nodes.filter((n) => n.type === 'out')).toHaveLength(4);
    for (const oid of [OUT_BASE + 2, OUT_BASE + 3]) {
      const incoming = r.conns.filter((c) => c.to === oid);
      expect(incoming.length).toBeGreaterThanOrEqual(1);
      expect(incoming.length).toBeLessThanOrEqual(2);
      for (const c of incoming) expect(c.from).toBeLessThan(OUT_BASE); // from inputs/hidden only
    }
    // untouched: argument genome
    expect(g.nodes.filter((n) => n.type === 'in')).toHaveLength(3);
  });

  it('result drives a Network without NaN', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(33);
    let g = createBrain(5, 3, rng, tracker);
    for (let i = 0; i < 50; i++) g = mutateBrain(g, rng, tracker);
    const r = repairBrainIO(g, 9, 6, rng, tracker);
    expectValid(r);
    const net = new Network(r, 9, 6);
    for (let t = 0; t < 60; t++) {
      for (let i = 0; i < 9; i++) net.setInput(i, Math.sin(t * 0.3 + i));
      net.step();
    }
    const vals = net.values();
    expect(vals).toHaveLength(net.nodeIds.length);
    for (const v of vals) expect(Number.isFinite(v)).toBe(true);
    for (let i = 0; i < 6; i++) expect(Number.isFinite(net.getOutput(i))).toBe(true);
  });
});

describe('Network', () => {
  it('aligns nodeIds with values() and pins inputs', () => {
    const g = createBrain(4, 2, new RNG(3), new InnovationTracker());
    const net = new Network(g, 4, 2);
    expect(net.nodeIds.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(net.nodeIds.slice(4, 6)).toEqual([OUT_BASE, OUT_BASE + 1]);
    net.setInput(2, 0.5);
    net.step();
    net.step();
    expect(net.values()[2]).toBeCloseTo(0.5, 6);
  });

  it('is deterministic across instances for the same genome and inputs', () => {
    const tracker = new InnovationTracker();
    const rng = new RNG(2718);
    let g = createBrain(6, 3, rng, tracker);
    for (let i = 0; i < 40; i++) g = mutateBrain(g, rng, tracker);
    const run = (): number[] => {
      const net = new Network(g, 6, 3);
      const out: number[] = [];
      for (let t = 0; t < 100; t++) {
        for (let i = 0; i < 6; i++) net.setInput(i, Math.sin(t * 0.17 + i * 1.3));
        net.step();
        for (let i = 0; i < 3; i++) out.push(net.getOutput(i));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('computes XOR through a hand-built hidden layer after 2 sweeps', () => {
    // inputs: 0 = a, 1 = b, 2 = bias (pinned to 1)
    // h(1024, relu) = relu(a + b - 1)  -> AND
    // out(512, tanh) = tanh(a + b - 2h) -> tanh(XOR)
    const g: BrainGenome = {
      nodes: [
        { id: 0, type: 'in', act: 'tanh' },
        { id: 1, type: 'in', act: 'tanh' },
        { id: 2, type: 'in', act: 'tanh' },
        { id: OUT_BASE, type: 'out', act: 'tanh' },
        { id: HIDDEN_BASE, type: 'hid', act: 'relu' },
      ],
      conns: [
        { innov: 0, from: 0, to: HIDDEN_BASE, w: 1, on: true },
        { innov: 1, from: 1, to: HIDDEN_BASE, w: 1, on: true },
        { innov: 2, from: 2, to: HIDDEN_BASE, w: -1, on: true },
        { innov: 3, from: 0, to: OUT_BASE, w: 1, on: true },
        { innov: 4, from: 1, to: OUT_BASE, w: 1, on: true },
        { innov: 5, from: HIDDEN_BASE, to: OUT_BASE, w: -2, on: true },
      ],
      nextNode: HIDDEN_BASE + 1,
    };
    const evaluate = (a: number, b: number): number => {
      const net = new Network(g, 3, 1);
      net.setInput(0, a);
      net.setInput(1, b);
      net.setInput(2, 1);
      for (let t = 0; t < 3; t++) net.step();
      return net.getOutput(0);
    };
    expect(evaluate(0, 0)).toBeCloseTo(0, 5);
    expect(evaluate(1, 1)).toBeCloseTo(0, 5);
    expect(evaluate(1, 0)).toBeCloseTo(Math.tanh(1), 5);
    expect(evaluate(0, 1)).toBeCloseTo(Math.tanh(1), 5);
  });

  it('applies each activation function correctly', () => {
    const single = (act: 'tanh' | 'sin' | 'relu' | 'gauss', input: number): number => {
      const g: BrainGenome = {
        nodes: [
          { id: 0, type: 'in', act: 'tanh' },
          { id: OUT_BASE, type: 'out', act },
        ],
        conns: [{ innov: 0, from: 0, to: OUT_BASE, w: 1, on: true }],
        nextNode: HIDDEN_BASE,
      };
      const net = new Network(g, 1, 1);
      net.setInput(0, input);
      net.step();
      return net.getOutput(0);
    };
    expect(single('tanh', 0.7)).toBeCloseTo(Math.tanh(0.7), 6);
    expect(single('sin', Math.PI / 2)).toBeCloseTo(1, 6);
    expect(single('relu', -3)).toBe(0);
    expect(single('relu', 2.5)).toBeCloseTo(2.5, 6);
    expect(single('relu', 10)).toBe(4); // soft clamp at 4
    expect(single('gauss', 0)).toBeCloseTo(1, 6);
    expect(single('gauss', 2)).toBeCloseTo(Math.exp(-4), 6);
  });

  it('ignores disabled connections', () => {
    const g: BrainGenome = {
      nodes: [
        { id: 0, type: 'in', act: 'tanh' },
        { id: OUT_BASE, type: 'out', act: 'tanh' },
      ],
      conns: [{ innov: 0, from: 0, to: OUT_BASE, w: 3, on: false }],
      nextNode: HIDDEN_BASE,
    };
    const net = new Network(g, 1, 1);
    net.setInput(0, 1);
    net.step();
    expect(net.getOutput(0)).toBe(0); // tanh(0): the disabled conn carries nothing
  });
});
