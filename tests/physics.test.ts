/**
 * Physics layer tests (headless Rapier in Node): heightfield orientation and
 * placement, creature multibody construction, settling on the ground, motor
 * actuation, teardown, and same-seedless determinism (identical inputs =>
 * identical trajectories).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  addTerrain,
  buildCreature,
  createWorld,
  destroyCreature,
  driveJoint,
  initRapier,
  linVel,
  type CreaturePhysics,
} from '../src/sim/physics';
import { TISSUE_DENSITY } from '../src/shared/constants';
import type { BodyPlan, PlanPart, TerrainData, Vec3 } from '../src/shared/types';

beforeAll(async () => {
  await initRapier();
});

// ============================ fixtures =====================================

/** Hand-built TerrainData on the shared row-major convention (iz*(res+1)+ix). */
function makeTerrain(res: number, size: number, h: (ix: number, iz: number) => number): TerrainData {
  const n = res + 1;
  const heights = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      heights[iz * n + ix] = h(ix, iz);
    }
  }
  return {
    heights,
    res,
    size,
    waterLevel: 0,
    moisture: new Float32Array(n * n),
    fertility: new Float32Array(n * n),
  };
}

function capsuleVolume(radius: number, halfHeight: number): number {
  return Math.PI * radius * radius * (2 * halfHeight) + (4 / 3) * Math.PI * radius ** 3;
}

function boxVolume(he: Vec3): number {
  return 8 * he.x * he.y * he.z;
}

const PART_DEFAULTS = {
  eyes: [],
  smell: false,
  mouth: false,
  color: [0.5, 0.5, 0.5] as [number, number, number],
  patternFreq: 1,
  patternAmp: 0,
};

/**
 * 3-part plan built BY HAND (no development module): a box torso with two
 * vertical capsule legs hinged about z at the torso's +-x faces.
 */
function makePlan(): BodyPlan {
  const torsoSize = { x: 0.3, y: 0.15, z: 0.3 };
  const legR = 0.08;
  const legHH = 0.2;
  const torsoVol = boxVolume(torsoSize);
  const legVol = capsuleVolume(legR, legHH);
  const torso: PlanPart = {
    index: 0,
    geneId: 0,
    parentIndex: -1,
    shape: 'box',
    size: torsoSize,
    anchorOnParent: { x: 0, y: 0, z: 0 },
    anchorOnSelf: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    jointAxis: { x: 0, y: 0, z: 1 },
    jointLimits: [0, 0],
    maxTorque: 0,
    volume: torsoVol,
    mass: torsoVol * TISSUE_DENSITY,
    ...PART_DEFAULTS,
    mouth: true,
  };
  const leg = (index: number, side: 1 | -1): PlanPart => ({
    index,
    geneId: 1,
    parentIndex: 0,
    shape: 'capsule',
    size: { x: legR, y: legHH, z: 0 },
    anchorOnParent: { x: side * torsoSize.x, y: 0, z: 0 },
    anchorOnSelf: { x: 0, y: legHH + legR, z: 0 }, // top tip of the capsule
    rotation: { x: 0, y: 0, z: 0 },
    jointAxis: { x: 0, y: 0, z: 1 },
    jointLimits: [-1.2, 1.2],
    maxTorque: 80,
    volume: legVol,
    mass: legVol * TISSUE_DENSITY,
    ...PART_DEFAULTS,
  });
  const parts = [torso, leg(1, 1), leg(2, -1)];
  const totalMass = parts.reduce((s, p) => s + p.mass, 0);
  const totalVolume = parts.reduce((s, p) => s + p.volume, 0);
  return {
    parts,
    totalMass,
    totalVolume,
    numJoints: 2,
    numInputs: 3 + 8,
    numOutputs: 2,
    inputLabels: [],
    outputLabels: [],
    viable: true,
  };
}

/** Downward ray hit height at world (x, z), or null if nothing is hit. */
function groundHeightAt(world: RAPIER.World, x: number, z: number): number | null {
  const ray = new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, 200, true);
  return hit === null ? null : 50 - hit.timeOfImpact;
}

/** Angle (rad) of the relative rotation between two body orientations. */
function relAngle(a: RAPIER.Rotation, b: RAPIER.Rotation): number {
  // |dot| of unit quaternions = cos(theta/2) of the relative rotation
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

// ============================ heightfield ==================================

describe('addTerrain heightfield', () => {
  it('matches the row-major convention: height varying along x reads back along x', () => {
    const world = createWorld();
    // h = 0.1*ix: a pure x-gradient (would read as a z-gradient if the
    // column-major transpose were wrong).
    addTerrain(world, makeTerrain(8, 16, (ix) => 0.1 * ix));
    world.step(); // refresh query structures

    // world x=4 -> ix = (4/16+0.5)*8 = 6 -> h = 0.6 (exactly on a vertex)
    expect(groundHeightAt(world, 4, 0)).toBeCloseTo(0.6, 3);
    // world x=-4 -> ix = 2 -> h = 0.2, independent of z
    expect(groundHeightAt(world, -4, 0)).toBeCloseTo(0.2, 3);
    expect(groundHeightAt(world, -4, 6)).toBeCloseTo(0.2, 3);
    world.free();
  });

  it('matches along z too, and spans the full size centered at the origin', () => {
    const world = createWorld();
    addTerrain(world, makeTerrain(8, 16, (_ix, iz) => 0.1 * iz));
    world.step();

    expect(groundHeightAt(world, 0, 4)).toBeCloseTo(0.6, 3); // iz = 6
    expect(groundHeightAt(world, 0, -4)).toBeCloseTo(0.2, 3); // iz = 2
    expect(groundHeightAt(world, 6, -4)).toBeCloseTo(0.2, 3);
    // near corners (just inside the field) the field must still exist
    expect(groundHeightAt(world, -7.9, -7.9)).not.toBeNull();
    expect(groundHeightAt(world, 7.9, 7.9)).not.toBeNull();
    // outside the field there is nothing to hit
    expect(groundHeightAt(world, 9, 0)).toBeNull();
    world.free();
  });

  it('places constant heights at exactly that world height (scale.y = 1)', () => {
    const world = createWorld();
    addTerrain(world, makeTerrain(4, 10, () => 2.5));
    world.step();
    expect(groundHeightAt(world, 1.3, -2.2)).toBeCloseTo(2.5, 3);
    world.free();
  });
});

// ========================= creature construction ===========================

describe('buildCreature', () => {
  it('creates aligned bodies/colliders and parts-1 joints (sparse at 0)', () => {
    const world = createWorld();
    addTerrain(world, makeTerrain(4, 40, () => 0));
    const before = world.bodies.len();
    const plan = makePlan();
    const c = buildCreature(world, plan, { x: 0, y: 1, z: 0 }, 0.3);

    expect(c.bodies.length).toBe(3);
    expect(c.colliders.length).toBe(3);
    expect(world.bodies.len()).toBe(before + 3);
    expect(c.joints[0]).toBeUndefined();
    expect(c.joints[1]).toBeDefined();
    expect(c.joints[2]).toBeDefined();
    expect(world.impulseJoints.len()).toBe(2);

    // Rapier mass from collider density matches the plan's part mass
    for (let i = 0; i < 3; i++) {
      expect(c.bodies[i].mass()).toBeCloseTo(plan.parts[i].mass, 1);
    }
    // spawned fully above pos.y (lifted by bounding radius)
    for (const b of c.bodies) {
      expect(b.translation().y).toBeGreaterThan(1);
    }
    world.free();
  });

  it('settles on the ground instead of falling through', () => {
    const world = createWorld();
    addTerrain(world, makeTerrain(8, 40, () => 0));
    const plan = makePlan();
    const c = buildCreature(world, plan, { x: 0, y: 1.2, z: 0 }, 0);

    for (let t = 0; t < 120; t++) world.step();

    const rootY = c.bodies[0].translation().y;
    expect(rootY).toBeGreaterThan(-1); // not fallen through
    expect(rootY).toBeGreaterThan(0.05); // resting above the surface
    for (const b of c.bodies) {
      expect(b.translation().y).toBeGreaterThan(-1);
    }
    // settled: nearly zero vertical speed
    expect(Math.abs(linVel(c.bodies[0]).y)).toBeLessThan(0.5);
    world.free();
  });

  it('driveJoint changes the joint angle over steps', () => {
    const world = createWorld();
    addTerrain(world, makeTerrain(8, 40, () => 0));
    const plan = makePlan();
    const c = buildCreature(world, plan, { x: 0, y: 1.2, z: 0 }, 0);

    for (let t = 0; t < 60; t++) world.step(); // settle with motors at 0
    const before = relAngle(c.bodies[0].rotation(), c.bodies[1].rotation());
    for (let t = 0; t < 90; t++) {
      driveJoint(c.joints[1], 3, 200);
      world.step();
    }
    const after = relAngle(c.bodies[0].rotation(), c.bodies[1].rotation());
    expect(Math.abs(after - before)).toBeGreaterThan(0.1);
    world.free();
  });

  it('destroyCreature removes all bodies, joints and colliders', () => {
    const world = createWorld();
    addTerrain(world, makeTerrain(4, 40, () => 0));
    const bodies0 = world.bodies.len();
    const colliders0 = world.colliders.len();
    const joints0 = world.impulseJoints.len();

    const c = buildCreature(world, makePlan(), { x: 0, y: 1, z: 0 }, 0);
    expect(world.bodies.len()).toBe(bodies0 + 3);
    destroyCreature(world, c);

    expect(world.bodies.len()).toBe(bodies0);
    expect(world.colliders.len()).toBe(colliders0);
    expect(world.impulseJoints.len()).toBe(joints0);
    expect(c.bodies.length).toBe(0);
    expect(c.joints.length).toBe(0);
    expect(c.colliders.length).toBe(0);
    world.free();
  });
});

// ============================ determinism ==================================

describe('determinism', () => {
  function run(): { pos: Vec3; vel: Vec3 } {
    const world = createWorld();
    addTerrain(world, makeTerrain(8, 40, (ix, iz) => 0.03 * ix + 0.02 * iz));
    const c: CreaturePhysics = buildCreature(world, makePlan(), { x: 1, y: 1.2, z: -2 }, 0.7);
    for (let t = 0; t < 60; t++) {
      // identical command pattern in both runs
      driveJoint(c.joints[1], Math.sin(t * 0.2) * 4, 120);
      driveJoint(c.joints[2], Math.cos(t * 0.2) * 4, 120);
      world.step();
    }
    const p = c.bodies[0].translation();
    const v = linVel(c.bodies[0]);
    world.free();
    return { pos: { x: p.x, y: p.y, z: p.z }, vel: v };
  }

  it('two identical worlds stepped 60 ticks produce identical root states', () => {
    const a = run();
    const b = run();
    expect(a.pos.x).toBe(b.pos.x);
    expect(a.pos.y).toBe(b.pos.y);
    expect(a.pos.z).toBe(b.pos.z);
    expect(a.vel.x).toBe(b.vel.x);
    expect(a.vel.y).toBe(b.vel.y);
    expect(a.vel.z).toBe(b.vel.z);
  });
});
