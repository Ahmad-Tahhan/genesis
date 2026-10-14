/**
 * Shared type contract between the simulation worker, the renderer, the UI,
 * and the tests. Implementation modules import from here and must not edit
 * this file (see DECISIONS.md D16).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ============================= GENOME =====================================

export type PartShape = 'capsule' | 'box';

/**
 * One node of the developmental body graph. Development walks the graph from
 * the root gene, expanding `recursion` chain repeats and `mirror` copies,
 * capped at MAX_PARTS parts.
 */
export interface BodyGene {
  /** Unique within the genome; stable across mutations (duplication assigns a fresh id). */
  id: number;
  /** Gene id of parent in the graph; -1 for the root gene. */
  parent: number;
  shape: PartShape;
  /** Box: half extents. Capsule: x = radius, y = half height (z ignored). Meters, pre sizeScale. */
  size: Vec3;
  /** Density multiplier (0.6..1.6) on TISSUE_DENSITY. */
  density: number;
  /** Attachment point on the parent part in normalized local coords (each component -1..1). */
  anchor: Vec3;
  /** Euler XYZ (radians) orienting this part relative to its parent at rest. */
  rotation: Vec3;
  /** Revolute joint axis in the child part's local frame (normalized at development). */
  jointAxis: Vec3;
  /** [lo, hi] radians, lo <= 0 <= hi enforced at development. */
  jointLimits: [number, number];
  /** Muscle strength 0..1; max torque = muscle * MUSCLE_TORQUE_PER_VOLUME * part volume. */
  muscle: number;
  /** Chain repeats of this gene (0..MAX_RECURSION). */
  recursion: number;
  /** Also grow a copy mirrored across the parent's local X. */
  mirror: boolean;
  /** Number of vision rays rooted on this part (0..MAX_EYES_PER_PART). */
  eyes: number;
  /** Base eye direction in part-local coords; rays fan around it. */
  eyeDir: Vec3;
  /** This part carries a smell organ. */
  smell: boolean;
  /** This part's tip can bite/graze. */
  mouth: boolean;
  /** HSL pigment genes, each 0..1. */
  color: [number, number, number];
  /** Procedural skin pattern parameters. */
  patternFreq: number;
  patternAmp: number;
}

/** Whole-organism scalar genes. */
export interface OrganismGenes {
  /** 0..1. 1 = fully herbivorous gut, 0 = fully carnivorous (efficiency trade-off). */
  gutHerbivory: number;
  /** 0..1 preference for sexual reproduction when mates are near. */
  sexual: number;
  /** Fraction of energy store endowed to each offspring (0.15..0.6). */
  offspringEnergyFrac: number;
  /** Global body scale multiplier (0.6..1.8). */
  sizeScale: number;
}

export type Activation = 'tanh' | 'sin' | 'relu' | 'gauss';

export interface NodeGene {
  id: number;
  type: 'in' | 'hid' | 'out';
  act: Activation;
}

export interface ConnGene {
  /** Global innovation number (crossover alignment). */
  innov: number;
  from: number;
  to: number;
  w: number;
  on: boolean;
}

export interface BrainGenome {
  nodes: NodeGene[];
  conns: ConnGene[];
  /** Next free node id within this genome. */
  nextNode: number;
}

export interface Genome {
  body: BodyGene[];
  organism: OrganismGenes;
  brain: BrainGenome;
  generation: number;
}

// ======================== DEVELOPED BODY PLAN =============================

export interface PlanEye {
  /** Unit direction, part-local. */
  dir: Vec3;
}

export interface PlanPart {
  /** 0 = root; parts are in deterministic development order. */
  index: number;
  geneId: number;
  parentIndex: number; // -1 for root
  shape: PartShape;
  /** Final size after sizeScale and clamping (same convention as BodyGene.size). */
  size: Vec3;
  /** Attachment point on the parent, parent-local coords (meters). */
  anchorOnParent: Vec3;
  /** Attachment point on this part, own-local coords (meters). */
  anchorOnSelf: Vec3;
  /** Rest orientation relative to parent (euler XYZ, radians). */
  rotation: Vec3;
  /** Unit joint axis, own-local. */
  jointAxis: Vec3;
  jointLimits: [number, number];
  maxTorque: number;
  volume: number;
  mass: number;
  eyes: PlanEye[];
  smell: boolean;
  mouth: boolean;
  color: [number, number, number];
  patternFreq: number;
  patternAmp: number;
}

/**
 * Canonical brain IO layout (DECISIONS.md D17), derived purely from the plan:
 *  inputs:  per part in order: touch(1), then per eye ray: [dist, r, g, b],
 *           then if smell: [plantIntensity, plantGradFwd, carrionIntensity, carrionGradFwd];
 *  then internals: hunger, energyFrac, health, speed, upright, sinOsc, cosOsc, bias (8).
 *  outputs: one motor target per non-root part (joint), in part order.
 */
export interface BodyPlan {
  parts: PlanPart[];
  totalMass: number;
  totalVolume: number;
  numJoints: number;
  numInputs: number;
  numOutputs: number;
  inputLabels: string[];
  outputLabels: string[];
  /** True if development produced a viable body (root + >=1 joint, mouth somewhere). */
  viable: boolean;
}

export const INTERNAL_INPUTS = 8;
export const EYE_INPUTS = 4;
export const SMELL_INPUTS = 4;

// ============================ SPECIES =====================================

export interface SpeciesRecord {
  id: number;
  /** Procedurally generated binomial-ish name. */
  name: string;
  parentId: number; // -1 for founder lineages
  bornTick: number;
  extinctTick: number | null;
  /** Display color (hue 0..1) derived from founding genome pigment. */
  hue: number;
  population: number;
  peakPopulation: number;
  /** Mean trait summary of current members (updated with stats). */
  traits: SpeciesTraits;
}

export interface SpeciesTraits {
  meanMass: number;
  meanHerbivory: number;
  meanSpeed: number;
  meanBrainSize: number;
  meanParts: number;
}

export interface PhyloNode {
  id: number;
  name: string;
  parentId: number;
  bornTick: number;
  extinctTick: number | null;
  hue: number;
  population: number;
  peakPopulation: number;
}

// ============================ EVENTS ======================================

export type SimEventKind =
  | 'birth'
  | 'death'
  | 'hunt'
  | 'kill'
  | 'speciesBorn'
  | 'speciesExtinct'
  | 'firstPredation'
  | 'massExtinction'
  | 'migration'
  | 'seasonChange'
  | 'matured';

export interface SimEvent {
  tick: number;
  kind: SimEventKind;
  /** World position of interest (for the documentary camera), if any. */
  pos?: Vec3;
  /** Creature ids involved (e.g. [predator, prey]). */
  actors?: number[];
  speciesId?: number;
  /** Extra payload (species name, cause of death, season index...). */
  data?: Record<string, string | number>;
  /** Interest score 0..1 for the documentary camera. */
  interest: number;
}

export type DeathCause = 'starved' | 'killed' | 'oldAge' | 'drowned';

// ======================== CREATURE (runtime views) ========================

/** Sent once on birth so the main thread can build meshes. */
export interface CreatureInfo {
  id: number;
  speciesId: number;
  generation: number;
  parents: number[]; // 1 (asexual) or 2 (sexual) creature ids; [] for seeded founders
  plan: BodyPlan;
  organism: OrganismGenes;
}

/** Live detail for the selected creature (~10 Hz). */
export interface CreatureDetail {
  id: number;
  speciesId: number;
  speciesName: string;
  generation: number;
  age: number;
  energy: number;
  energyCapacity: number;
  health: number;
  mass: number;
  dietPlant: number; // lifetime E ingested from plants
  dietMeat: number; // lifetime E ingested from meat
  parents: number[];
  childCount: number;
  brain: {
    nodes: { id: number; type: 'in' | 'hid' | 'out'; act: Activation; value: number; label?: string }[];
    conns: { from: number; to: number; w: number; on: boolean }[];
  };
  genome: Genome;
}

// ============================ TERRAIN =====================================

export interface TerrainData {
  /** (TERRAIN_RES+1)^2 heights, row-major (z-major), meters. */
  heights: Float32Array;
  res: number; // TERRAIN_RES
  size: number; // TERRAIN_SIZE
  waterLevel: number;
  /** Per-vertex fields, same layout as heights, 0..1. */
  moisture: Float32Array;
  fertility: Float32Array;
}

// ============================ STATS =======================================

export interface LedgerState {
  sunlightIn: number; // cumulative influx
  heatOut: number; // cumulative outflux
  soil: number;
  plants: number;
  seeds: number;
  creatures: number; // stores + biomass
  corpses: number;
}

export interface SpeciesStat {
  id: number;
  name: string;
  hue: number;
  count: number;
  meanHerbivory: number;
}

export interface WorldStats {
  tick: number;
  time: number;
  day: number;
  season: number; // 0..3
  year: number;
  population: number;
  plantCount: number;
  births: number;
  deaths: number;
  species: SpeciesStat[];
  ledger: LedgerState;
  /** Sim ticks per wall second (worker-side measure). */
  tps: number;
  climate: number; // current climate drift -1..1
}
