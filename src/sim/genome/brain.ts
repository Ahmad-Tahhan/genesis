/**
 * NEAT-style neuroevolution (DECISIONS.md D3, D17).
 *
 * Node id convention (fixed project-wide):
 *  - inputs:  0 .. numIn-1            (numIn < OUT_BASE always holds)
 *  - outputs: OUT_BASE .. OUT_BASE+numOut-1  (numOut < HIDDEN_BASE-OUT_BASE)
 *  - hidden:  allocated per-genome from `genome.nextNode`, starting at HIDDEN_BASE
 *
 * Innovation numbers are global per InnovationTracker (one per world) and are
 * keyed purely by the (from, to) node-id pair, so structurally identical
 * connections in different genomes align at crossover. All functions are pure:
 * they never mutate their genome arguments; the only shared mutable state is
 * the explicitly-passed InnovationTracker.
 */
import type { Activation, BrainGenome, ConnGene, NodeGene } from '../../shared/types';
import { RNG } from '../../shared/rng';
import {
  COMPAT_C_DISJOINT,
  COMPAT_C_EXCESS,
  COMPAT_C_WEIGHT,
  MUT_ADD_CONN_P,
  MUT_ADD_NODE_P,
  MUT_TOGGLE_CONN_P,
  MUT_WEIGHT_P,
  MUT_WEIGHT_SD,
} from '../../shared/constants';

/** First output node id. Input ids must stay below this. */
export const OUT_BASE = 512;
/** First hidden node id; `BrainGenome.nextNode` starts here and only grows. */
export const HIDDEN_BASE = 1024;

/** Weight bounds enforced on every created or mutated connection. */
const W_MAX = 4;

/** Hidden-node activation pool for add-node mutation. */
const HIDDEN_ACTS: readonly Activation[] = ['tanh', 'sin', 'relu', 'gauss'];

function clampW(w: number): number {
  return w > W_MAX ? W_MAX : w < -W_MAX ? -W_MAX : w;
}

function cloneBrain(b: BrainGenome): BrainGenome {
  return {
    nodes: b.nodes.map((n) => ({ ...n })),
    conns: b.conns.map((c) => ({ ...c })),
    nextNode: b.nextNode,
  };
}

function connKey(from: number, to: number): string {
  return from + '>' + to;
}

/**
 * Global registry of structural innovations. The same (from, to) node-id pair
 * always maps to the same innovation number, across all genomes sharing this
 * tracker — this is what lets crossover align connection genes.
 */
export class InnovationTracker {
  private map = new Map<string, number>();
  private counter = 0;

  /** Return the innovation number for (from, to), minting one on first use. */
  register(from: number, to: number): number {
    const key = connKey(from, to);
    let innov = this.map.get(key);
    if (innov === undefined) {
      innov = this.counter++;
      this.map.set(key, innov);
    }
    return innov;
  }
}

/**
 * Minimal starting topology: all input and output NodeGenes, and each output
 * wired from 2-4 distinct random inputs (capped by numIn) with gaussian(sd 1)
 * weights clamped to [-4, 4]. `nextNode` starts at HIDDEN_BASE.
 */
export function createBrain(numIn: number, numOut: number, rng: RNG, tracker: InnovationTracker): BrainGenome {
  const nodes: NodeGene[] = [];
  for (let i = 0; i < numIn; i++) nodes.push({ id: i, type: 'in', act: 'tanh' });
  for (let i = 0; i < numOut; i++) nodes.push({ id: OUT_BASE + i, type: 'out', act: 'tanh' });
  const conns: ConnGene[] = [];
  const pool: number[] = [];
  for (let o = 0; o < numOut; o++) {
    const to = OUT_BASE + o;
    const k = Math.min(numIn, 2 + rng.int(3));
    // Partial Fisher-Yates: k distinct inputs with a bounded number of draws.
    pool.length = 0;
    for (let i = 0; i < numIn; i++) pool.push(i);
    for (let j = 0; j < k; j++) {
      const r = j + rng.int(numIn - j);
      const tmp = pool[j];
      pool[j] = pool[r];
      pool[r] = tmp;
      conns.push({ innov: tracker.register(pool[j], to), from: pool[j], to, w: clampW(rng.gaussian(0, 1)), on: true });
    }
  }
  return { nodes, conns, nextNode: HIDDEN_BASE };
}

/** Add one non-duplicate connection (from: any node; to: hidden/output; no self-loops). */
function mutAddConn(g: BrainGenome, rng: RNG, tracker: InnovationTracker): void {
  const targets = g.nodes.filter((n) => n.type !== 'in');
  if (g.nodes.length === 0 || targets.length === 0) return;
  const existing = new Set<string>();
  for (const c of g.conns) existing.add(connKey(c.from, c.to));
  for (let attempt = 0; attempt < 20; attempt++) {
    const from = g.nodes[rng.int(g.nodes.length)].id;
    const to = targets[rng.int(targets.length)].id;
    if (from === to) continue; // no self-loops; other recurrence is allowed
    const key = connKey(from, to);
    if (existing.has(key)) continue;
    g.conns.push({ innov: tracker.register(from, to), from, to, w: clampW(rng.gaussian(0, 1)), on: true });
    return;
  }
}

/** Split a random enabled connection: disable it, insert a hidden node between. */
function mutAddNode(g: BrainGenome, rng: RNG, tracker: InnovationTracker): void {
  const enabled = g.conns.filter((c) => c.on);
  if (enabled.length === 0) return;
  const split = enabled[rng.int(enabled.length)];
  split.on = false;
  const nid = g.nextNode++;
  g.nodes.push({ id: nid, type: 'hid', act: rng.pick(HIDDEN_ACTS) });
  g.conns.push({ innov: tracker.register(split.from, nid), from: split.from, to: nid, w: 1, on: true });
  g.conns.push({ innov: tracker.register(nid, split.to), from: nid, to: split.to, w: split.w, on: true });
}

/**
 * Mutate per the MUT_* constants and return a NEW deep-copied genome (the
 * argument is never touched): weight jitter (90% gaussian MUT_WEIGHT_SD jitter
 * per conn, else full reset), add-connection, add-node (split), toggle-enable.
 */
export function mutateBrain(b: BrainGenome, rng: RNG, tracker: InnovationTracker): BrainGenome {
  const g = cloneBrain(b);
  if (rng.chance(MUT_WEIGHT_P)) {
    for (const c of g.conns) {
      c.w = rng.chance(0.9) ? clampW(c.w + rng.gaussian(0, MUT_WEIGHT_SD)) : clampW(rng.gaussian(0, 1));
    }
  }
  if (rng.chance(MUT_ADD_CONN_P)) mutAddConn(g, rng, tracker);
  if (rng.chance(MUT_ADD_NODE_P)) mutAddNode(g, rng, tracker);
  if (rng.chance(MUT_TOGGLE_CONN_P) && g.conns.length > 0) {
    const c = g.conns[rng.int(g.conns.length)];
    c.on = !c.on;
  }
  return g;
}

/**
 * NEAT crossover; `a` must be the fitter parent. Matching innovations take the
 * gene (weight + enabled flag) from a random parent; disjoint/excess genes come
 * from `a` only. Child nodes are `a`'s plus any `b` nodes the inherited
 * connections reference; nextNode = max of the parents'.
 */
export function crossoverBrain(a: BrainGenome, b: BrainGenome, rng: RNG): BrainGenome {
  const bByInnov = new Map<number, ConnGene>();
  for (const c of b.conns) bByInnov.set(c.innov, c);
  const conns: ConnGene[] = a.conns.map((ca) => {
    const cb = bByInnov.get(ca.innov);
    return { ...(cb !== undefined && rng.chance(0.5) ? cb : ca) };
  });
  const have = new Set<number>();
  const nodes: NodeGene[] = a.nodes.map((n) => {
    have.add(n.id);
    return { ...n };
  });
  for (const c of conns) {
    for (const id of [c.from, c.to]) {
      if (have.has(id)) continue;
      const nb = b.nodes.find((n) => n.id === id);
      if (nb) {
        nodes.push({ ...nb });
        have.add(id);
      }
    }
  }
  return { nodes, conns, nextNode: Math.max(a.nextNode, b.nextNode) };
}

/**
 * NEAT compatibility distance:
 * COMPAT_C_EXCESS*E/N + COMPAT_C_DISJOINT*D/N + COMPAT_C_WEIGHT*meanWeightDiff,
 * where N = max connection-gene count of the two genomes (min 1) and
 * meanWeightDiff averages |wa - wb| over matching innovations (0 if none).
 */
export function brainDistance(a: BrainGenome, b: BrainGenome): number {
  const aByInnov = new Map<number, number>();
  let maxA = -1;
  for (const c of a.conns) {
    aByInnov.set(c.innov, c.w);
    if (c.innov > maxA) maxA = c.innov;
  }
  const bByInnov = new Map<number, number>();
  let maxB = -1;
  for (const c of b.conns) {
    bByInnov.set(c.innov, c.w);
    if (c.innov > maxB) maxB = c.innov;
  }
  let matching = 0;
  let weightDiff = 0;
  let disjoint = 0;
  let excess = 0;
  for (const c of a.conns) {
    const wb = bByInnov.get(c.innov);
    if (wb !== undefined) {
      matching++;
      weightDiff += Math.abs(c.w - wb);
    } else if (c.innov > maxB) excess++;
    else disjoint++;
  }
  for (const c of b.conns) {
    if (aByInnov.has(c.innov)) continue;
    if (c.innov > maxA) excess++;
    else disjoint++;
  }
  const n = Math.max(1, a.conns.length, b.conns.length);
  const meanW = matching > 0 ? weightDiff / matching : 0;
  return (COMPAT_C_EXCESS * excess) / n + (COMPAT_C_DISJOINT * disjoint) / n + COMPAT_C_WEIGHT * meanW;
}

/**
 * Repair the brain after a body mutation changed the IO counts (D17). Removes
 * input nodes with id >= numIn (and < OUT_BASE), output nodes with id >=
 * OUT_BASE+numOut (and < HIDDEN_BASE), and every connection referencing a
 * removed/unknown node; adds missing input/output NodeGenes. Each newly added
 * output gets 1-2 small-weight incoming connections from random non-output
 * nodes. Returns a NEW genome; the argument is untouched.
 */
export function repairBrainIO(
  b: BrainGenome,
  numIn: number,
  numOut: number,
  rng: RNG,
  tracker: InnovationTracker,
): BrainGenome {
  const validId = (id: number): boolean =>
    id < OUT_BASE ? id < numIn : id < HIDDEN_BASE ? id < OUT_BASE + numOut : true;
  const nodes: NodeGene[] = [];
  const ids = new Set<number>();
  for (const n of b.nodes) {
    if (!validId(n.id) || ids.has(n.id)) continue;
    nodes.push({ ...n });
    ids.add(n.id);
  }
  for (let i = 0; i < numIn; i++) {
    if (!ids.has(i)) {
      nodes.push({ id: i, type: 'in', act: 'tanh' });
      ids.add(i);
    }
  }
  const newOutputs: number[] = [];
  for (let i = 0; i < numOut; i++) {
    const id = OUT_BASE + i;
    if (!ids.has(id)) {
      nodes.push({ id, type: 'out', act: 'tanh' });
      ids.add(id);
      newOutputs.push(id);
    }
  }
  const conns: ConnGene[] = [];
  const existing = new Set<string>();
  for (const c of b.conns) {
    if (!ids.has(c.from) || !ids.has(c.to)) continue;
    conns.push({ ...c });
    existing.add(connKey(c.from, c.to));
  }
  const sources: number[] = [];
  for (const n of nodes) if (n.type !== 'out') sources.push(n.id);
  for (const oid of newOutputs) {
    const want = 1 + rng.int(2);
    for (let t = 0; t < want && sources.length > 0; t++) {
      const from = sources[rng.int(sources.length)];
      const key = connKey(from, oid);
      if (existing.has(key)) continue;
      existing.add(key);
      conns.push({ innov: tracker.register(from, oid), from, to: oid, w: clampW(rng.gaussian(0, 0.5)), on: true });
    }
  }
  return { nodes, conns, nextNode: b.nextNode };
}

/** Activation codes used in the compiled network's typed arrays. */
const ACT_CODE: Record<Activation, number> = { tanh: 0, sin: 1, relu: 2, gauss: 3 };

function applyAct(code: number, x: number): number {
  switch (code) {
    case 0:
      return Math.tanh(x);
    case 1:
      return Math.sin(x);
    case 2:
      // relu soft-capped at 4 to keep recurrent loops bounded.
      return x <= 0 ? 0 : x > 4 ? 4 : x;
    default:
      return Math.exp(-x * x);
  }
}

/**
 * Compiled runtime network. `step()` performs ONE synchronous propagation
 * sweep (real-time NEAT): every hidden/output node recomputes from the
 * previous tick's values, so recurrent connections work with no cycle
 * handling, and signals travel one connection per tick. Inputs are pinned to
 * the last `setInput` values. Hot path uses typed arrays and precomputed
 * index maps; no allocation per step.
 *
 * Connections that reference node ids absent from the (numIn, numOut, hidden)
 * layout — possible before `repairBrainIO` ran — are silently dropped.
 */
export class Network {
  /** For the inspector: node ids aligned with `values()` — inputs 0..numIn-1, then outputs, then hidden. */
  readonly nodeIds: number[];

  private readonly numIn: number;
  private readonly acts: Uint8Array;
  private vals: Float32Array;
  private next: Float32Array;
  private readonly sums: Float32Array;
  private readonly cFrom: Int32Array;
  private readonly cTo: Int32Array;
  private readonly cW: Float32Array;

  constructor(genome: BrainGenome, numIn: number, numOut: number) {
    this.numIn = numIn;
    const byId = new Map<number, NodeGene>();
    for (const n of genome.nodes) byId.set(n.id, n);
    const ids: number[] = [];
    for (let i = 0; i < numIn; i++) ids.push(i);
    for (let i = 0; i < numOut; i++) ids.push(OUT_BASE + i);
    const seen = new Set<number>(ids);
    for (const n of genome.nodes) {
      if (n.id >= HIDDEN_BASE && !seen.has(n.id)) {
        ids.push(n.id);
        seen.add(n.id);
      }
    }
    this.nodeIds = ids;
    const n = ids.length;
    const index = new Map<number, number>();
    this.acts = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      index.set(ids[i], i);
      this.acts[i] = ACT_CODE[byId.get(ids[i])?.act ?? 'tanh'];
    }
    const from: number[] = [];
    const to: number[] = [];
    const w: number[] = [];
    for (const c of genome.conns) {
      if (!c.on) continue;
      const f = index.get(c.from);
      const t = index.get(c.to);
      if (f === undefined || t === undefined || t < numIn) continue; // inputs are pinned, never driven
      from.push(f);
      to.push(t);
      w.push(c.w);
    }
    this.cFrom = Int32Array.from(from);
    this.cTo = Int32Array.from(to);
    this.cW = Float32Array.from(w);
    this.vals = new Float32Array(n);
    this.next = new Float32Array(n);
    this.sums = new Float32Array(n);
  }

  /** Pin input node i (0..numIn-1) to v until the next setInput. */
  setInput(i: number, v: number): void {
    this.vals[i] = v;
  }

  /** One propagation sweep: new[n] = act(sum of w*old[from]) for hidden/output. */
  step(): void {
    const { cFrom, cTo, cW, sums, vals, next, acts, numIn } = this;
    sums.fill(0);
    for (let c = 0; c < cFrom.length; c++) sums[cTo[c]] += cW[c] * vals[cFrom[c]];
    for (let i = 0; i < numIn; i++) next[i] = vals[i];
    for (let i = numIn; i < sums.length; i++) next[i] = applyAct(acts[i], sums[i]);
    this.vals = next;
    this.next = vals;
  }

  /** Current activation of output i (0..numOut-1). */
  getOutput(i: number): number {
    return this.vals[this.numIn + i];
  }

  /** For the inspector: snapshot of every node's current activation, aligned with nodeIds. */
  values(): Float32Array {
    return this.vals.slice();
  }
}
