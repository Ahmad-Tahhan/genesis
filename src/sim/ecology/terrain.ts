/**
 * Procedural terrain: fBm simplex base shaped as a valley basin, droplet
 * hydraulic erosion (DECISIONS.md D6), lake water level, a carved river, and
 * derived moisture + fertility fields. Pure module: imports only from shared,
 * all randomness from the RNG passed in. Runs once at world init.
 *
 * Grid convention (shared contract): row-major, index = iz*(res+1)+ix,
 * world x = (ix/res - 0.5)*size, world z = (iz/res - 0.5)*size, y up, meters.
 */
import type { TerrainData, Vec3 } from '../../shared/types';
import type { RNG } from '../../shared/rng';
import { fbm2D, makeNoise2D } from '../../shared/noise';
import {
  EROSION_DROPLETS,
  TERRAIN_HEIGHT,
  TERRAIN_RES,
  TERRAIN_SIZE,
  WATER_LEVEL_FRAC,
} from '../../shared/constants';

/** TerrainData plus the carved river center line (world coords, y = channel bed). */
export interface TerrainResult extends TerrainData {
  riverPath: Vec3[];
}

// --- erosion tunables (grid units = cells, heights in meters) ---
const EROSION_INERTIA = 0.05;
const EROSION_CAPACITY = 4;
const EROSION_MIN_CAPACITY = 0.01;
const ERODE_SPEED = 0.3;
const DEPOSIT_SPEED = 0.3;
const EVAPORATE = 0.015;
const EROSION_GRAVITY = 4;
const DROPLET_LIFETIME = 30;
const BRUSH_RADIUS = 2;

// --- river tunables (meters) ---
const RIVER_BED_BELOW_WATER = 0.6; // channel bed starts this far below waterLevel
const RIVER_BED_STEP = 0.012; // per-point extra descent, floored below
const RIVER_BED_FLOOR_BELOW_WATER = 2.5;
const RIVER_HALF_WIDTH = 2.2; // full-depth channel half width
const RIVER_BLEND_RADIUS = 4.6; // carve influence fades to zero here
const RIVER_MIN_POINTS = 40;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Generate the full terrain: base fBm heights, hydraulic erosion, water level,
 * river carve, moisture and fertility. Deterministic for a given RNG state.
 */
export function generateTerrain(rng: RNG): TerrainResult {
  const res = TERRAIN_RES;
  const size = TERRAIN_SIZE;
  const n = res + 1;
  const count = n * n;

  // Fixed draw order keeps the whole pipeline reproducible from one seed.
  const baseNoise = makeNoise2D(Math.floor(rng.next() * 0xffffffff));
  const rainNoise = makeNoise2D(Math.floor(rng.next() * 0xffffffff));

  // 1. Base heights: fBm modulated by a basin profile — low center (future
  // lake), hills rising toward the rim, gentle falloff at the extreme edges.
  const heights = new Float32Array(count);
  for (let iz = 0; iz < n; iz++) {
    const nz = iz / res - 0.5;
    for (let ix = 0; ix < n; ix++) {
      const nx = ix / res - 0.5;
      const f01 = 0.5 * (fbm2D(baseNoise, nx * 3.1, nz * 3.1, 5) + 1);
      const r = Math.hypot(nx, nz) * 2; // 0 center, 1 edge midpoint, ~1.41 corner
      const rim = smoothstep(0.14, 0.8, r);
      const edgeFall = 1 - 0.5 * smoothstep(0.92, 1.3, r);
      const shape = (0.12 + 0.88 * rim) * edgeFall;
      heights[iz * n + ix] = shape * (0.35 + 0.65 * f01) + 0.1 * f01;
    }
  }
  normalizeTo(heights, 0, TERRAIN_HEIGHT);

  // 2. Droplet hydraulic erosion; deposition tracked per vertex for fertility.
  const deposition = new Float32Array(count);
  erode(heights, deposition, res, rng);
  smoothOnce(heights, n);

  // 3. Water level from the post-erosion height range.
  let minH = Infinity;
  let maxH = -Infinity;
  let lakeIdx = 0;
  for (let i = 0; i < count; i++) {
    const h = heights[i];
    if (h < minH) {
      minH = h;
      lakeIdx = i;
    }
    if (h > maxH) maxH = h;
  }
  const waterLevel = minH + WATER_LEVEL_FRAC * (maxH - minH);

  // 4. River: descend from a high rim point into the lake basin, then carve.
  const riverPath = traceAndCarveRiver(heights, res, size, waterLevel, minH, maxH, lakeIdx, rng);

  // 5. Moisture: 1 at/below water, decaying with height above the water level
  // and horizontal distance from the river, plus a small fBm rain term.
  const moisture = new Float32Array(count);
  const riverXZ = thinPath(riverPath, 80);
  for (let iz = 0; iz < n; iz++) {
    const wz = (iz / res - 0.5) * size;
    const nz = iz / res - 0.5;
    for (let ix = 0; ix < n; ix++) {
      const idx = iz * n + ix;
      const h = heights[idx];
      if (h <= waterLevel) {
        moisture[idx] = 1;
        continue;
      }
      const wx = (ix / res - 0.5) * size;
      const nx = ix / res - 0.5;
      let dRiver = Infinity;
      for (let p = 0; p < riverXZ.length; p += 2) {
        const dx = riverXZ[p] - wx;
        const dz = riverXZ[p + 1] - wz;
        const d2 = dx * dx + dz * dz;
        if (d2 < dRiver) dRiver = d2;
      }
      const lakeTerm = Math.exp(-(h - waterLevel) / 5);
      const riverTerm = Math.exp(-Math.sqrt(dRiver) / 16);
      const rain = 0.5 * (fbm2D(rainNoise, nx * 2.6 + 7.3, nz * 2.6 - 4.1, 3) + 1);
      moisture[idx] = Math.min(1, Math.max(lakeTerm, riverTerm) + 0.18 * rain);
    }
  }

  // 6. Fertility: percentile-normalized sediment deposition blended with
  // moisture, attenuated on peaks. Clamped to [0, 1].
  const fertility = new Float32Array(count);
  const dep95 = percentilePositive(deposition, 0.95);
  const invRange = 1 / Math.max(1e-6, maxH - minH);
  for (let i = 0; i < count; i++) {
    const depN = Math.min(1, deposition[i] / dep95);
    const hN = (heights[i] - minH) * invRange;
    const barren = 1 - 0.75 * smoothstep(0.55, 0.9, hN);
    fertility[i] = Math.min(1, Math.max(0, (0.55 * depN + 0.5 * moisture[i]) * barren));
  }

  return { heights, res, size, waterLevel, moisture, fertility, riverPath };
}

/** Bilinear height sample at world (x, z); coordinates are clamped to the map. */
export function sampleHeight(t: TerrainData, x: number, z: number): number {
  return sampleField(t.heights, t.res, t.size, x, z);
}

/**
 * Bilinear sample of any per-vertex field laid out like the heightfield
 * ((res+1)^2, row-major). World coords are clamped to the map bounds.
 */
export function sampleField(field: Float32Array, res: number, size: number, x: number, z: number): number {
  const n = res + 1;
  let fx = (x / size + 0.5) * res;
  let fz = (z / size + 0.5) * res;
  fx = fx < 0 ? 0 : fx > res ? res : fx;
  fz = fz < 0 ? 0 : fz > res ? res : fz;
  const ix = Math.min(Math.floor(fx), res - 1);
  const iz = Math.min(Math.floor(fz), res - 1);
  const u = fx - ix;
  const v = fz - iz;
  const i00 = iz * n + ix;
  const h00 = field[i00];
  const h10 = field[i00 + 1];
  const h01 = field[i00 + n];
  const h11 = field[i00 + n + 1];
  return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
}

/** Unit surface normal (y up) from central differences of the heightfield. */
export function terrainNormal(t: TerrainData, x: number, z: number): Vec3 {
  const e = t.size / t.res;
  const hl = sampleHeight(t, x - e, z);
  const hr = sampleHeight(t, x + e, z);
  const hb = sampleHeight(t, x, z - e);
  const hf = sampleHeight(t, x, z + e);
  const nx = hl - hr;
  const ny = 2 * e;
  const nz = hb - hf;
  const inv = 1 / Math.hypot(nx, ny, nz);
  return { x: nx * inv, y: ny * inv, z: nz * inv };
}

// ============================ internals ====================================

/** Rescale an array in place to exactly [lo, hi]. */
function normalizeTo(a: Float32Array, lo: number, hi: number): void {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < mn) mn = a[i];
    if (a[i] > mx) mx = a[i];
  }
  const s = (hi - lo) / Math.max(1e-9, mx - mn);
  for (let i = 0; i < a.length; i++) a[i] = lo + (a[i] - mn) * s;
}

/**
 * Sebastian-Lague-style droplet erosion. Droplets follow the gradient with
 * inertia, erode when under carrying capacity (spread over a soft brush so
 * channels are not single-vertex trenches), deposit when over capacity or
 * moving uphill, and evaporate. Deposits accumulate into `deposition`.
 */
function erode(heights: Float32Array, deposition: Float32Array, res: number, rng: RNG): void {
  const nn = res + 1;
  // Precomputed linear-falloff brush offsets (normalized away from borders).
  const brushDX: number[] = [];
  const brushDZ: number[] = [];
  const brushW: number[] = [];
  let wSum = 0;
  for (let dz = -BRUSH_RADIUS; dz <= BRUSH_RADIUS; dz++) {
    for (let dx = -BRUSH_RADIUS; dx <= BRUSH_RADIUS; dx++) {
      const d = Math.hypot(dx, dz);
      if (d <= BRUSH_RADIUS) {
        brushDX.push(dx);
        brushDZ.push(dz);
        const w = 1 - d / (BRUSH_RADIUS + 0.5);
        brushW.push(w);
        wSum += w;
      }
    }
  }
  for (let i = 0; i < brushW.length; i++) brushW[i] /= wSum;

  for (let drop = 0; drop < EROSION_DROPLETS; drop++) {
    let px = rng.next() * res;
    let pz = rng.next() * res;
    let dirX = 0;
    let dirZ = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let life = 0; life < DROPLET_LIFETIME; life++) {
      const ix = Math.min(Math.floor(px), res - 1);
      const iz = Math.min(Math.floor(pz), res - 1);
      const u = px - ix;
      const v = pz - iz;
      const i00 = iz * nn + ix;
      const h00 = heights[i00];
      const h10 = heights[i00 + 1];
      const h01 = heights[i00 + nn];
      const h11 = heights[i00 + nn + 1];
      const gradX = (h10 - h00) * (1 - v) + (h11 - h01) * v;
      const gradZ = (h01 - h00) * (1 - u) + (h11 - h10) * u;
      const hOld = h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;

      dirX = dirX * EROSION_INERTIA - gradX * (1 - EROSION_INERTIA);
      dirZ = dirZ * EROSION_INERTIA - gradZ * (1 - EROSION_INERTIA);
      const len = Math.hypot(dirX, dirZ);
      if (len < 1e-9) break; // flat: droplet dies
      dirX /= len;
      dirZ /= len;
      px += dirX;
      pz += dirZ;
      if (px < 0 || px >= res || pz < 0 || pz >= res) break;

      const nix = Math.min(Math.floor(px), res - 1);
      const niz = Math.min(Math.floor(pz), res - 1);
      const nu = px - nix;
      const nv = pz - niz;
      const j00 = niz * nn + nix;
      const hNew =
        heights[j00] * (1 - nu) * (1 - nv) +
        heights[j00 + 1] * nu * (1 - nv) +
        heights[j00 + nn] * (1 - nu) * nv +
        heights[j00 + nn + 1] * nu * nv;
      const dh = hNew - hOld;

      const capacity = Math.max(-dh * speed * water * EROSION_CAPACITY, EROSION_MIN_CAPACITY);
      if (sediment > capacity || dh > 0) {
        // Deposit onto the four corners of the departed cell (fills pits when dh > 0).
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * DEPOSIT_SPEED;
        sediment -= amount;
        const w00 = (1 - u) * (1 - v);
        const w10 = u * (1 - v);
        const w01 = (1 - u) * v;
        const w11 = u * v;
        heights[i00] += amount * w00;
        heights[i00 + 1] += amount * w10;
        heights[i00 + nn] += amount * w01;
        heights[i00 + nn + 1] += amount * w11;
        deposition[i00] += amount * w00;
        deposition[i00 + 1] += amount * w10;
        deposition[i00 + nn] += amount * w01;
        deposition[i00 + nn + 1] += amount * w11;
      } else {
        // Erode at most the height drop, spread over the brush around the old cell.
        const amount = Math.min((capacity - sediment) * ERODE_SPEED, -dh);
        const cx = Math.round(px - dirX); // brush centered on departed position
        const cz = Math.round(pz - dirZ);
        for (let b = 0; b < brushW.length; b++) {
          const bx = cx + brushDX[b];
          const bz = cz + brushDZ[b];
          if (bx < 0 || bx >= nn || bz < 0 || bz >= nn) continue;
          const bi = bz * nn + bx;
          const take = Math.min(amount * brushW[b], Math.max(0, heights[bi]));
          heights[bi] -= take;
          sediment += take;
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed - dh * EROSION_GRAVITY));
      water *= 1 - EVAPORATE;
      if (water < 0.005) break;
    }
  }
}

/** One mild 5-point smoothing pass (removes droplet pitting; borders kept). */
function smoothOnce(heights: Float32Array, n: number): void {
  const src = heights.slice();
  for (let iz = 1; iz < n - 1; iz++) {
    for (let ix = 1; ix < n - 1; ix++) {
      const i = iz * n + ix;
      const avg = (src[i - 1] + src[i + 1] + src[i - n] + src[i + n]) * 0.25;
      heights[i] = src[i] * 0.8 + avg * 0.2;
    }
  }
}

/** p-th percentile of the strictly positive entries (1 when there are none). */
function percentilePositive(a: Float32Array, p: number): number {
  const pos: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] > 0) pos.push(a[i]);
  if (pos.length === 0) return 1;
  pos.sort((x, y) => x - y);
  return Math.max(1e-6, pos[Math.min(pos.length - 1, Math.floor(p * pos.length))]);
}

/**
 * Pick a high rim point far from the lake, greedily descend the flow field to
 * the lake (lake-biased, no revisits), then carve a channel a few meters wide
 * whose bed sits slightly below waterLevel and never rises downstream.
 * Returns the center line in world coords with y = carved bed height.
 */
function traceAndCarveRiver(
  heights: Float32Array,
  res: number,
  size: number,
  waterLevel: number,
  minH: number,
  maxH: number,
  lakeIdx: number,
  rng: RNG,
): Vec3[] {
  const n = res + 1;
  const lakeIx = lakeIdx % n;
  const lakeIz = Math.floor(lakeIdx / n);
  const range = Math.max(1e-6, maxH - minH);

  // Source candidates: high vertices away from the border and from the lake.
  const margin = 6;
  const minDistCells = 0.3 * res;
  let candidates: number[] = [];
  for (let thresh = minH + 0.82 * range; thresh > waterLevel && candidates.length === 0; thresh -= 0.06 * range) {
    for (let iz = margin; iz <= res - margin; iz++) {
      for (let ix = margin; ix <= res - margin; ix++) {
        const idx = iz * n + ix;
        if (heights[idx] >= thresh && Math.hypot(ix - lakeIx, iz - lakeIz) >= minDistCells) {
          candidates.push(idx);
        }
      }
    }
  }
  if (candidates.length === 0) candidates = [lakeIdx === 0 ? count2Idx(n) : 0]; // degenerate map fallback
  const startIdx = candidates[rng.int(candidates.length)];

  // Greedy descent with a mild lake bias and jitter; visited set bars loops.
  const visited = new Uint8Array(n * n);
  let cx = startIdx % n;
  let cz = Math.floor(startIdx / n);
  const cells: number[] = [cx, cz];
  visited[startIdx] = 1;
  const maxSteps = 4 * res;
  for (let step = 0; step < maxSteps; step++) {
    if (heights[cz * n + cx] <= waterLevel) break;
    let best = -1;
    let bestScore = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx > res || nz < 0 || nz > res) continue;
        const nIdx = nz * n + nx;
        if (visited[nIdx]) continue;
        const lakePull = (Math.hypot(nx - lakeIx, nz - lakeIz) / res) * 0.05 * range;
        const score = heights[nIdx] + lakePull + rng.next() * 0.02 * range;
        if (score < bestScore) {
          bestScore = score;
          best = nIdx;
        }
      }
    }
    if (best < 0) break; // boxed in
    cx = best % n;
    cz = Math.floor(best / n);
    visited[best] = 1;
    cells.push(cx, cz);
  }
  // Guarantee the mouth reaches the lake: march straight toward the minimum
  // vertex (height minH < waterLevel) if the walk stalled above water.
  while (heights[cz * n + cx] > waterLevel && (cx !== lakeIx || cz !== lakeIz)) {
    cx += Math.sign(lakeIx - cx);
    cz += Math.sign(lakeIz - cz);
    cells.push(cx, cz);
  }

  // World-space center line; subdivide so short rivers still give >= 40 points.
  let pts: { x: number; z: number }[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    pts.push({ x: (cells[i] / res - 0.5) * size, z: (cells[i + 1] / res - 0.5) * size });
  }
  while (pts.length < RIVER_MIN_POINTS && pts.length >= 2) {
    const sub: { x: number; z: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      sub.push(pts[i], { x: (pts[i].x + pts[i + 1].x) / 2, z: (pts[i].z + pts[i + 1].z) / 2 });
    }
    sub.push(pts[pts.length - 1]);
    pts = sub;
  }

  // Carve: monotonically non-increasing bed slightly below the water level.
  const bedFloor = waterLevel - RIVER_BED_FLOOR_BELOW_WATER;
  const path: Vec3[] = [];
  let bed = waterLevel - RIVER_BED_BELOW_WATER;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) bed = Math.max(bed - RIVER_BED_STEP, bedFloor);
    const { x: wx, z: wz } = pts[i];
    path.push({ x: wx, y: bed, z: wz });
    // Lower nearby vertices toward the bed with a smooth shoulder.
    const cellR = Math.ceil((RIVER_BLEND_RADIUS / size) * res) + 1;
    const gx = Math.round((wx / size + 0.5) * res);
    const gz = Math.round((wz / size + 0.5) * res);
    for (let dz = -cellR; dz <= cellR; dz++) {
      for (let dx = -cellR; dx <= cellR; dx++) {
        const vx = gx + dx;
        const vz = gz + dz;
        if (vx < 0 || vx > res || vz < 0 || vz > res) continue;
        const wvx = (vx / res - 0.5) * size;
        const wvz = (vz / res - 0.5) * size;
        const d = Math.hypot(wvx - wx, wvz - wz);
        if (d >= RIVER_BLEND_RADIUS) continue;
        const vi = vz * n + vx;
        const t = smoothstep(RIVER_HALF_WIDTH, RIVER_BLEND_RADIUS, d);
        const target = bed * (1 - t) + heights[vi] * t;
        if (target < heights[vi]) heights[vi] = target;
      }
    }
  }
  return path;
}

/** Fallback source index for a degenerate (single-level) map: center vertex. */
function count2Idx(n: number): number {
  const mid = Math.floor(n / 2);
  return mid * n + mid;
}

/** Flatten a path's (x, z) pairs, thinned to at most `maxPts` points. */
function thinPath(path: Vec3[], maxPts: number): Float32Array {
  const stride = Math.max(1, Math.ceil(path.length / maxPts));
  const out: number[] = [];
  for (let i = 0; i < path.length; i += stride) {
    out.push(path[i].x, path[i].z);
  }
  const last = path[path.length - 1];
  if (last) out.push(last.x, last.z);
  return new Float32Array(out);
}
