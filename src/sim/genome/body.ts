/**
 * Body-genome operations (DECISIONS.md D2, D12): random founder generation,
 * point/structural mutation, fitter-parent-aligned crossover and normalized
 * genetic distance over the heritable directed body graph.
 *
 * Pure module: imports only from `shared`, all randomness flows through the
 * RNG passed in, every function leaves its inputs untouched.
 *
 * Graph invariants maintained by every exported function:
 *  - exactly one root gene with `parent === -1` (randomBodyGenes puts it at
 *    index 0; mutation never deletes or re-parents it),
 *  - gene ids unique (fresh ids come only from the caller's `nextGeneId`),
 *  - every non-root `parent` names another gene in the genome, acyclically,
 *  - total genes <= MAX_BODY_GENES,
 *  - every field inside its documented range (see types.ts / constants.ts).
 */
import type { BodyGene, OrganismGenes, Vec3 } from '../../shared/types';
import { RNG } from '../../shared/rng';
import {
  MAX_BODY_GENES,
  MAX_EYES_PER_PART,
  MAX_PART_DIM,
  MAX_RECURSION,
  MIN_PART_DIM,
  MUT_BODY_DEL_P,
  MUT_BODY_DUP_P,
  MUT_BODY_POINT_P,
  MUT_ORGANISM_P,
  MUT_ORGANISM_SD,
} from '../../shared/constants';

// ----------------------- module-local range constants ----------------------
// These ranges are documented in types.ts prose but have no named constant in
// shared/constants.ts, so they are pinned here (reported in contractIssues).

/** Joint limit magnitude cap: lo in [-JOINT_LIMIT_MAX, 0], hi in [0, JOINT_LIMIT_MAX] rad. */
const JOINT_LIMIT_MAX = 2.4;
/** BodyGene.density range (multiplier on TISSUE_DENSITY). */
const DENSITY_MIN = 0.6;
const DENSITY_MAX = 1.6;
/** BodyGene.patternFreq range. */
const PATTERN_FREQ_MIN = 1;
const PATTERN_FREQ_MAX = 12;
/** Rest-rotation euler components clamp to [-PI, PI]. */
const ROT_MAX = Math.PI;
/** OrganismGenes ranges (types.ts doc-comments). */
const ORG_OFFSPRING_MIN = 0.15;
const ORG_OFFSPRING_MAX = 0.6;
const ORG_SIZESCALE_MIN = 0.6;
const ORG_SIZESCALE_MAX = 1.8;
/** Founder gutHerbivory floor: founders must survive on plants (carnivory evolves). */
const FOUNDER_HERBIVORY_MIN = 0.35;

/** Per-genome probability of each rare discrete flip (mirror/mouth/smell/shape). */
const MUT_FLIP_P = 0.03;
/** Point-mutation gaussian sd, as a fraction of the mutated field's range. */
const POINT_SD_FRAC = 0.12;
/** Jitter fraction applied to a duplicated gene so copies diverge. */
const DUP_JITTER_FRAC = 0.05;
/**
 * Weight of the parametric term in bodyDistance. Mean normalized per-field
 * difference of two unrelated uniform genes is ~0.35, so x3 places typical
 * unrelated genomes with matching ids near 1; fully disjoint genomes reach
 * ~2 through the structural term alone.
 */
const DIST_PARAM_SCALE = 3;

// --------------------------------- helpers ---------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function copyVec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** Normalize; a degenerate (near-zero) vector falls back to +X. */
function normalize(v: Vec3): Vec3 {
  const n = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (n < 1e-9) return { x: 1, y: 0, z: 0 };
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

/** Random unit vector, uniform on the sphere (gaussian components normalized). */
function randUnit(rng: RNG): Vec3 {
  return normalize({ x: rng.gaussian(), y: rng.gaussian(), z: rng.gaussian() });
}

/** Deep copy of one gene (all nested vectors/tuples fresh). */
function copyGene(g: BodyGene): BodyGene {
  return {
    id: g.id,
    parent: g.parent,
    shape: g.shape,
    size: copyVec(g.size),
    density: g.density,
    anchor: copyVec(g.anchor),
    rotation: copyVec(g.rotation),
    jointAxis: copyVec(g.jointAxis),
    jointLimits: [g.jointLimits[0], g.jointLimits[1]],
    muscle: g.muscle,
    recursion: g.recursion,
    mirror: g.mirror,
    eyes: g.eyes,
    eyeDir: copyVec(g.eyeDir),
    smell: g.smell,
    mouth: g.mouth,
    color: [g.color[0], g.color[1], g.color[2]],
    patternFreq: g.patternFreq,
    patternAmp: g.patternAmp,
  };
}

function randomGene(rng: RNG, id: number, parent: number): BodyGene {
  return {
    id,
    parent,
    shape: rng.chance(0.5) ? 'capsule' : 'box',
    size: {
      x: rng.range(MIN_PART_DIM, MAX_PART_DIM),
      y: rng.range(MIN_PART_DIM, MAX_PART_DIM),
      z: rng.range(MIN_PART_DIM, MAX_PART_DIM),
    },
    density: rng.range(DENSITY_MIN, DENSITY_MAX),
    anchor: { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) },
    rotation: {
      x: rng.range(-ROT_MAX, ROT_MAX),
      y: rng.range(-ROT_MAX, ROT_MAX),
      z: rng.range(-ROT_MAX, ROT_MAX),
    },
    jointAxis: randUnit(rng),
    jointLimits: [rng.range(-JOINT_LIMIT_MAX, 0), rng.range(0, JOINT_LIMIT_MAX)],
    muscle: rng.range(0, 1),
    recursion: rng.chance(0.25) ? 1 + rng.int(MAX_RECURSION) : 0,
    mirror: rng.chance(0.4),
    eyes: rng.chance(0.45) ? 1 + rng.int(MAX_EYES_PER_PART) : 0,
    eyeDir: randUnit(rng),
    smell: rng.chance(0.3),
    mouth: rng.chance(0.35),
    color: [rng.next(), rng.next(), rng.next()],
    patternFreq: rng.range(PATTERN_FREQ_MIN, PATTERN_FREQ_MAX),
    patternAmp: rng.range(0, 1),
  };
}

// ------------------------------ random genomes ------------------------------

/**
 * Random founder body graph of 2–4 genes. Gene at index 0 is the root
 * (torso, parent = -1); every later gene parents onto an earlier one, so the
 * graph is a tree by construction. Guarantees at least one mouth-bearing gene
 * and one gene with eyes >= 1 (founders must be able to eat and see; those
 * traits may be lost later only through mutation). Ids come from `nextGeneId`.
 */
export function randomBodyGenes(rng: RNG, nextGeneId: () => number): BodyGene[] {
  const count = 2 + rng.int(3); // 2..4
  const genes: BodyGene[] = [];
  for (let i = 0; i < count; i++) {
    const parent = i === 0 ? -1 : genes[rng.int(genes.length)].id;
    genes.push(randomGene(rng, nextGeneId(), parent));
  }
  if (!genes.some((g) => g.mouth)) genes[rng.int(genes.length)].mouth = true;
  if (!genes.some((g) => g.eyes >= 1)) genes[rng.int(genes.length)].eyes = 1 + rng.int(MAX_EYES_PER_PART);
  return genes;
}

/**
 * Random founder organism genes. gutHerbivory is biased herbivorous
 * (uniform 0.35..1) so founders can live on plants — carnivory must evolve.
 * Other genes uniform over their documented ranges.
 */
export function randomOrganism(rng: RNG): OrganismGenes {
  return {
    gutHerbivory: rng.range(FOUNDER_HERBIVORY_MIN, 1),
    sexual: rng.range(0, 1),
    offspringEnergyFrac: rng.range(ORG_OFFSPRING_MIN, ORG_OFFSPRING_MAX),
    sizeScale: rng.range(ORG_SIZESCALE_MIN, ORG_SIZESCALE_MAX),
  };
}

// --------------------------------- mutation ---------------------------------

/** One point-mutation target: jitters a single field of `g`, staying in range. */
type FieldMutator = (g: BodyGene, rng: RNG) => void;

const SIZE_RANGE = MAX_PART_DIM - MIN_PART_DIM;

/** Jitter one component of a Vec3, clamped to [lo, hi]. */
function jitterVecComp(v: Vec3, rng: RNG, lo: number, hi: number): void {
  const sd = (hi - lo) * POINT_SD_FRAC;
  const k = rng.int(3);
  if (k === 0) v.x = clamp(v.x + rng.gaussian(0, sd), lo, hi);
  else if (k === 1) v.y = clamp(v.y + rng.gaussian(0, sd), lo, hi);
  else v.z = clamp(v.z + rng.gaussian(0, sd), lo, hi);
}

/** Jitter all components of a unit vector then renormalize. */
function jitterUnit(v: Vec3, rng: RNG): Vec3 {
  return normalize({
    x: v.x + rng.gaussian(0, 0.25),
    y: v.y + rng.gaussian(0, 0.25),
    z: v.z + rng.gaussian(0, 0.25),
  });
}

const FIELD_MUTATORS: readonly FieldMutator[] = [
  (g, rng) => jitterVecComp(g.size, rng, MIN_PART_DIM, MAX_PART_DIM),
  (g, rng) => {
    g.density = clamp(g.density + rng.gaussian(0, (DENSITY_MAX - DENSITY_MIN) * POINT_SD_FRAC), DENSITY_MIN, DENSITY_MAX);
  },
  (g, rng) => jitterVecComp(g.anchor, rng, -1, 1),
  (g, rng) => jitterVecComp(g.rotation, rng, -ROT_MAX, ROT_MAX),
  (g, rng) => {
    g.jointAxis = jitterUnit(g.jointAxis, rng);
  },
  (g, rng) => {
    const sd = JOINT_LIMIT_MAX * POINT_SD_FRAC;
    if (rng.chance(0.5)) g.jointLimits[0] = clamp(g.jointLimits[0] + rng.gaussian(0, sd), -JOINT_LIMIT_MAX, 0);
    else g.jointLimits[1] = clamp(g.jointLimits[1] + rng.gaussian(0, sd), 0, JOINT_LIMIT_MAX);
  },
  (g, rng) => {
    g.muscle = clamp(g.muscle + rng.gaussian(0, POINT_SD_FRAC), 0, 1);
  },
  (g, rng) => {
    g.recursion = clamp(g.recursion + (rng.chance(0.5) ? 1 : -1), 0, MAX_RECURSION);
  },
  (g, rng) => {
    g.eyes = clamp(g.eyes + (rng.chance(0.5) ? 1 : -1), 0, MAX_EYES_PER_PART);
  },
  (g, rng) => {
    g.eyeDir = jitterUnit(g.eyeDir, rng);
  },
  (g, rng) => {
    const i = rng.int(3);
    g.color[i] = clamp(g.color[i] + rng.gaussian(0, POINT_SD_FRAC), 0, 1);
  },
  (g, rng) => {
    g.patternFreq = clamp(
      g.patternFreq + rng.gaussian(0, (PATTERN_FREQ_MAX - PATTERN_FREQ_MIN) * POINT_SD_FRAC),
      PATTERN_FREQ_MIN,
      PATTERN_FREQ_MAX,
    );
  },
  (g, rng) => {
    g.patternAmp = clamp(g.patternAmp + rng.gaussian(0, POINT_SD_FRAC), 0, 1);
  },
];

/** Small gaussian jitter over continuous fields; used on duplicated genes so copies diverge. */
function jitterGene(g: BodyGene, rng: RNG, frac: number): void {
  const j = (v: number, lo: number, hi: number): number => clamp(v + rng.gaussian(0, (hi - lo) * frac), lo, hi);
  g.size.x = j(g.size.x, MIN_PART_DIM, MAX_PART_DIM);
  g.size.y = j(g.size.y, MIN_PART_DIM, MAX_PART_DIM);
  g.size.z = j(g.size.z, MIN_PART_DIM, MAX_PART_DIM);
  g.anchor.x = j(g.anchor.x, -1, 1);
  g.anchor.y = j(g.anchor.y, -1, 1);
  g.anchor.z = j(g.anchor.z, -1, 1);
  g.rotation.x = j(g.rotation.x, -ROT_MAX, ROT_MAX);
  g.rotation.y = j(g.rotation.y, -ROT_MAX, ROT_MAX);
  g.rotation.z = j(g.rotation.z, -ROT_MAX, ROT_MAX);
  g.muscle = j(g.muscle, 0, 1);
  g.color[0] = j(g.color[0], 0, 1);
  g.color[1] = j(g.color[1], 0, 1);
  g.color[2] = j(g.color[2], 0, 1);
}

/**
 * Mutated deep copy of a body genome; the input array and its genes are never
 * touched. Applies, independently:
 *  - with MUT_BODY_POINT_P: one gaussian point mutation on one field of one
 *    random gene (clamped to its documented range),
 *  - with MUT_FLIP_P each: flip mirror / mouth / smell / shape on a random
 *    gene (deletion and flips may remove mouths — selection handles it),
 *  - with MUT_BODY_DUP_P: duplicate a random non-root gene under the same
 *    parent with a fresh id from `nextGeneId` and slight jitter (parenting
 *    onto a pre-existing gene can never create a cycle),
 *  - with MUT_BODY_DEL_P: delete a random non-root leaf gene (one no other
 *    gene uses as parent). The root is never deleted.
 * Total genes stay <= MAX_BODY_GENES.
 */
export function mutateBody(genes: BodyGene[], rng: RNG, nextGeneId: () => number): BodyGene[] {
  const out = genes.map(copyGene);
  if (out.length === 0) return out;

  if (rng.chance(MUT_BODY_POINT_P)) {
    const g = out[rng.int(out.length)];
    FIELD_MUTATORS[rng.int(FIELD_MUTATORS.length)](g, rng);
  }

  if (rng.chance(MUT_FLIP_P)) {
    const g = out[rng.int(out.length)];
    g.mirror = !g.mirror;
  }
  if (rng.chance(MUT_FLIP_P)) {
    const g = out[rng.int(out.length)];
    g.mouth = !g.mouth;
  }
  if (rng.chance(MUT_FLIP_P)) {
    const g = out[rng.int(out.length)];
    g.smell = !g.smell;
  }
  if (rng.chance(MUT_FLIP_P)) {
    const g = out[rng.int(out.length)];
    g.shape = g.shape === 'box' ? 'capsule' : 'box';
  }

  if (out.length < MAX_BODY_GENES && rng.chance(MUT_BODY_DUP_P)) {
    const nonRoot = out.filter((g) => g.parent !== -1);
    if (nonRoot.length > 0) {
      const dup = copyGene(nonRoot[rng.int(nonRoot.length)]);
      dup.id = nextGeneId();
      jitterGene(dup, rng, DUP_JITTER_FRAC);
      out.push(dup);
    }
  }

  if (rng.chance(MUT_BODY_DEL_P)) {
    const leaves = out.filter((g) => g.parent !== -1 && !out.some((o) => o.parent === g.id));
    if (leaves.length > 0) {
      out.splice(out.indexOf(leaves[rng.int(leaves.length)]), 1);
    }
  }

  return out;
}

/**
 * Mutated copy of the organism genes (input untouched). Each gene is
 * independently jittered with probability MUT_ORGANISM_P by a gaussian of
 * sd = MUT_ORGANISM_SD x its range width, clamped to the documented range
 * (gutHerbivory 0..1, sexual 0..1, offspringEnergyFrac 0.15..0.6,
 * sizeScale 0.6..1.8).
 */
export function mutateOrganism(o: OrganismGenes, rng: RNG): OrganismGenes {
  const out: OrganismGenes = { ...o };
  if (rng.chance(MUT_ORGANISM_P)) {
    out.gutHerbivory = clamp(out.gutHerbivory + rng.gaussian(0, MUT_ORGANISM_SD), 0, 1);
  }
  if (rng.chance(MUT_ORGANISM_P)) {
    out.sexual = clamp(out.sexual + rng.gaussian(0, MUT_ORGANISM_SD), 0, 1);
  }
  if (rng.chance(MUT_ORGANISM_P)) {
    const sd = MUT_ORGANISM_SD * (ORG_OFFSPRING_MAX - ORG_OFFSPRING_MIN);
    out.offspringEnergyFrac = clamp(out.offspringEnergyFrac + rng.gaussian(0, sd), ORG_OFFSPRING_MIN, ORG_OFFSPRING_MAX);
  }
  if (rng.chance(MUT_ORGANISM_P)) {
    const sd = MUT_ORGANISM_SD * (ORG_SIZESCALE_MAX - ORG_SIZESCALE_MIN);
    out.sizeScale = clamp(out.sizeScale + rng.gaussian(0, sd), ORG_SIZESCALE_MIN, ORG_SIZESCALE_MAX);
  }
  return out;
}

// -------------------------------- crossover ---------------------------------

/** Per-field 50/50 mix of two genes that share an id. Deep copies either source. */
function mixGenes(ga: BodyGene, gb: BodyGene, rng: RNG): BodyGene {
  const p = (): boolean => rng.chance(0.5);
  return {
    id: ga.id,
    // a's root stays the root; other genes may inherit b's parent link,
    // repaired afterwards if it names a missing gene or forms a cycle.
    parent: ga.parent === -1 ? -1 : p() ? ga.parent : gb.parent,
    shape: p() ? ga.shape : gb.shape,
    size: copyVec(p() ? ga.size : gb.size),
    density: p() ? ga.density : gb.density,
    anchor: copyVec(p() ? ga.anchor : gb.anchor),
    rotation: copyVec(p() ? ga.rotation : gb.rotation),
    jointAxis: copyVec(p() ? ga.jointAxis : gb.jointAxis),
    jointLimits: p() ? [ga.jointLimits[0], ga.jointLimits[1]] : [gb.jointLimits[0], gb.jointLimits[1]],
    muscle: p() ? ga.muscle : gb.muscle,
    recursion: p() ? ga.recursion : gb.recursion,
    mirror: p() ? ga.mirror : gb.mirror,
    eyes: p() ? ga.eyes : gb.eyes,
    eyeDir: copyVec(p() ? ga.eyeDir : gb.eyeDir),
    smell: p() ? ga.smell : gb.smell,
    mouth: p() ? ga.mouth : gb.mouth,
    color: p() ? [ga.color[0], ga.color[1], ga.color[2]] : [gb.color[0], gb.color[1], gb.color[2]],
    patternFreq: p() ? ga.patternFreq : gb.patternFreq,
    patternAmp: p() ? ga.patternAmp : gb.patternAmp,
  };
}

/**
 * Re-establish graph invariants in place after crossover: the gene with
 * `rootId` is the unique root (parent = -1); every other gene's parent must
 * name an existing gene and reach the root acyclically, else it is
 * re-parented to the root.
 */
function repairParents(genes: BodyGene[], rootId: number): void {
  const ids = new Set(genes.map((g) => g.id));
  const byId = new Map(genes.map((g) => [g.id, g]));
  for (const g of genes) {
    if (g.id === rootId) {
      g.parent = -1;
      continue;
    }
    if (g.parent === -1 || g.parent === g.id || !ids.has(g.parent)) g.parent = rootId;
  }
  for (const g of genes) {
    if (g.id === rootId) continue;
    const seen = new Set<number>([g.id]);
    let cur = g;
    for (;;) {
      if (cur.parent === -1) break; // reached the root: chain is fine
      if (seen.has(cur.parent)) {
        g.parent = rootId; // cycle through g's chain: cut g over to the root
        break;
      }
      seen.add(cur.parent);
      cur = byId.get(cur.parent)!;
    }
  }
}

/**
 * Sexual body crossover keyed by the fitter parent `a` (convention): the
 * child has exactly a's gene ids. A gene id also present in `b` mixes fields
 * 50/50 per field; a-only genes are copied from a. Parent links broken by
 * mixing (missing id, cycle) are repaired to a valid ancestor, falling back
 * to a's root. Inputs are never modified.
 */
export function crossoverBody(a: BodyGene[], b: BodyGene[], rng: RNG): BodyGene[] {
  const bById = new Map(b.map((g) => [g.id, g]));
  const root = a.find((g) => g.parent === -1) ?? a[0];
  const child = a.map((ga) => {
    const gb = bById.get(ga.id);
    return gb ? mixGenes(ga, gb, rng) : copyGene(ga);
  });
  repairParents(child, root.id);
  return child;
}

// --------------------------------- distance ---------------------------------

const TWO_PI = Math.PI * 2;

/** Mean normalized per-field difference of two genes sharing an id; each term in [0,1]. */
function geneFieldDiff(a: BodyGene, b: BodyGene): number {
  const vecDiff = (u: Vec3, v: Vec3, range: number): number =>
    (Math.abs(u.x - v.x) + Math.abs(u.y - v.y) + Math.abs(u.z - v.z)) / (3 * range);
  let s = 0;
  s += vecDiff(a.size, b.size, SIZE_RANGE);
  s += vecDiff(a.anchor, b.anchor, 2);
  s += vecDiff(a.rotation, b.rotation, TWO_PI);
  s += vecDiff(a.jointAxis, b.jointAxis, 2);
  s += (Math.abs(a.jointLimits[0] - b.jointLimits[0]) + Math.abs(a.jointLimits[1] - b.jointLimits[1])) / (2 * JOINT_LIMIT_MAX);
  s += Math.abs(a.muscle - b.muscle);
  s += Math.abs(a.recursion - b.recursion) / MAX_RECURSION;
  s += a.shape === b.shape ? 0 : 1;
  s += a.mirror === b.mirror ? 0 : 1;
  s += a.mouth === b.mouth ? 0 : 1;
  s += a.smell === b.smell ? 0 : 1;
  s += (Math.abs(a.color[0] - b.color[0]) + Math.abs(a.color[1] - b.color[1]) + Math.abs(a.color[2] - b.color[2])) / 3;
  return s / 12;
}

/**
 * Normalized structural + parametric distance between two body genomes.
 * Structural: (ids only in a + ids only in b) / max gene count (0..2).
 * Parametric: mean geneFieldDiff over id-matched genes x DIST_PARAM_SCALE.
 * Symmetric, >= 0, exactly 0 for identical genomes; typical unrelated
 * genomes land around 1–2.
 */
export function bodyDistance(a: BodyGene[], b: BodyGene[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const aIds = new Set(a.map((g) => g.id));
  const bById = new Map(b.map((g) => [g.id, g]));
  let onlyA = 0;
  for (const g of a) if (!bById.has(g.id)) onlyA++;
  let onlyB = 0;
  for (const g of b) if (!aIds.has(g.id)) onlyB++;
  const structural = (onlyA + onlyB) / Math.max(a.length, b.length);

  let sum = 0;
  let matches = 0;
  for (const ga of a) {
    const gb = bById.get(ga.id);
    if (!gb) continue;
    sum += geneFieldDiff(ga, gb);
    matches++;
  }
  const parametric = matches > 0 ? (sum / matches) * DIST_PARAM_SCALE : 0;
  return structural + parametric;
}
