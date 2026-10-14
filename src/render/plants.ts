/**
 * Instanced plant rendering: one InstancedMesh with MAX_PLANTS capacity and a
 * procedural low-poly tuft geometry (merged cones + squashed blob, ~70 tris).
 * Per-instance growth (matrix scale), color (instanceColor, green varied by
 * hueShift and dried toward yellow at low growth) and a per-instance wind
 * phase attribute driving a cheap vertex sway injected via onBeforeCompile.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAX_PLANTS } from '../shared/constants';
import { PLANT_FLOATS, PLANT_HEADER } from '../shared/protocol';

/** World height (meters) of a fully grown plant (unit geometry is 1 tall). */
const PLANT_HEIGHT = 1.3;
/** Golden-angle constant: phase -> well-distributed deterministic yaw. */
const GOLDEN_ANGLE = 2.399963;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Procedural grass/shrub tuft: a ring of tilted 4-sided cones around one tall
 * central blade plus a squashed icosahedron base blob. Base sits at y = 0, the
 * tallest tip at y = 1. All parameters are deterministic constants (no assets,
 * no randomness) — per-plant variety comes from instance scale/yaw/color.
 */
function buildTuftGeometry(): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const BLADES = 6;
  for (let i = 0; i < BLADES; i++) {
    const center = i === 0;
    const height = center ? 1 : 0.52 + 0.11 * ((i * 5) % 4);
    const radius = 0.05 + 0.013 * ((i * 3) % 3);
    // 2 height segments give each blade a mid vertex so the wind bend curves.
    const cone = new THREE.ConeGeometry(radius, height, 4, 2, true);
    cone.translate(0, height / 2, 0); // pivot at the base
    if (!center) {
      cone.rotateX(0.26 + 0.13 * ((i * 7) % 3));
      const yaw = (i / BLADES) * Math.PI * 2 + i * 0.9;
      cone.rotateY(yaw);
      cone.translate(Math.cos(yaw) * 0.07, 0, Math.sin(yaw) * 0.07);
    }
    // De-index: the icosahedron blob is non-indexed and mergeGeometries
    // requires all-or-none indexing (also plays nicer with flat shading).
    pieces.push(cone.toNonIndexed());
    cone.dispose();
  }
  const blob = new THREE.IcosahedronGeometry(0.11, 0);
  blob.scale(1.5, 0.5, 1.5);
  blob.translate(0, 0.04, 0);
  pieces.push(blob);

  const merged = mergeGeometries(pieces) ?? pieces[0];
  for (const p of pieces) if (p !== merged) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Owns the single instanced mesh for every plant. Feed it plant snapshot
 * buffers from the worker (`applyPlants`) and call `update(dt, time)` each
 * frame for wind sway.
 */
export class PlantMeshes {
  private readonly mesh: THREE.InstancedMesh;
  private readonly phaseAttr: THREE.InstancedBufferAttribute;
  private readonly uTime: THREE.IUniform<number> = { value: 0 };
  private readonly uSwayAmp: THREE.IUniform<number> = { value: 0.05 };
  private lastCount = 0;
  // Scratch objects — applyPlants runs over ~2600 instances with zero allocation.
  private readonly mtx = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly col = new THREE.Color();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    const geometry = buildTuftGeometry();
    this.phaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PLANTS), 1);
    this.phaseAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aPhase', this.phaseAttr);

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff, // instanceColor carries the per-plant tint
      roughness: 0.85,
      metalness: 0,
      flatShading: true,
    });
    const uTime = this.uTime;
    const uSwayAmp = this.uSwayAmp;
    // Wind sway: bend the blade tops (weight = y^2 on the 0..1-tall unit
    // geometry) in local space, so instance scale also scales the sway and
    // zero-scaled instances are unaffected.
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.uniforms.uSwayAmp = uSwayAmp;
      shader.vertexShader =
        'attribute float aPhase;\nuniform float uTime;\nuniform float uSwayAmp;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
            'float swayW = max(transformed.y, 0.0); swayW *= swayW;\n' +
            'float swayT = uTime * 1.7 + aPhase;\n' +
            'transformed.x += (sin(swayT) + 0.4 * sin(swayT * 2.17)) * swayW * uSwayAmp;\n' +
            'transformed.z += cos(swayT * 0.87 + aPhase) * swayW * uSwayAmp * 0.7;',
        );
    };
    material.customProgramCacheKey = () => 'genesis-plant-sway';

    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_PLANTS);
    this.mesh.name = 'plants';
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Pre-create instanceColor so the shader compiles with instancing color on.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_PLANTS * 3).fill(1),
      3,
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // instances span the whole terrain
    scene.add(this.mesh);
  }

  /**
   * Refresh all instances from a plant snapshot buffer (layout in
   * src/shared/protocol.ts): [0] count, then x, y, z, scale01, phase, hueShift
   * per plant. Instances beyond the buffer's count are hidden.
   */
  applyPlants(data: Float32Array): void {
    const declared = data.length >= PLANT_HEADER ? data[0] | 0 : 0;
    const fit = Math.floor((data.length - PLANT_HEADER) / PLANT_FLOATS);
    const count = Math.max(0, Math.min(Math.min(declared, fit), MAX_PLANTS));

    let off = PLANT_HEADER;
    for (let i = 0; i < count; i++) {
      const x = data[off];
      const y = data[off + 1];
      const z = data[off + 2];
      const grow = clamp(data[off + 3], 0, 1);
      const phase = data[off + 4];
      const hueShift = clamp(data[off + 5], -1, 1);
      off += PLANT_FLOATS;

      // Deterministic per-plant yaw + slight width jitter from the stable phase.
      const s = (0.05 + 0.95 * grow) * PLANT_HEIGHT;
      const widthJ = 0.85 + 0.25 * (0.5 + 0.5 * Math.sin(phase * 3.7));
      this.pos.set(x, y, z);
      this.quat.setFromAxisAngle(PlantMeshes.UP, phase * GOLDEN_ANGLE);
      this.scl.set(s * widthJ, s, s * widthJ);
      this.mtx.compose(this.pos, this.quat, this.scl);
      this.mesh.setMatrixAt(i, this.mtx);

      // Healthy green shifted by the hue gene, drying toward yellow when small.
      const dry = clamp(1 - grow * 1.8, 0, 1);
      const h = clamp(0.3 + hueShift * 0.05 - dry * 0.15, 0.1, 0.42);
      const sat = 0.5 + 0.12 * (1 - dry);
      const lig = 0.28 + 0.13 * grow + 0.07 * dry;
      this.col.setHSL(h, sat, lig, THREE.SRGBColorSpace);
      this.mesh.setColorAt(i, this.col);
      this.phaseAttr.setX(i, phase);
    }

    // Zero-scale any stale tail so raycasts/shadow edge cases see nothing.
    if (count < this.lastCount) {
      this.mtx.makeScale(0, 0, 0);
      for (let i = count; i < this.lastCount; i++) this.mesh.setMatrixAt(i, this.mtx);
    }
    this.mesh.count = count;
    this.lastCount = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.phaseAttr.needsUpdate = true;
  }

  /** Advance the wind: `time` drives the sway oscillators and slow gusts. */
  update(_dt: number, time: number): void {
    this.uTime.value = time;
    this.uSwayAmp.value = 0.045 + 0.02 * (0.5 + 0.5 * Math.sin(time * 0.37));
  }
}
