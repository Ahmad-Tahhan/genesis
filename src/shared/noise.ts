/**
 * Seedable 2D simplex noise (Gustavson's reference algorithm, implemented from
 * scratch — no external assets or libraries) plus an fBm helper. Shared because
 * both the terrain generator (sim) and the procedural texture pipeline
 * (renderer) must sample identical fields from the same seed.
 */
import { RNG } from './rng';

/** Skew/unskew factors for 2D simplex grid. */
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

/** 8 unit-ish gradient directions; magnitudes folded into the 70.14 output scale. */
const GRAD_X = [1, -1, 1, -1, 1, -1, 0, 0];
const GRAD_Y = [1, 1, -1, -1, 0, 0, 1, -1];

/**
 * Create a deterministic 2D simplex noise function. Same seed => identical
 * function. Output is in [-1, 1] (the 70.14 scale bounds the analytic maximum
 * of the summed corner contributions).
 */
export function makeNoise2D(seed: number): (x: number, y: number) => number {
  // Fisher–Yates shuffle of 0..255 driven by the seeded PRNG (no Math.random).
  const rng = new RNG(seed >>> 0 || 0x51ab_7e31);
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return (x: number, y: number): number => {
    // Skew input space to determine the containing simplex cell.
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    // Offsets for the middle corner: upper or lower triangle of the cell.
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      const g = perm[ii + perm[jj]] & 7;
      n += t0 * t0 * (GRAD_X[g] * x0 + GRAD_Y[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      const g = perm[ii + i1 + perm[jj + j1]] & 7;
      n += t1 * t1 * (GRAD_X[g] * x1 + GRAD_Y[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      const g = perm[ii + 1 + perm[jj + 1]] & 7;
      n += t2 * t2 * (GRAD_X[g] * x2 + GRAD_Y[g] * y2);
    }
    // 70.14 maps the theoretical extrema to just inside [-1, 1].
    return 70.14 * n;
  };
}

/**
 * Fractal Brownian motion over a 2D noise function. Octave amplitudes are
 * normalized so the output stays roughly in [-1, 1] regardless of octave
 * count. lacunarity > 1 (default 2), 0 < gain < 1 (default 0.5).
 */
export function fbm2D(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(fx, fy);
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}
