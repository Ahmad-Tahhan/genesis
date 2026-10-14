/**
 * Rapier physics layer for the simulation worker (also used headless in
 * vitest/Node). Owns world creation, the terrain heightfield collider and the
 * creature multibody builder (rigid bodies + capsule/box colliders +
 * motor-driven revolute joints). No three.js off the main thread — the small
 * amount of quaternion math needed for rest-pose placement is inlined.
 *
 * Verified against @dimforge/rapier3d-compat 0.14 typings:
 *  - ColliderDesc.heightfield(nrows, ncols, heights, scale): heights is a
 *    column-major (nrows+1)x(ncols+1) matrix, rows advance along local +z and
 *    columns along local +x; the field spans scale.x by scale.z CENTERED at
 *    the collider origin and heights are multiplied by scale.y.
 *  - JointData.revolute(anchor1, anchor2, axis): one axis, interpreted in the
 *    local space of BOTH bodies (frames built from the same axis per body).
 *  - UnitImpulseJoint.configureMotorVelocity(targetVel, factor): factor is the
 *    motor damping; with MotorModel.ForceBased the applied torque is
 *    factor * (targetVel - jointVel). No max-force setter exists in 0.14, so
 *    torque is bounded via the factor (see driveJoint).
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { BodyPlan, PlanPart, TerrainData, Vec3 } from '../shared/types';
import { DT, GRAVITY, GROUND_FRICTION, JOINT_MAX_SPEED, TISSUE_DENSITY } from '../shared/constants';

// ========================= collision groups ================================

/** Collision-group membership bit of the terrain heightfield collider. */
export const GROUP_TERRAIN = 0x0001;
/** Collision-group membership bit of every creature part collider. */
export const GROUP_CREATURE = 0x0002;

// InteractionGroups packing: memberships in the high 16 bits, filter in the
// low 16. Everything collides with everything; groups exist for ray filtering.
const TERRAIN_GROUPS = ((GROUP_TERRAIN << 16) | 0xffff) >>> 0;
const CREATURE_GROUPS = ((GROUP_CREATURE << 16) | 0xffff) >>> 0;

// ============================ tunables =====================================

// Drag giving a slightly viscous air/ground feel; metabolic cost of motion is
// booked separately by the energy ledger (DECISIONS.md D4).
const LINEAR_DAMPING = 0.18;
const ANGULAR_DAMPING = 0.6;
/** Friction of creature part colliders. */
const PART_FRICTION = 0.9;
/** Gap left between the lowest part's bounding sphere and pos.y at spawn. */
const SPAWN_CLEARANCE = 0.02;
/** Colliders may not have degenerate dimensions; plan sizes are clamped up. */
const MIN_DIM = 0.01;

// ======================== inline quaternion math ===========================

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Rotate v by unit quaternion q. */
function quatRotate(q: Quat, v: Vec3): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

// =============================== init ======================================

let rapierReady: Promise<typeof RAPIER> | null = null;

/**
 * Loads the Rapier wasm module. Idempotent: concurrent/repeated calls share
 * one underlying RAPIER.init(). Must resolve before any other export is used.
 */
export async function initRapier(): Promise<typeof RAPIER> {
  if (rapierReady === null) {
    rapierReady = RAPIER.init().then(() => RAPIER);
  }
  return rapierReady;
}

// =============================== world =====================================

/**
 * New physics world with gravity (0, GRAVITY, 0) and fixed timestep DT.
 * Requires initRapier() to have resolved.
 */
export function createWorld(): RAPIER.World {
  const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
  world.timestep = DT;
  // Soft contacts: developed bodies can spawn with interpenetrating sibling
  // parts; the default 30 Hz penetration recovery ejects them at hundreds of
  // m/s (through the heightfield). Gentler recovery + the world's velocity
  // clamps keep births calm.
  world.integrationParameters.contact_natural_frequency = 8;
  return world;
}

/**
 * Static heightfield collider matching the render mesh exactly: the TerrainData
 * grid (row-major, index = iz*(res+1)+ix, x along ix, z along iz) is transposed
 * into Rapier's column-major (res+1)x(res+1) matrix (columns along +x, rows
 * along +z), spanning TERRAIN_SIZE x TERRAIN_SIZE centered at the origin.
 * scale.y = 1 and translation 0 so world surface height equals the raw height
 * values. Friction GROUND_FRICTION, membership GROUP_TERRAIN, collides with all.
 */
export function addTerrain(world: RAPIER.World, terrain: TerrainData): RAPIER.Collider {
  const res = terrain.res;
  const n = res + 1;
  // column-major: entry (row=iz, col=ix) at index ix*n + iz — a transpose of
  // our row-major layout (iz*n + ix). Getting this wrong swaps x/z and lets
  // creatures fall through anywhere the terrain is asymmetric.
  const colMajor = new Float32Array(n * n);
  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) {
      colMajor[ix * n + iz] = terrain.heights[iz * n + ix];
    }
  }
  const desc = RAPIER.ColliderDesc.heightfield(res, res, colMajor, {
    x: terrain.size,
    y: 1,
    z: terrain.size,
  })
    .setFriction(GROUND_FRICTION)
    .setCollisionGroups(TERRAIN_GROUPS);
  const collider = world.createCollider(desc);

  // Perimeter walls: beyond the heightfield there is no floor, so creatures
  // that wander off the edge would fall forever. Low-friction invisible walls
  // keep everything inside the simulated world.
  const half = terrain.size / 2;
  const wallH = 60;
  const walls: [number, number, number, number, number][] = [
    // [cx, cz, hx, hz, _]
    [half + 1, 0, 1, half + 2, 0],
    [-half - 1, 0, 1, half + 2, 0],
    [0, half + 1, half + 2, 1, 0],
    [0, -half - 1, half + 2, 1, 0],
  ];
  for (const [cx, cz, hx, hz] of walls) {
    const w = RAPIER.ColliderDesc.cuboid(hx, wallH, hz)
      .setTranslation(cx, wallH / 2 - 5, cz)
      .setFriction(0.05)
      .setCollisionGroups(TERRAIN_GROUPS);
    world.createCollider(w);
  }
  return collider;
}

// ============================= creatures ===================================

/** Physics handles of one creature, index-aligned with plan.parts. */
export interface CreaturePhysics {
  /** bodies[i] is the rigid body of plan.parts[i]. */
  bodies: RAPIER.RigidBody[];
  /**
   * Sparse: joints[i] is the revolute joint connecting part i to its parent;
   * joints[0] is a hole (the root has no joint). Runtime instances are
   * RevoluteImpulseJoint with motor model ForceBased and velocity motor at 0.
   */
  joints: RAPIER.ImpulseJoint[];
  /** colliders[i] is the collider of plan.parts[i]. */
  colliders: RAPIER.Collider[];
}

/** Radius of a sphere bounding the part in any orientation. */
function partBoundRadius(p: PlanPart): number {
  return p.shape === 'capsule'
    ? p.size.y + p.size.x
    : Math.hypot(p.size.x, p.size.y, p.size.z);
}

/**
 * Velocity-motor damping factor such that, under MotorModel.ForceBased, the
 * motor torque factor*(targetVel - jointVel) never exceeds maxTorque while
 * both velocities stay within +-JOINT_MAX_SPEED (the worst-case velocity
 * error is 2*JOINT_MAX_SPEED). This is how maxTorque is honored: Rapier 0.14
 * JS exposes no motor max-force setter.
 */
function motorFactor(maxTorque: number): number {
  return Math.max(0, maxTorque) / (2 * JOINT_MAX_SPEED);
}

/**
 * Builds the articulated multibody for a developed plan at pos with the given
 * yaw (radians about +y).
 *
 * Placement: parts are walked in plan order (a parent always precedes its
 * children); childRot = parentRot * euler(rotation), child world pos =
 * parent pos + parentRot*anchorOnParent - childRot*anchorOnSelf. The whole
 * creature is then lifted so the lowest part's bounding sphere clears pos.y
 * (the caller already places pos.y above the terrain).
 *
 * Bodies are dynamic with linear damping 0.18 / angular damping 0.6; CCD is
 * enabled on the root only. Collider density = part.mass / part.volume so
 * Rapier's computed mass matches the plan's. Joints are revolute at the
 * anchors with the plan's jointAxis; Rapier's single-axis revolute interprets
 * the axis in BOTH local frames, so a rest `rotation` contributes only its
 * about-axis component as the initial joint angle (off-axis rest rotation is
 * corrected by the solver within the first steps). Limits come from the plan;
 * contacts between joined parts are disabled; motors start at velocity 0.
 */
export function buildCreature(
  world: RAPIER.World,
  plan: BodyPlan,
  pos: Vec3,
  yaw: number,
): CreaturePhysics {
  const parts = plan.parts;
  const n = parts.length;
  const rots: Quat[] = new Array(n);
  const poss: Vec3[] = new Array(n);

  // rest pose (before lift)
  for (let i = 0; i < n; i++) {
    const part = parts[i];
    if (part.parentIndex < 0) {
      rots[i] = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
      poss[i] = { x: pos.x, y: pos.y, z: pos.z };
    } else {
      if (part.parentIndex >= i) {
        throw new Error('BodyPlan parts must be in development order (parent before child)');
      }
      const pRot = rots[part.parentIndex];
      // Spawn in the joint-rest pose (child aligned with parent): a revolute
      // joint cannot represent the plan's off-axis rest rotation, and spawning
      // rotated makes the solver snap multi-ton parts into frame at hundreds
      // of m/s. Morphology comes from anchors, axes, limits and motor use;
      // plan.rotation stays genome data only (DECISIONS.md D27).
      const rot = pRot;
      const a = quatRotate(pRot, part.anchorOnParent);
      const b = quatRotate(rot, part.anchorOnSelf);
      const pp = poss[part.parentIndex];
      rots[i] = rot;
      poss[i] = { x: pp.x + a.x - b.x, y: pp.y + a.y - b.y, z: pp.z + a.z - b.z };
    }
  }

  // lift so the lowest bounding sphere clears pos.y
  let lowest = Infinity;
  for (let i = 0; i < n; i++) {
    lowest = Math.min(lowest, poss[i].y - partBoundRadius(parts[i]));
  }
  const lift = Math.max(0, pos.y - lowest) + SPAWN_CLEARANCE;

  const bodies: RAPIER.RigidBody[] = new Array(n);
  const colliders: RAPIER.Collider[] = new Array(n);
  const joints: RAPIER.ImpulseJoint[] = new Array(n); // holes stay undefined

  for (let i = 0; i < n; i++) {
    const part = parts[i];
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(poss[i].x, poss[i].y + lift, poss[i].z)
      .setRotation(rots[i])
      .setLinearDamping(LINEAR_DAMPING)
      .setAngularDamping(ANGULAR_DAMPING);
    // CCD on every part: solver bursts (joint conflicts, overlap recovery on
    // extreme mass ratios) must never carry a body through the heightfield.
    bodyDesc.setCcdEnabled(true);
    const body = world.createRigidBody(bodyDesc);
    bodies[i] = body;

    const sx = Math.max(part.size.x, MIN_DIM);
    const sy = Math.max(part.size.y, MIN_DIM);
    const sz = Math.max(part.size.z, MIN_DIM);
    const colDesc =
      part.shape === 'capsule'
        ? RAPIER.ColliderDesc.capsule(sy, sx) // local y axis; x = radius, y = half height
        : RAPIER.ColliderDesc.cuboid(sx, sy, sz);
    // plan.mass already encodes the gene density; collider density in kg/m^3
    const density = part.volume > 1e-9 ? part.mass / part.volume : TISSUE_DENSITY;
    colDesc.setDensity(density).setFriction(PART_FRICTION).setCollisionGroups(CREATURE_GROUPS);
    colliders[i] = world.createCollider(colDesc, body);

    if (part.parentIndex >= 0) {
      const jd = RAPIER.JointData.revolute(part.anchorOnParent, part.anchorOnSelf, part.jointAxis);
      const joint = world.createImpulseJoint(
        jd,
        bodies[part.parentIndex],
        body,
        true,
      ) as RAPIER.RevoluteImpulseJoint;
      joint.setContactsEnabled(false); // adjacent parts must not fight their joint
      joint.setLimits(part.jointLimits[0], part.jointLimits[1]);
      joint.configureMotorModel(RAPIER.MotorModel.ForceBased);
      joint.configureMotorVelocity(0, motorFactor(part.maxTorque));
      joints[i] = joint;
    }
  }

  return { bodies, joints, colliders };
}

/**
 * Removes every joint, body and collider of the creature from the world
 * (colliders go with their bodies) and empties the handle arrays so stale
 * handles cannot be used after death.
 */
export function destroyCreature(world: RAPIER.World, c: CreaturePhysics): void {
  for (const j of c.joints) {
    if (j) world.removeImpulseJoint(j, true);
  }
  for (const b of c.bodies) {
    world.removeRigidBody(b);
  }
  c.bodies.length = 0;
  c.joints.length = 0;
  c.colliders.length = 0;
}

/**
 * Commands a revolute motor. targetVel (rad/s) is capped to
 * +-JOINT_MAX_SPEED. maxTorque (N*m) maps to the ForceBased velocity-motor
 * damping factor maxTorque/(2*JOINT_MAX_SPEED): applied torque is
 * factor*(targetVel - jointVel), hence bounded by maxTorque while the joint
 * speed stays within +-JOINT_MAX_SPEED. Assumes the joint was built by
 * buildCreature (motor model already ForceBased).
 */
export function driveJoint(joint: RAPIER.ImpulseJoint, targetVel: number, maxTorque: number): void {
  const v = Math.max(-JOINT_MAX_SPEED, Math.min(JOINT_MAX_SPEED, targetVel));
  (joint as RAPIER.RevoluteImpulseJoint).configureMotorVelocity(v, motorFactor(maxTorque));
}

/** Linear velocity of a body as a plain Vec3 (copy, safe to retain). */
export function linVel(body: RAPIER.RigidBody): Vec3 {
  const v = body.linvel();
  return { x: v.x, y: v.y, z: v.z };
}
