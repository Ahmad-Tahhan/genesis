/**
 * Terrain render mesh built from the sim's heightfield. Vertex layout matches
 * the physics heightfield exactly: world x = (ix/res - 0.5) * size,
 * world z = (iz/res - 0.5) * size, height index iz * (res + 1) + ix.
 * Colors are per-vertex from height/slope/moisture/fertility, with a
 * shader-injected hash-noise detail layer so it doesn't look flat-shaded.
 */
import * as THREE from 'three';
import type { TerrainData } from '../shared/types';

const C_MUD = new THREE.Color(0x4e4434);
const C_SAND = new THREE.Color(0xcbb98a);
const C_GRASS_LUSH = new THREE.Color(0x4f8a3c);
const C_GRASS_DRY = new THREE.Color(0x98985a);
const C_ROCK = new THREE.Color(0x7d786e);
const C_SNOW = new THREE.Color(0xe9eef4);

/** THREE.MathUtils.smoothstep with (edge0, edge1, x) ordering. */
function sm(edge0: number, edge1: number, x: number): number {
  return THREE.MathUtils.smoothstep(x, edge0, edge1);
}

/** Deterministic per-vertex jitter (no Math.random anywhere). */
function hash2(ix: number, iz: number): number {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

const DETAIL_NOISE_GLSL = /* glsl */ `
float gnHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float gnNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gnHash(i), gnHash(i + vec2(1.0, 0.0)), u.x),
             mix(gnHash(i + vec2(0.0, 1.0)), gnHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/**
 * Build the single merged terrain mesh (receives shadows, casts none).
 * The caller owns disposal of `mesh.geometry` and `mesh.material`.
 */
export function buildTerrainMesh(t: TerrainData): THREE.Mesh {
  const { res, size, heights, waterLevel, moisture, fertility } = t;
  const side = res + 1;
  const cell = size / res;

  const geo = new THREE.PlaneGeometry(size, size, res, res);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes['position'] as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i]);

  let maxH = -Infinity;
  for (let i = 0; i < heights.length; i++) if (heights[i] > maxH) maxH = heights[i];
  const peakSpan = Math.max(1e-3, maxH - waterLevel);

  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const g = new THREE.Color();
  for (let iz = 0; iz <= res; iz++) {
    for (let ix = 0; ix <= res; ix++) {
      const i = iz * side + ix;
      const h = heights[i];
      const x0 = Math.max(0, ix - 1);
      const x1 = Math.min(res, ix + 1);
      const z0 = Math.max(0, iz - 1);
      const z1 = Math.min(res, iz + 1);
      const dhdx = (heights[iz * side + x1] - heights[iz * side + x0]) / ((x1 - x0) * cell);
      const dhdz = (heights[z1 * side + ix] - heights[z0 * side + ix]) / ((z1 - z0) * cell);
      const grad = Math.hypot(dhdx, dhdz); // ~tan(slope angle)
      const m = moisture[i];
      const f = fertility[i];
      const rel = h - waterLevel;

      // lake bed mud -> shoreline sand
      c.lerpColors(C_MUD, C_SAND, sm(-4.5, 0.5, rel));
      // grass on fertile, flat-ish ground above the shore; moisture greens it
      g.lerpColors(C_GRASS_DRY, C_GRASS_LUSH, Math.min(1, m * 1.4));
      const grassW = sm(0.4, 1.8, rel) * (1 - sm(0.35, 0.7, grad)) * sm(0.12, 0.45, f);
      c.lerp(g, grassW);
      // rock on steep slopes and high altitude
      const rockW = Math.min(
        1,
        sm(0.55, 0.95, grad) + 0.65 * sm(waterLevel + 0.55 * peakSpan, waterLevel + 0.8 * peakSpan, h),
      );
      c.lerp(C_ROCK, rockW);
      // snow-ish caps on the gentler peaks
      const snowW = sm(waterLevel + 0.8 * peakSpan, waterLevel + 0.93 * peakSpan, h) * (1 - sm(0.8, 1.2, grad));
      c.lerp(C_SNOW, snowW);

      const jit = 0.94 + 0.12 * hash2(ix, iz);
      colors[i * 3] = c.r * jit;
      colors[i * 3 + 1] = c.g * jit;
      colors[i * 3 + 2] = c.b * jit;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGenWorldPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGenWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGenWorldPos;\n' + DETAIL_NOISE_GLSL)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
{
  float n1 = gnNoise(vGenWorldPos.xz * 0.85);
  float n2 = gnNoise(vGenWorldPos.xz * 5.3);
  float n3 = gnNoise(vGenWorldPos.xz * 23.0);
  float detail = n1 * 0.5 + n2 * 0.33 + n3 * 0.17;
  diffuseColor.rgb *= 0.86 + 0.28 * detail;
}`,
      );
  };

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
