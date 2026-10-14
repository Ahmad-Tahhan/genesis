/**
 * Procedural PBR skin materials for creatures. Every texture is generated at
 * runtime on a Canvas2D from the part's pigment genes (HSL) and pattern genes
 * (patternFreq 1..12, patternAmp 0..1) using the shared deterministic noise,
 * so no external assets are ever loaded. Materials are cached under a rounded
 * gene key, so all members of a species (near-identical genes) share one
 * material + texture pair; the cache is capped with LRU eviction.
 */
import * as THREE from 'three';
import type { BodyPlan } from '../shared/types';
import { makeNoise2D } from '../shared/noise';

/** Square skin texture edge in pixels (skins are low-frequency patterns). */
const TEX_SIZE = 128;
/** Max cached skin materials before least-recently-used eviction. */
const SKIN_CACHE_CAP = 200;
/** Max cached mouth-tint materials. */
const MOUTH_CACHE_CAP = 64;
const TWO_PI = Math.PI * 2;

const skinCache = new Map<string, THREE.MeshStandardMaterial>();
const mouthCache = new Map<string, THREE.MeshStandardMaterial>();

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

function wrap01(x: number): number {
  return x - Math.floor(x);
}

/** Hermite smoothstep on [lo, hi]. */
function smooth(lo: number, hi: number, x: number): number {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

/** FNV-1a 32-bit string hash — deterministic texture seed per cache key. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * HSL (each 0..1) to sRGB bytes. Done by hand (not via THREE.Color) because
 * canvas pixels must be written in sRGB, while THREE.Color stores channels in
 * the linear working space under color management.
 */
function hslToRgbBytes(h: number, s: number, l: number): [number, number, number] {
  const hue = wrap01(h);
  const sat = clamp01(s);
  const lig = clamp01(l);
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const chan = (t0: number): number => {
    let t = wrap01(t0);
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(clamp01(chan(hue + 1 / 3)) * 255),
    Math.round(clamp01(chan(hue)) * 255),
    Math.round(clamp01(chan(hue - 1 / 3)) * 255),
  ];
}

/** Evict least-recently-used entries (front of the Map) down to `cap - 1`. */
function evictIfFull(cache: Map<string, THREE.MeshStandardMaterial>, cap: number): void {
  while (cache.size >= cap) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const mat = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (mat) {
      mat.map?.dispose();
      mat.roughnessMap?.dispose();
      mat.dispose();
    }
  }
}

/**
 * Generate the color + roughness canvases and wrap them in a standard
 * material. `h`,`s`,`l` are raw pigment genes (0..1), `freq` is patternFreq
 * (1..12), `amp` is patternAmp (0..1); `seed` picks the pattern family
 * (stripes / spots / mottling) and the noise field.
 */
function buildSkin(
  h: number,
  s: number,
  l: number,
  freq: number,
  amp: number,
  seed: number,
): THREE.MeshStandardMaterial {
  // Remap raw genes into a visible gamut (never pure black/white/gray).
  const sat = 0.3 + 0.6 * clamp01(s);
  const lig = 0.26 + 0.46 * clamp01(l);

  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (!canvas || !ctx) {
    // Headless (tests): plain material with the base pigment, no textures.
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(wrap01(h), sat, lig, THREE.SRGBColorSpace),
      roughness: 0.75,
      metalness: 0,
    });
  }

  const [br, bg, bb] = hslToRgbBytes(h, sat, lig); // base pigment
  const [dr, dg, db] = hslToRgbBytes(h + 0.05, sat * 1.05, lig * 0.42); // pattern pigment

  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const rCanvas = document.createElement('canvas');
  rCanvas.width = TEX_SIZE;
  rCanvas.height = TEX_SIZE;
  const rCtx = rCanvas.getContext('2d');

  const img = ctx.createImageData(TEX_SIZE, TEX_SIZE);
  const rImg = rCtx ? rCtx.createImageData(TEX_SIZE, TEX_SIZE) : null;
  const noise = makeNoise2D(seed);
  const family = seed % 3; // 0 stripes, 1 spots, 2 mottling
  const a = clamp01(amp);
  const stripeCount = 1 + freq; // bands across v
  const spotFreq = 2 + freq * 1.1; // noise cells across the texture
  const mottleFreq = 1.5 + freq * 0.6;

  let o = 0;
  for (let y = 0; y < TEX_SIZE; y++) {
    const v = y / TEX_SIZE;
    for (let x = 0; x < TEX_SIZE; x++) {
      const u = x / TEX_SIZE;
      // Low-frequency warp makes stripes wobble and spots irregular.
      const warp = noise(u * 3.1 + 5.7, v * 3.1 + 9.2);
      let mask: number;
      if (family === 0) {
        const band = 0.5 + 0.5 * Math.sin((v * stripeCount + warp * 0.16) * TWO_PI);
        mask = smooth(0.58, 0.85, band);
      } else if (family === 1) {
        const n = noise(u * spotFreq + 13.4, v * spotFreq + 3.9);
        mask = smooth(0.3, 0.52, n + warp * 0.12);
      } else {
        const n =
          0.65 * noise(u * mottleFreq, v * mottleFreq) +
          0.35 * noise(u * mottleFreq * 2.6 + 31.7, v * mottleFreq * 2.6 + 17.3);
        mask = clamp01(0.5 + 0.62 * n);
      }
      mask *= a;
      // Fine grain: organic lightness jitter + roughness variation (sheen).
      const grain = noise(u * 29 + 57.5, v * 29 + 91.1);
      const shade = 1 + grain * 0.07;
      img.data[o] = clamp(Math.round((br + (dr - br) * mask) * shade), 0, 255);
      img.data[o + 1] = clamp(Math.round((bg + (dg - bg) * mask) * shade), 0, 255);
      img.data[o + 2] = clamp(Math.round((bb + (db - bb) * mask) * shade), 0, 255);
      img.data[o + 3] = 255;
      if (rImg) {
        const rough = clamp(0.75 + mask * 0.12 - grain * 0.09, 0.55, 0.95);
        const rb = Math.round(rough * 255);
        rImg.data[o] = rb;
        rImg.data[o + 1] = rb; // roughnessMap reads the green channel
        rImg.data[o + 2] = rb;
        rImg.data[o + 3] = 255;
      }
      o += 4;
    }
  }
  ctx.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  // Mirrored wrap in u hides the UV seam on capsules; repeat in v.
  map.wrapS = THREE.MirroredRepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;

  let roughnessMap: THREE.CanvasTexture | null = null;
  if (rCtx && rImg) {
    rCtx.putImageData(rImg, 0, 0);
    roughnessMap = new THREE.CanvasTexture(rCanvas);
    roughnessMap.wrapS = THREE.MirroredRepeatWrapping;
    roughnessMap.wrapT = THREE.RepeatWrapping;
  }

  const mat = new THREE.MeshStandardMaterial({
    map,
    metalness: 0,
    // The roughness map carries ~0.75 with pattern/grain variation; the
    // scalar is its multiplier.
    roughness: roughnessMap ? 1 : 0.75,
  });
  if (roughnessMap) mat.roughnessMap = roughnessMap;
  mat.name = 'skin';
  return mat;
}

/**
 * Procedural skin material for one part of a developed body plan.
 *
 * The texture is generated from the part's HSL pigment genes plus its
 * stripes/spots/mottling pattern genes, and cached under a rounded gene key so
 * a whole species shares one material (cap ~200, LRU eviction). Returned
 * materials are shared — callers must not mutate or dispose them.
 */
export function skinMaterial(plan: BodyPlan, partIndex: number): THREE.MeshStandardMaterial {
  const part = partIndex >= 0 && partIndex < plan.parts.length ? plan.parts[partIndex] : undefined;
  const h = part ? clamp01(part.color[0]) : 0.33;
  const s = part ? clamp01(part.color[1]) : 0.2;
  const l = part ? clamp01(part.color[2]) : 0.5;
  const freq = part ? clamp(part.patternFreq, 1, 12) : 4;
  const amp = part ? clamp01(part.patternAmp) : 0.3;
  const key =
    `${Math.round(h * 24)}|${Math.round(s * 10)}|${Math.round(l * 10)}|` +
    `${Math.round(freq)}|${Math.round(amp * 10)}`;
  const hit = skinCache.get(key);
  if (hit) {
    // LRU refresh: move to the back of the Map's insertion order.
    skinCache.delete(key);
    skinCache.set(key, hit);
    return hit;
  }
  evictIfFull(skinCache, SKIN_CACHE_CAP);
  const mat = buildSkin(h, s, l, freq, amp, fnv1a(key));
  skinCache.set(key, mat);
  return mat;
}

/**
 * Small untextured material for the darker "mouth" tip marker of a part,
 * derived from (and slightly darker than) that part's pigment genes. Cached by
 * rounded color; shared — callers must not mutate or dispose it.
 */
export function mouthMaterial(color: [number, number, number]): THREE.MeshStandardMaterial {
  const h = clamp01(color[0]);
  const s = clamp01(color[1]);
  const l = clamp01(color[2]);
  const key = `${Math.round(h * 16)}|${Math.round(s * 8)}|${Math.round(l * 8)}`;
  const hit = mouthCache.get(key);
  if (hit) {
    mouthCache.delete(key);
    mouthCache.set(key, hit);
    return hit;
  }
  evictIfFull(mouthCache, MOUTH_CACHE_CAP);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(
      wrap01(h - 0.02),
      0.25 + 0.45 * s,
      Math.max(0.06, (0.26 + 0.46 * l) * 0.35),
      THREE.SRGBColorSpace,
    ),
    roughness: 0.55,
    metalness: 0,
  });
  mat.name = 'mouth';
  mouthCache.set(key, mat);
  return mat;
}
