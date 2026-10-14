/**
 * Development: grow a BodyPlan from a genome's directed body graph
 * (DECISIONS.md D2) and lay out the canonical brain IO (DECISIONS.md D17).
 *
 * Fully deterministic — no RNG anywhere; the same (body, organism) input
 * always yields a deep-equal plan. Inputs are never mutated.
 *
 * Expansion rules:
 *  - The root gene (parent === -1; smallest id if the graph is malformed and
 *    has several) produces exactly one part. Root `recursion` and `mirror`
 *    are ignored: a chain/mirror is only defined relative to a parent part.
 *  - Child genes expand breadth-first; a gene's children are the genes whose
 *    `parent` equals its id, sorted by gene id. Each queue entry grows a
 *    chain of (1 + recursion) copies, every copy attached to the previous
 *    one with the same anchor/rotation (tails, necks, segmented legs).
 *  - `mirror` grows a second chain reflected across the parent's local YZ
 *    plane; the mirrored branch expands its own children mirrored too
 *    (parity flips again on nested mirrors). Children of a gene attach to
 *    the TIP of each of its chains.
 *  - Expansion hard-stops at MAX_PARTS parts; breadth-first order makes the
 *    truncation stable under subtree growth.
 *
 * Mirror convention (reflection M across the parent's local YZ plane,
 * i.e. x -> -x): anchors are polar vectors, so anchor.x is negated. The
 * rest rotation R maps to M·R·M, which for euler XYZ is (x, -y, -z). The
 * joint axis is an axial vector (det(M)·M·v), so it maps to (x, -y, -z);
 * with identical joint limits this makes the SAME motor command drive
 * world-mirrored motion on both sides (verified in tests via anchors).
 * Eye base directions are polar vectors in the part frame and mirror as
 * (-x, y, z); the fan offsets are symmetric about the base direction, so
 * the mirrored ray set is the reflection of the original set.
 *
 * Attachment convention: a part hangs from its own local top,
 * anchorOnSelf = (0, +halfExtentY, 0) (box: size.y; capsule: hh + r), onto
 * anchorOnParent = clamped normalized gene anchor * parent half extents
 * (capsule half extents are (r, hh + r, r)).
 *
 * Eyes: each produced part (chain and mirror copies included) carries the
 * gene's rays, fanned around eyeDir in EYE_FOV_SPREAD steps about the part's
 * local Y axis, consuming a whole-body budget of MAX_EYE_RAYS in part
 * creation order; rays beyond the budget are silently dropped.
 */
import type { BodyGene, BodyPlan, OrganismGenes, PlanPart } from '../../shared/types';
import type { PlanEye, Vec3 } from '../../shared/types';
import { EYE_INPUTS, INTERNAL_INPUTS, SMELL_INPUTS } from '../../shared/types';
import {
  EYE_FOV_SPREAD,
  MAX_EYES_PER_PART,
  MAX_EYE_RAYS,
  MAX_PARTS,
  MAX_RECURSION,
  MIN_PART_DIM,
  MAX_PART_DIM,
  MUSCLE_TORQUE_PER_VOLUME,
  TISSUE_DENSITY,
} from '../../shared/constants';

/** Labels of the 8 internal inputs, in the canonical D17 order. */
const INTERNAL_LABELS: readonly string[] = [
  'hunger',
  'energyFrac',
  'health',
  'speed',
  'upright',
  'sinOsc',
  'cosOsc',
  'bias',
];

/** Near-zero vector threshold below which the (1,0,0) fallback applies. */
const AXIS_EPS = 1e-6;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Normalized copy of v, or +X when v is near zero / non-finite. */
function normOrX(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(len) || len < AXIS_EPS) return { x: 1, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/** Rotate v about the local Y axis by angle radians (right-handed, y up). */
function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

/** Half-extent vector used for anchor scaling (capsule: (r, hh + r, r)). */
function halfExtents(shape: BodyGene['shape'], size: Vec3): Vec3 {
  return shape === 'capsule' ? { x: size.x, y: size.y + size.x, z: size.x } : { ...size };
}

/** Box: 8·sx·sy·sz (half extents). Capsule: π·r²·2hh + 4/3·π·r³. */
function partVolume(shape: BodyGene['shape'], size: Vec3): number {
  if (shape === 'capsule') {
    const r = size.x;
    const hh = size.y;
    return Math.PI * r * r * (2 * hh) + (4 / 3) * Math.PI * r * r * r;
  }
  return 8 * size.x * size.y * size.z;
}

/** Internal queue entry: expand `gene` onto part `parentIndex` at mirror parity. */
interface Expansion {
  gene: BodyGene;
  parentIndex: number;
  mirrored: boolean;
}

/**
 * Grow a BodyPlan from the body graph. Deterministic, pure (no RNG, inputs
 * untouched). Produces at most MAX_PARTS parts; clamps every per-part size
 * component of gene.size * organism.sizeScale to [MIN_PART_DIM, MAX_PART_DIM];
 * sanitizes joint axes (unit; (1,0,0) fallback) and limits (lo <= 0 <= hi).
 * Brain IO (D17): inputs = per part [touch, per eye ray (dist,r,g,b), if
 * smell 4 floats], then the 8 internals; outputs = one joint motor per
 * non-root part, in part order. A plan with no parts still reports the 8
 * internal inputs so numInputs always equals the layout formula.
 * viable = >= 2 parts AND a mouth part exists AND totalMass > 0.
 */
export function develop(body: BodyGene[], organism: OrganismGenes): BodyPlan {
  const parts: PlanPart[] = [];
  let eyeBudget = MAX_EYE_RAYS;

  // Children lookup, sorted by gene id for deterministic expansion order.
  // Self-parented genes are dropped (unreachable and would self-loop).
  const childrenOf = new Map<number, BodyGene[]>();
  for (const g of body) {
    if (g.parent === -1 || g.parent === g.id) continue;
    const list = childrenOf.get(g.parent);
    if (list) list.push(g);
    else childrenOf.set(g.parent, [g]);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.id - b.id);

  // Root: parent === -1 (smallest id wins defensively; contract has one).
  let root: BodyGene | null = null;
  for (const g of body) {
    if (g.parent === -1 && (root === null || g.id < root.id)) root = g;
  }
  if (root === null) return finalize(parts, 0, 0);

  /** Append one part grown from `gene` onto parts[parentIndex] (-1 = root). */
  const addPart = (gene: BodyGene, parentIndex: number, mirrored: boolean): number => {
    const index = parts.length;
    const sx = clamp(gene.size.x * organism.sizeScale, MIN_PART_DIM, MAX_PART_DIM);
    const sy = clamp(gene.size.y * organism.sizeScale, MIN_PART_DIM, MAX_PART_DIM);
    const sz = clamp(gene.size.z * organism.sizeScale, MIN_PART_DIM, MAX_PART_DIM);
    const size: Vec3 = { x: sx, y: sy, z: sz };
    const volume = partVolume(gene.shape, size);
    const mass = volume * TISSUE_DENSITY * gene.density;
    const self = halfExtents(gene.shape, size);
    const isRoot = parentIndex < 0;

    let anchorOnParent: Vec3 = { x: 0, y: 0, z: 0 };
    let anchorOnSelf: Vec3 = { x: 0, y: 0, z: 0 };
    let rotation: Vec3 = { x: 0, y: 0, z: 0 };
    if (!isRoot) {
      const parent = parts[parentIndex];
      const ph = halfExtents(parent.shape, parent.size);
      const mx = mirrored ? -1 : 1;
      anchorOnParent = {
        x: clamp(gene.anchor.x, -1, 1) * mx * ph.x,
        y: clamp(gene.anchor.y, -1, 1) * ph.y,
        z: clamp(gene.anchor.z, -1, 1) * ph.z,
      };
      anchorOnSelf = { x: 0, y: self.y, z: 0 }; // hang from own local +y top
      rotation = mirrored
        ? { x: gene.rotation.x, y: -gene.rotation.y, z: -gene.rotation.z }
        : { ...gene.rotation };
    }

    const axis = normOrX(gene.jointAxis);
    const jointAxis: Vec3 = mirrored ? { x: axis.x, y: -axis.y, z: -axis.z } : axis;
    const jointLimits: [number, number] = [
      Math.min(0, gene.jointLimits[0]),
      Math.max(0, gene.jointLimits[1]),
    ];

    // Eyes: fan around eyeDir about local Y; whole-body ray budget.
    const wanted = clamp(Math.floor(gene.eyes), 0, MAX_EYES_PER_PART);
    const n = Math.min(wanted, eyeBudget);
    eyeBudget -= n;
    const eyes: PlanEye[] = [];
    if (n > 0) {
      const b = normOrX(gene.eyeDir);
      const base: Vec3 = mirrored ? { x: -b.x, y: b.y, z: b.z } : b;
      for (let k = 0; k < n; k++) {
        eyes.push({ dir: rotateY(base, (k - (n - 1) / 2) * EYE_FOV_SPREAD) });
      }
    }

    parts.push({
      index,
      geneId: gene.id,
      parentIndex,
      shape: gene.shape,
      size,
      anchorOnParent,
      anchorOnSelf,
      rotation,
      jointAxis,
      jointLimits,
      maxTorque: clamp(gene.muscle, 0, 1) * MUSCLE_TORQUE_PER_VOLUME * volume,
      volume,
      mass,
      eyes,
      smell: gene.smell,
      mouth: gene.mouth,
      color: [gene.color[0], gene.color[1], gene.color[2]],
      patternFreq: gene.patternFreq,
      patternAmp: gene.patternAmp,
    });
    return index;
  };

  /**
   * Grow the (1 + recursion)-copy chain of `gene` under parts[parentIndex];
   * returns the tip part index, or -1 when the part cap left no room.
   */
  const growChain = (gene: BodyGene, parentIndex: number, mirrored: boolean): number => {
    const copies = 1 + clamp(Math.floor(gene.recursion), 0, MAX_RECURSION);
    let tip = -1;
    let parent = parentIndex;
    for (let i = 0; i < copies && parts.length < MAX_PARTS; i++) {
      tip = addPart(gene, parent, mirrored);
      parent = tip;
    }
    return tip;
  };

  addPart(root, -1, false);
  const queue: Expansion[] = (childrenOf.get(root.id) ?? []).map((gene) => ({
    gene,
    parentIndex: 0,
    mirrored: false,
  }));

  for (let qi = 0; qi < queue.length && parts.length < MAX_PARTS; qi++) {
    const { gene, parentIndex, mirrored } = queue[qi];
    const branches: { tip: number; mirrored: boolean }[] = [];
    const tip = growChain(gene, parentIndex, mirrored);
    if (tip >= 0) branches.push({ tip, mirrored });
    if (gene.mirror) {
      const mTip = growChain(gene, parentIndex, !mirrored);
      if (mTip >= 0) branches.push({ tip: mTip, mirrored: !mirrored });
    }
    const kids = childrenOf.get(gene.id) ?? [];
    for (const branch of branches) {
      for (const kid of kids) {
        queue.push({ gene: kid, parentIndex: branch.tip, mirrored: branch.mirrored });
      }
    }
  }

  let totalMass = 0;
  let totalVolume = 0;
  for (const p of parts) {
    totalMass += p.mass;
    totalVolume += p.volume;
  }
  return finalize(parts, totalMass, totalVolume);
}

/** Assemble the plan: IO layout, labels and viability from the grown parts. */
function finalize(parts: PlanPart[], totalMass: number, totalVolume: number): BodyPlan {
  const inputLabels: string[] = [];
  const outputLabels: string[] = [];
  let ray = 0;
  let hasMouth = false;
  for (const p of parts) {
    inputLabels.push(`touch:${p.index}`);
    for (let e = 0; e < p.eyes.length; e++) {
      inputLabels.push(`eye${ray}.dist`, `eye${ray}.r`, `eye${ray}.g`, `eye${ray}.b`);
      ray++;
    }
    if (p.smell) {
      inputLabels.push(
        `smell${p.index}.plant`,
        `smell${p.index}.plantFwd`,
        `smell${p.index}.carrion`,
        `smell${p.index}.carrionFwd`,
      );
    }
    if (p.parentIndex !== -1) outputLabels.push(`joint:${p.index}`);
    if (p.mouth) hasMouth = true;
  }
  inputLabels.push(...INTERNAL_LABELS);

  // Layout invariant (D17): touch + EYE_INPUTS per ray + SMELL_INPUTS per
  // smelling part + INTERNAL_INPUTS. INTERNAL_LABELS must stay in sync.
  const smellParts = parts.reduce((acc, p) => acc + (p.smell ? 1 : 0), 0);
  const numInputs =
    parts.length + ray * EYE_INPUTS + smellParts * SMELL_INPUTS + INTERNAL_INPUTS;
  if (numInputs !== inputLabels.length) {
    throw new Error(`development: IO layout mismatch (${numInputs} != ${inputLabels.length})`);
  }

  return {
    parts,
    totalMass,
    totalVolume,
    numJoints: Math.max(0, parts.length - 1),
    numInputs,
    numOutputs: outputLabels.length,
    inputLabels,
    outputLabels,
    viable: parts.length >= 2 && hasMouth && totalMass > 0,
  };
}
