/**
 * Terrain module tests: noise determinism/range, heightfield dimensions and
 * determinism, water level, moisture/fertility bounds, bilinear sampling,
 * normals, and river descent/carving (task contract for M1 terrain).
 */
import { describe, expect, it } from 'vitest';
import { RNG } from '../src/shared/rng';
import { fbm2D, makeNoise2D } from '../src/shared/noise';
import { generateTerrain, sampleField, sampleHeight, terrainNormal } from '../src/sim/ecology/terrain';
import { TERRAIN_HEIGHT, TERRAIN_RES, TERRAIN_SIZE } from '../src/shared/constants';
import type { TerrainData } from '../src/shared/types';

const N = TERRAIN_RES + 1;

// Generated once; several suites assert against the same deterministic result.
const terrain = generateTerrain(new RNG(1234));

function mismatches(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.abs(a.length - b.length) + 1;
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) m++;
  return m;
}

describe('noise', () => {
  it('is deterministic for the same seed and differs across seeds', () => {
    const a = makeNoise2D(42);
    const b = makeNoise2D(42);
    const c = makeNoise2D(43);
    let diff = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.137 - 10;
      const y = i * 0.251 - 13;
      expect(a(x, y)).toBe(b(x, y));
      if (a(x, y) !== c(x, y)) diff++;
    }
    expect(diff).toBeGreaterThan(150);
  });

  it('stays in [-1, 1] and actually varies', () => {
    const noise = makeNoise2D(7);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const v = noise(i * 0.173, i * 0.311 - 50);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(max - min).toBeGreaterThan(0.5);
  });

  it('fbm2D is roughly in [-1, 1] with default and custom params', () => {
    const noise = makeNoise2D(99);
    for (let i = 0; i < 1000; i++) {
      const x = i * 0.0917;
      const y = 31.7 - i * 0.0531;
      const v = fbm2D(noise, x, y, 5);
      const w = fbm2D(noise, x, y, 3, 2.3, 0.6);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.000001);
      expect(Math.abs(w)).toBeLessThanOrEqual(1.000001);
    }
  });
});

describe('generateTerrain', () => {
  it('produces (res+1)^2 arrays with contract res/size', () => {
    expect(terrain.res).toBe(TERRAIN_RES);
    expect(terrain.size).toBe(TERRAIN_SIZE);
    expect(terrain.heights.length).toBe(N * N);
    expect(terrain.moisture.length).toBe(N * N);
    expect(terrain.fertility.length).toBe(N * N);
  });

  it('is deterministic: same seed => identical terrain and river', () => {
    const a = generateTerrain(new RNG(777));
    const b = generateTerrain(new RNG(777));
    expect(mismatches(a.heights, b.heights)).toBe(0);
    expect(mismatches(a.moisture, b.moisture)).toBe(0);
    expect(mismatches(a.fertility, b.fertility)).toBe(0);
    expect(a.waterLevel).toBe(b.waterLevel);
    expect(a.riverPath).toEqual(b.riverPath);
  });

  it('differs across seeds', () => {
    const a = generateTerrain(new RNG(1));
    const b = generateTerrain(new RNG(2));
    expect(mismatches(a.heights, b.heights)).toBeGreaterThan(N); // virtually all differ
  });

  it('heights stay in a sane meter range', () => {
    for (let i = 0; i < terrain.heights.length; i++) {
      expect(terrain.heights[i]).toBeGreaterThanOrEqual(-TERRAIN_HEIGHT);
      expect(terrain.heights[i]).toBeLessThanOrEqual(TERRAIN_HEIGHT * 1.01);
    }
  });

  it('waterLevel lies within the height range, with land above and lake below', () => {
    let min = Infinity;
    let max = -Infinity;
    let above = 0;
    let below = 0;
    for (let i = 0; i < terrain.heights.length; i++) {
      const h = terrain.heights[i];
      min = Math.min(min, h);
      max = Math.max(max, h);
      if (h > terrain.waterLevel) above++;
      else below++;
    }
    expect(terrain.waterLevel).toBeGreaterThan(min);
    expect(terrain.waterLevel).toBeLessThan(max);
    expect(above).toBeGreaterThan(N * N * 0.2); // mostly land...
    expect(below).toBeGreaterThan(N * N * 0.01); // ...with a real lake
  });

  it('moisture and fertility are in [0, 1], wet below water, varied on land', () => {
    let fMin = Infinity;
    let fMax = -Infinity;
    for (let i = 0; i < terrain.moisture.length; i++) {
      expect(terrain.moisture[i]).toBeGreaterThanOrEqual(0);
      expect(terrain.moisture[i]).toBeLessThanOrEqual(1);
      expect(terrain.fertility[i]).toBeGreaterThanOrEqual(0);
      expect(terrain.fertility[i]).toBeLessThanOrEqual(1);
      if (terrain.heights[i] <= terrain.waterLevel) expect(terrain.moisture[i]).toBe(1);
      fMin = Math.min(fMin, terrain.fertility[i]);
      fMax = Math.max(fMax, terrain.fertility[i]);
    }
    expect(fMax - fMin).toBeGreaterThan(0.3); // fertile valleys vs barren peaks
  });
});

describe('sampling', () => {
  it('sampleHeight matches the grid exactly at vertices', () => {
    const probes: [number, number][] = [
      [0, 0],
      [TERRAIN_RES, TERRAIN_RES],
      [17, 93],
      [64, 64],
      [128, 3],
    ];
    for (const [ix, iz] of probes) {
      const x = (ix / TERRAIN_RES - 0.5) * TERRAIN_SIZE;
      const z = (iz / TERRAIN_RES - 0.5) * TERRAIN_SIZE;
      expect(sampleHeight(terrain, x, z)).toBeCloseTo(terrain.heights[iz * N + ix], 4);
    }
  });

  it('sampleHeight interpolates linearly between adjacent vertices', () => {
    const ix = 40;
    const iz = 55;
    const x0 = (ix / TERRAIN_RES - 0.5) * TERRAIN_SIZE;
    const z0 = (iz / TERRAIN_RES - 0.5) * TERRAIN_SIZE;
    const cell = TERRAIN_SIZE / TERRAIN_RES;
    const hMid = sampleHeight(terrain, x0 + cell / 2, z0);
    const expected = (terrain.heights[iz * N + ix] + terrain.heights[iz * N + ix + 1]) / 2;
    expect(hMid).toBeCloseTo(expected, 4);
  });

  it('sampleField bilinearly interpolates a known small field and clamps outside', () => {
    // res 2, size 4: vertices 0..8 row-major; center of the field is value 4.
    const field = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sampleField(field, 2, 4, -2, -2)).toBeCloseTo(0, 6);
    expect(sampleField(field, 2, 4, 2, 2)).toBeCloseTo(8, 6);
    expect(sampleField(field, 2, 4, 0, 0)).toBeCloseTo(4, 6);
    expect(sampleField(field, 2, 4, 1, -1)).toBeCloseTo((1 + 2 + 4 + 5) / 4, 6);
    expect(sampleField(field, 2, 4, -999, 999)).toBeCloseTo(6, 6); // clamped corner
  });

  it('terrainNormal is unit length, y-up, and flat ground gives (0,1,0)', () => {
    const flat: TerrainData = {
      heights: new Float32Array(N * N).fill(5),
      res: TERRAIN_RES,
      size: TERRAIN_SIZE,
      waterLevel: 1,
      moisture: new Float32Array(N * N),
      fertility: new Float32Array(N * N),
    };
    const nf = terrainNormal(flat, 10, -20);
    expect(nf.x).toBeCloseTo(0, 6);
    expect(nf.y).toBeCloseTo(1, 6);
    expect(nf.z).toBeCloseTo(0, 6);
    for (const [x, z] of [
      [0, 0],
      [-80, 55],
      [100, -100],
    ] as const) {
      const nrm = terrainNormal(terrain, x, z);
      expect(Math.hypot(nrm.x, nrm.y, nrm.z)).toBeCloseTo(1, 5);
      expect(nrm.y).toBeGreaterThan(0);
    }
  });
});

describe('river', () => {
  it('has 40+ points inside world bounds', () => {
    expect(terrain.riverPath.length).toBeGreaterThanOrEqual(40);
    for (const p of terrain.riverPath) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(TERRAIN_SIZE / 2);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(TERRAIN_SIZE / 2);
    }
  });

  it('descends monotonically (non-increasing bed) and ends below waterLevel', () => {
    const path = terrain.riverPath;
    for (let i = 1; i < path.length; i++) {
      expect(path[i].y).toBeLessThanOrEqual(path[i - 1].y + 1e-5);
    }
    expect(path[path.length - 1].y).toBeLessThanOrEqual(terrain.waterLevel);
    expect(path[0].y).toBeLessThanOrEqual(terrain.waterLevel); // bed is below water along the channel
  });

  it('carves the channel: terrain along the path sits at/below waterLevel', () => {
    for (const p of terrain.riverPath) {
      expect(sampleHeight(terrain, p.x, p.z)).toBeLessThanOrEqual(terrain.waterLevel + 1e-3);
    }
  });
});

describe('performance', () => {
  it('generates res-128 terrain in reasonable time for one-shot init', () => {
    const t0 = performance.now();
    generateTerrain(new RNG(31337));
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000); // target ~250ms; loose bound for CI jitter
  });
});
