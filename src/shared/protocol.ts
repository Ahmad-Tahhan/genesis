/**
 * Worker <-> main-thread protocol. Snapshots are Float32Array buffers moved
 * with transfer semantics; everything else is structured-clone JSON.
 */
import type {
  CreatureDetail,
  CreatureInfo,
  DeathCause,
  PhyloNode,
  SimEvent,
  TerrainData,
  Vec3,
  WorldStats,
} from './types';

// ============================ messages ====================================

export type Speed = 0 | 1 | 10 | -1; // -1 = max (no rendering snapshots)

export type MainToWorker =
  | { type: 'init'; seed: number }
  | { type: 'setSpeed'; speed: Speed }
  | { type: 'select'; creatureId: number | null }
  | { type: 'pick'; origin: Vec3; dir: Vec3 }
  | { type: 'queryPhylo' }
  | { type: 'queryHistory' }
  | { type: 'returnBuffer'; buffer: ArrayBuffer };

export type WorkerToMain =
  | { type: 'ready'; terrain: TerrainData; seed: number }
  | { type: 'birth'; creature: CreatureInfo }
  | { type: 'death'; id: number; cause: DeathCause }
  | { type: 'snapshot'; buffer: ArrayBuffer }
  | { type: 'plants'; buffer: ArrayBuffer }
  | { type: 'stats'; stats: WorldStats }
  | { type: 'events'; events: SimEvent[] }
  | { type: 'inspect'; detail: CreatureDetail | null }
  | { type: 'phylo'; nodes: PhyloNode[] }
  | { type: 'history'; series: HistorySeries }
  | { type: 'picked'; id: number | null };

/** Population history for charts: parallel arrays per species id. */
export interface HistorySeries {
  ticks: number[];
  /** speciesId -> counts aligned with ticks (0 where absent). */
  series: { id: number; name: string; hue: number; counts: number[] }[];
  plantBiomass: number[];
}

// ======================= creature snapshot buffer =========================
// Layout (Float32):
// [0] time
// [1] creatureCount
// then per creature:
//   id, partCount, then per part: px py pz qx qy qz qw
// Trailing header slot [2] = sunAngle (radians), [3] = season phase 0..1.

export const SNAP_HEADER = 4;
export const PART_FLOATS = 7;

export function creatureSnapshotSize(parts: number[]): number {
  let n = SNAP_HEADER;
  for (const p of parts) n += 2 + p * PART_FLOATS;
  return n;
}

// ========================= plant snapshot buffer ==========================
// [0] plantCount, then per plant: x, y, z, scale(0..1), phase, hueShift
export const PLANT_FLOATS = 6;
export const PLANT_HEADER = 1;

export function plantSnapshotSize(count: number): number {
  return PLANT_HEADER + count * PLANT_FLOATS;
}
