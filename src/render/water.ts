/**
 * Animated reflective water: a planar reflection (three Reflector render
 * target, <= 512px) blended by a custom shader with procedural ripple normals
 * (sum of moving directional sines + value noise), fresnel, sun specular, a
 * depth tint toward the shore and manual fog. No textures (DECISIONS.md D7).
 */
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { TerrainData } from '../shared/types';

const WATER_VERT = /* glsl */ `
uniform mat4 textureMatrix;
attribute float aDepth;
varying vec4 vUvP;
varying vec3 vWorldPos;
varying float vDepth;
void main() {
  vUvP = textureMatrix * vec4(position, 1.0);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vDepth = aDepth;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
uniform vec3 color;
uniform sampler2D tDiffuse;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec4 vUvP;
varying vec3 vWorldPos;
varying float vDepth;

float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x),
             mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Analytic gradient of a sum of moving directional sine waves + noise detail.
vec3 rippleNormal(vec2 p, float t) {
  float dx = 0.0;
  float dz = 0.0;
  vec2 d;
  float c;
  d = vec2(0.94, 0.34);  c = cos(dot(d, p) * 0.9 + t * 1.4) * 0.045 * 0.9;  dx += c * d.x; dz += c * d.y;
  d = vec2(-0.57, 0.82); c = cos(dot(d, p) * 1.7 + t * 1.9) * 0.030 * 1.7;  dx += c * d.x; dz += c * d.y;
  d = vec2(0.21, -0.98); c = cos(dot(d, p) * 2.9 + t * 2.6) * 0.018 * 2.9;  dx += c * d.x; dz += c * d.y;
  d = vec2(-0.80, -0.60); c = cos(dot(d, p) * 4.6 + t * 3.4) * 0.012 * 4.6; dx += c * d.x; dz += c * d.y;
  float e = 0.22;
  vec2 np = p * 0.55 + vec2(t * 0.24, -t * 0.17);
  float nC = wNoise(np);
  dx += (wNoise(np + vec2(e, 0.0)) - nC) / e * 0.09;
  dz += (wNoise(np + vec2(0.0, e)) - nC) / e * 0.09;
  return normalize(vec3(-dx, 1.0, -dz));
}

void main() {
  vec3 n = rippleNormal(vWorldPos.xz, uTime);
  vec3 V = normalize(cameraPosition - vWorldPos);

  // ripple-perturbed planar reflection
  vec2 uv = vUvP.xy / vUvP.w + n.xz * 0.05;
  vec3 refl = texture2D(tDiffuse, uv).rgb * color;

  float ndv = max(dot(V, n), 0.0);
  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  float depthK = clamp(vDepth / 3.5, 0.0, 1.0);
  vec3 waterCol = mix(vec3(0.10, 0.32, 0.30), vec3(0.015, 0.07, 0.11), depthK);
  float reflAmt = clamp(0.22 + fres, 0.0, 0.96);
  vec3 col = mix(waterCol, refl, reflAmt);

  // sun sparkle
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(n, H), 0.0), 240.0) * clamp(uSunDir.y * 3.0, 0.0, 1.0);
  col += vec3(1.3, 1.15, 0.9) * spec * 1.6;

  // gentle lapping brightening along the shoreline
  float shore = 1.0 - smoothstep(0.0, 0.6, vDepth);
  float lap = 0.5 + 0.5 * sin(uTime * 1.7 + vDepth * 9.0 + wNoise(vWorldPos.xz * 0.8) * 6.0);
  col = mix(col, vec3(0.55, 0.68, 0.66), shore * lap * 0.22);

  // shallow water is see-through; the plane fades out where land rises above it
  float alpha = mix(0.62, 0.97, depthK);
  alpha = clamp(max(alpha, fres), 0.0, 1.0) * smoothstep(-0.25, 0.08, vDepth);

  // manual fog (ShaderMaterial gets no scene fog chunks)
  float fogK = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorldPos));
  col = mix(col, uFogColor, fogK);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Shader handed to Reflector; it fills color/tDiffuse/textureMatrix itself. */
const WATER_SHADER = {
  name: 'GenesisWater',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uFogColor: { value: new THREE.Color(0xc7d6e8) },
    uFogNear: { value: 110 },
    uFogFar: { value: 840 },
  },
  vertexShader: WATER_VERT,
  fragmentShader: WATER_FRAG,
};

/** Bilinear height sample of the terrain grid at world (x, z). */
function sampleHeight(t: TerrainData, x: number, z: number): number {
  const { res, size, heights } = t;
  const side = res + 1;
  const fx = THREE.MathUtils.clamp((x / size + 0.5) * res, 0, res - 1e-4);
  const fz = THREE.MathUtils.clamp((z / size + 0.5) * res, 0, res - 1e-4);
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const h00 = heights[iz * side + ix];
  const h10 = heights[iz * side + ix + 1];
  const h01 = heights[(iz + 1) * side + ix];
  const h11 = heights[(iz + 1) * side + ix + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/**
 * Reflective, animated water plane at `t.waterLevel`, sized to the terrain.
 * Call `update(time, sunDir)` once per frame; `sunDir` points toward the sun.
 */
export class WaterRig {
  /** The water mesh (a Reflector), already added to the scene. */
  readonly mesh: THREE.Mesh;

  private readonly scene: THREE.Scene;
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(scene: THREE.Scene, t: TerrainData) {
    const seg = 64;
    const geo = new THREE.PlaneGeometry(t.size, t.size, seg, seg);
    // mesh is rotated -PI/2 about X, so local (x, y) -> world (x, -y)
    const pos = geo.attributes['position'] as THREE.BufferAttribute;
    const depth = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      depth[i] = t.waterLevel - sampleHeight(t, pos.getX(i), -pos.getY(i));
    }
    geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));

    const reflector = new Reflector(geo, {
      color: 0xffffff,
      textureWidth: 512,
      textureHeight: 512,
      clipBias: 0.02,
      multisample: 2,
      shader: WATER_SHADER,
    });
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.y = t.waterLevel;
    reflector.name = 'water';
    const mat = reflector.material as THREE.ShaderMaterial;
    mat.transparent = true;
    this.uniforms = mat.uniforms;

    scene.add(reflector);
    this.scene = scene;
    this.mesh = reflector;
  }

  /** Advance ripples/specular and sync fog uniforms with the scene fog. */
  update(time: number, sunDir: THREE.Vector3): void {
    this.uniforms['uTime'].value = time;
    (this.uniforms['uSunDir'].value as THREE.Vector3).copy(sunDir);
    const fog = this.scene.fog;
    if (fog instanceof THREE.Fog) {
      (this.uniforms['uFogColor'].value as THREE.Color).copy(fog.color);
      this.uniforms['uFogNear'].value = fog.near;
      this.uniforms['uFogFar'].value = fog.far;
    }
  }

  /** Remove from the scene and free the render target, material and geometry. */
  dispose(): void {
    this.scene.remove(this.mesh);
    (this.mesh as Reflector).dispose();
    this.mesh.geometry.dispose();
  }
}
