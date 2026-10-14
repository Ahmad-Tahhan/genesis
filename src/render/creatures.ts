/**
 * Creature rendering: one THREE.Group of part meshes per creature, built from
 * the developed body plan sent at birth. Part transforms come exclusively from
 * worker snapshots (world-space position + quaternion per part, in
 * plan.parts order) — the renderer never computes the pose hierarchy itself.
 *
 * Geometry is shared: one unit capsule, one unit box and one tiny sphere (eye
 * and mouth dots), scaled per part via mesh.scale, so creature count never
 * multiplies geometry count.
 */
import * as THREE from 'three';
import type { CreatureInfo, PlanPart } from '../shared/types';
import { PART_FLOATS, SNAP_HEADER } from '../shared/protocol';
import { mouthMaterial, skinMaterial } from './materials';

/** Seconds a removed creature takes to sink and fade out. */
const FADE_SECONDS = 1.5;
/** Meters a fading corpse sinks into the ground. */
const SINK_DEPTH = 0.65;

// ----------------------- shared unit geometries ---------------------------
// A unit capsule spans y in [-2, 2]: cylinder length 2 plus two radius-1 caps.
const unitCapsule = new THREE.CapsuleGeometry(1, 2, 4, 10);
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitDot = new THREE.SphereGeometry(1, 6, 4);
const ringGeometry = new THREE.TorusGeometry(1, 0.035, 8, 48);

/** One shared glossy-black material for every eye dot. */
const eyeMaterial = new THREE.MeshStandardMaterial({
  color: 0x0d0d12,
  roughness: 0.3,
  metalness: 0,
});
eyeMaterial.name = 'eye';

// --------------------------- snapshot decoding ----------------------------

/**
 * Walk the creature snapshot layout from src/shared/protocol.ts:
 * header of SNAP_HEADER floats ([0] time, [1] creatureCount, [2] sunAngle,
 * [3] season phase), then per creature `id, partCount` followed by
 * `partCount * PART_FLOATS` floats (px py pz qx qy qz qw per part).
 *
 * Calls `visit(id, partCount, firstPartOffset)` for each creature whose data
 * fits in the buffer, stopping cleanly on truncation. Returns the number of
 * creatures visited. Pure — exported for unit tests.
 */
export function decodeCreatureSnapshot(
  data: Float32Array,
  visit: (id: number, partCount: number, firstPartOffset: number) => void,
): number {
  if (data.length < SNAP_HEADER) return 0;
  const declared = data[1] | 0;
  let off = SNAP_HEADER;
  let visited = 0;
  for (let c = 0; c < declared; c++) {
    if (off + 2 > data.length) break;
    const id = data[off] | 0;
    const partCount = data[off + 1] | 0;
    off += 2;
    if (partCount < 0 || off + partCount * PART_FLOATS > data.length) break;
    visit(id, partCount, off);
    visited++;
    off += partCount * PART_FLOATS;
  }
  return visited;
}

// ------------------------------ internals ---------------------------------

interface CreatureRec {
  id: number;
  group: THREE.Group;
  /** Part meshes aligned with plan.parts order. */
  parts: THREE.Mesh[];
  /** Per-mesh cloned materials while fading out (owned, disposed at the end). */
  fadeMats: THREE.Material[] | null;
  /** -1 while alive, else seconds since remove() was called. */
  dying: number;
  /** First snapshot received — until then the group is hidden. */
  hasPose: boolean;
}

/** mesh.scale for a part: capsule (r, (h+r)/2, r) matches the physics capsule's
 * total extent 2(h+r); box uses full extents 2*halfSize. */
function partScale(part: PlanPart, out: THREE.Vector3): void {
  if (part.shape === 'capsule') {
    const r = Math.max(part.size.x, 1e-3);
    const half = Math.max((part.size.y + r) / 2, 1e-3);
    out.set(r, half, r);
  } else {
    out.set(
      Math.max(2 * part.size.x, 1e-3),
      Math.max(2 * part.size.y, 1e-3),
      Math.max(2 * part.size.z, 1e-3),
    );
  }
}

/**
 * Point on the part's surface in part-local meters, along unit direction `d`
 * (capsule approximated by its bounding ellipsoid, box exact).
 */
function surfacePoint(part: PlanPart, d: THREE.Vector3, out: THREE.Vector3): void {
  if (part.shape === 'capsule') {
    const r = Math.max(part.size.x, 1e-3);
    const hy = Math.max(part.size.y + r, 1e-3);
    const inv = Math.sqrt((d.x * d.x + d.z * d.z) / (r * r) + (d.y * d.y) / (hy * hy));
    out.copy(d).multiplyScalar(inv > 1e-6 ? 1 / inv : 0);
  } else {
    const k = Math.max(
      Math.abs(d.x) / Math.max(part.size.x, 1e-3),
      Math.abs(d.y) / Math.max(part.size.y, 1e-3),
      Math.abs(d.z) / Math.max(part.size.z, 1e-3),
      1e-6,
    );
    out.copy(d).multiplyScalar(1 / k);
  }
}

/** Scratch objects for build-time math (add() is not a hot loop, but cheap anyway). */
const _dir = new THREE.Vector3();
const _surf = new THREE.Vector3();

/**
 * Add a tiny non-shadowing sphere dot (eye or mouth marker) as a child of a
 * scaled part mesh. Position/size are given in part-local meters and are
 * counter-scaled so the dot stays a true sphere under the parent's
 * non-uniform scale (the dot itself is never rotated, so this is exact).
 */
function addDot(
  parent: THREE.Mesh,
  posMeters: THREE.Vector3,
  radiusMeters: number,
  material: THREE.Material,
  creatureId: number,
): void {
  const dot = new THREE.Mesh(unitDot, material);
  dot.position.set(
    posMeters.x / parent.scale.x,
    posMeters.y / parent.scale.y,
    posMeters.z / parent.scale.z,
  );
  dot.scale.set(
    radiusMeters / parent.scale.x,
    radiusMeters / parent.scale.y,
    radiusMeters / parent.scale.z,
  );
  dot.castShadow = false;
  dot.receiveShadow = false;
  dot.matrixAutoUpdate = false;
  dot.updateMatrix();
  dot.userData.creatureId = creatureId;
  parent.add(dot);
}

// ------------------------------ public API --------------------------------

/**
 * Owns every creature's meshes: builds them on birth, poses them from
 * snapshot buffers, fades them out on death, and provides picking and the
 * selection ring. Add `update(dt)` to the render loop.
 */
export class CreatureMeshes {
  private readonly root = new THREE.Group();
  private readonly recs = new Map<number, CreatureRec>();
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private selectedId: number | null = null;
  private ringRadius = 1;
  private time = 0;
  /** Buffer currently being decoded (bound for the allocation-free visitor). */
  private snapData: Float32Array = new Float32Array(0);

  constructor(scene: THREE.Scene) {
    this.root.name = 'creatures';
    scene.add(this.root);

    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffdf8a,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(ringGeometry, this.ringMat);
    this.ring.name = 'selectionRing';
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    scene.add(this.ring);
  }

  /** Build and register the meshes for a newborn creature. */
  add(info: CreatureInfo): void {
    const existing = this.recs.get(info.id);
    if (existing) this.finalize(existing); // id reuse safety: replace instantly

    const group = new THREE.Group();
    group.name = `creature-${info.id}`;
    group.visible = false; // until the first snapshot poses it
    group.userData.creatureId = info.id;

    const parts: THREE.Mesh[] = [];
    for (let i = 0; i < info.plan.parts.length; i++) {
      const part = info.plan.parts[i];
      const mesh = new THREE.Mesh(
        part.shape === 'capsule' ? unitCapsule : unitBox,
        skinMaterial(info.plan, i),
      );
      partScale(part, mesh.scale);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false; // posed explicitly from snapshots
      mesh.updateMatrix();
      mesh.userData.creatureId = info.id;

      const minDim =
        part.shape === 'capsule'
          ? part.size.x
          : Math.min(part.size.x, Math.min(part.size.y, part.size.z));
      // Eye dots: one per evolved vision ray, sitting on the surface along it.
      if (part.eyes.length > 0) {
        const eyeR = Math.min(Math.max(minDim * 0.28, 0.018), 0.07);
        for (const eye of part.eyes) {
          _dir.set(eye.dir.x, eye.dir.y, eye.dir.z);
          if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
          _dir.normalize();
          surfacePoint(part, _dir, _surf);
          addDot(mesh, _surf, eyeR, eyeMaterial, info.id);
        }
      }
      // Mouth marker: a slightly darker dot at the tip (the end opposite the
      // attachment to the parent; +y for the root).
      if (part.mouth) {
        _dir.set(-part.anchorOnSelf.x, -part.anchorOnSelf.y, -part.anchorOnSelf.z);
        if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
        _dir.normalize();
        surfacePoint(part, _dir, _surf);
        const mouthR = Math.min(Math.max(minDim * 0.42, 0.025), 0.1);
        addDot(mesh, _surf, mouthR, mouthMaterial(part.color), info.id);
      }

      group.add(mesh);
      parts.push(mesh);
    }

    this.root.add(group);
    this.recs.set(info.id, {
      id: info.id,
      group,
      parts,
      fadeMats: null,
      dying: -1,
      hasPose: false,
    });
  }

  /** Begin the ~1.5 s sink/fade for a dead creature; disposal follows. */
  remove(id: number): void {
    const rec = this.recs.get(id);
    if (!rec || rec.dying >= 0) return;
    rec.dying = 0;
    const mats: THREE.Material[] = [];
    rec.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;
      // Clone so the shared/cached skin materials are untouched. Clones share
      // texture references; disposing a clone does not dispose its textures.
      const clone = (mesh.material as THREE.Material).clone();
      clone.transparent = true;
      mesh.material = clone;
      mesh.castShadow = false;
      mats.push(clone);
    });
    rec.fadeMats = mats;
  }

  /**
   * Pose every listed creature from a snapshot buffer (layout in
   * src/shared/protocol.ts). Creatures in the scene but missing from the
   * snapshot keep their last pose; unknown or fading ids are skipped.
   */
  applySnapshot(data: Float32Array): void {
    this.snapData = data;
    decodeCreatureSnapshot(data, this.poseVisitor);
  }

  /** Bound once — no per-frame closure allocation in the snapshot hot path. */
  private readonly poseVisitor = (id: number, partCount: number, firstPartOffset: number): void => {
    const rec = this.recs.get(id);
    if (!rec || rec.dying >= 0) return;
    const data = this.snapData;
    const n = Math.min(partCount, rec.parts.length);
    for (let i = 0; i < n; i++) {
      const b = firstPartOffset + i * PART_FLOATS;
      const mesh = rec.parts[i];
      mesh.position.set(data[b], data[b + 1], data[b + 2]);
      mesh.quaternion.set(data[b + 3], data[b + 4], data[b + 5], data[b + 6]);
      mesh.updateMatrix();
    }
    if (!rec.hasPose && n > 0) {
      rec.hasPose = true;
      rec.group.visible = true;
    }
  };

  /** Show the selection ring on a creature (or hide it with null). */
  setSelected(id: number | null): void {
    this.selectedId = id;
  }

  /** World position of a creature's root part, or null if unknown/unposed. */
  getPosition(id: number): THREE.Vector3 | null {
    const rec = this.recs.get(id);
    const rootMesh = rec ? rec.parts[0] : undefined;
    if (!rec || !rootMesh || !rec.hasPose) return null;
    return new THREE.Vector3(
      rootMesh.position.x,
      rootMesh.position.y + rec.group.position.y,
      rootMesh.position.z,
    );
  }

  /** Nearest living creature under the ray, or null. */
  pick(raycaster: THREE.Raycaster): number | null {
    const hits = raycaster.intersectObject(this.root, true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const id = o.userData.creatureId as number | undefined;
        if (id !== undefined) {
          const rec = this.recs.get(id);
          if (rec && rec.dying < 0 && rec.hasPose) return id;
          break; // fading or unposed — try the next (farther) hit
        }
        o = o.parent;
      }
    }
    return null;
  }

  /** Advance death fades and the selection ring pulse. */
  update(dt: number): void {
    this.time += dt;

    for (const rec of this.recs.values()) {
      if (rec.dying < 0) continue;
      rec.dying += dt;
      const k = Math.min(rec.dying / FADE_SECONDS, 1);
      rec.group.position.y = -SINK_DEPTH * k * k;
      if (rec.fadeMats) {
        const op = 1 - k;
        for (const m of rec.fadeMats) m.opacity = op;
      }
      if (k >= 1) this.finalize(rec); // Map deletion during iteration is safe
    }

    const sel = this.selectedId !== null ? this.recs.get(this.selectedId) : undefined;
    const selRoot = sel ? sel.parts[0] : undefined;
    if (sel && selRoot && sel.hasPose && sel.dying < 0) {
      let rad = 0.4;
      for (const m of sel.parts) {
        const dx = m.position.x - selRoot.position.x;
        const dz = m.position.z - selRoot.position.z;
        const ext = Math.max(m.scale.x, Math.max(m.scale.y, m.scale.z));
        const r = Math.sqrt(dx * dx + dz * dz) + ext;
        if (r > rad) rad = r;
      }
      this.ringRadius += (rad * 1.2 - this.ringRadius) * Math.min(1, dt * 6);
      const pulse = 1 + 0.06 * Math.sin(this.time * 4.2);
      this.ring.scale.setScalar(this.ringRadius * pulse);
      this.ring.position.set(
        selRoot.position.x,
        selRoot.position.y + sel.group.position.y + 0.04,
        selRoot.position.z,
      );
      this.ringMat.opacity = 0.55 + 0.25 * Math.sin(this.time * 4.2);
      this.ring.visible = true;
    } else {
      this.ring.visible = false;
    }
  }

  /** Number of living (non-fading) creatures in the scene. */
  count(): number {
    let n = 0;
    for (const rec of this.recs.values()) if (rec.dying < 0) n++;
    return n;
  }

  /** Remove a record from the scene and dispose everything it owns. */
  private finalize(rec: CreatureRec): void {
    this.root.remove(rec.group);
    if (rec.fadeMats) for (const m of rec.fadeMats) m.dispose();
    // Geometries and skin/eye/mouth materials are shared — never disposed here.
    this.recs.delete(rec.id);
  }
}
