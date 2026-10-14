/** Minimal vector/quaternion helpers for the worker (no three.js off the main thread). */
import type { Vec3 } from '../shared/types';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function rotateVec(q: Quat, v: Vec3): Vec3 {
  // v' = q * v * q^-1 (optimized)
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

export function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l < 1e-9) return { x: 1, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export function dist2d(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
