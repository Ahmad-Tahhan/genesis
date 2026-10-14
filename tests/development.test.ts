import { describe, expect, it } from 'vitest';
import type { BodyGene, BodyPlan, OrganismGenes } from '../src/shared/types';
import { EYE_INPUTS, INTERNAL_INPUTS, SMELL_INPUTS } from '../src/shared/types';
import { RNG } from '../src/shared/rng';
import {
  MAX_EYES_PER_PART,
  MAX_EYE_RAYS,
  MAX_PARTS,
  MAX_PART_DIM,
  MAX_RECURSION,
  MIN_PART_DIM,
  MUSCLE_TORQUE_PER_VOLUME,
  TISSUE_DENSITY,
} from '../src/shared/constants';
import { develop } from '../src/sim/genome/development';

/** A fully specified BodyGene with safe defaults; override per test. */
function gene(overrides: Partial<BodyGene> & { id: number; parent: number }): BodyGene {
  return {
    shape: 'box',
    size: { x: 0.2, y: 0.2, z: 0.2 },
    density: 1,
    anchor: { x: 0, y: -1, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    jointAxis: { x: 1, y: 0, z: 0 },
    jointLimits: [-1, 1],
    muscle: 0.5,
    recursion: 0,
    mirror: false,
    eyes: 0,
    eyeDir: { x: 0, y: 0, z: 1 },
    smell: false,
    mouth: false,
    color: [0.3, 0.6, 0.5],
    patternFreq: 3,
    patternAmp: 0.4,
    ...overrides,
  };
}

function org(overrides: Partial<OrganismGenes> = {}): OrganismGenes {
  return { gutHerbivory: 0.8, sexual: 0.5, offspringEnergyFrac: 0.3, sizeScale: 1, ...overrides };
}

/** Invariants every plan must satisfy, viable or not. */
function expectPlanInvariants(plan: BodyPlan): void {
  expect(plan.parts.length).toBeLessThanOrEqual(MAX_PARTS);
  expect(plan.numJoints).toBe(Math.max(0, plan.parts.length - 1));
  expect(plan.inputLabels.length).toBe(plan.numInputs);
  expect(plan.outputLabels.length).toBe(plan.numOutputs);
  expect(plan.numOutputs).toBe(Math.max(0, plan.parts.length - 1));
  let rays = 0;
  let smells = 0;
  let mass = 0;
  let volume = 0;
  for (const p of plan.parts) {
    expect(p.index).toBe(plan.parts.indexOf(p));
    if (p.parentIndex !== -1) expect(p.parentIndex).toBeLessThan(p.index);
    expect(p.mass).toBeGreaterThan(0);
    expect(p.volume).toBeGreaterThan(0);
    expect(p.maxTorque).toBeGreaterThanOrEqual(0);
    for (const c of [p.size.x, p.size.y, p.size.z]) {
      expect(c).toBeGreaterThanOrEqual(MIN_PART_DIM);
      expect(c).toBeLessThanOrEqual(MAX_PART_DIM);
    }
    expect(Math.hypot(p.jointAxis.x, p.jointAxis.y, p.jointAxis.z)).toBeCloseTo(1, 6);
    expect(p.jointLimits[0]).toBeLessThanOrEqual(0);
    expect(p.jointLimits[1]).toBeGreaterThanOrEqual(0);
    for (const e of p.eyes) expect(Math.hypot(e.dir.x, e.dir.y, e.dir.z)).toBeCloseTo(1, 6);
    rays += p.eyes.length;
    if (p.smell) smells++;
    mass += p.mass;
    volume += p.volume;
  }
  expect(rays).toBeLessThanOrEqual(MAX_EYE_RAYS);
  expect(plan.numInputs).toBe(
    plan.parts.length + rays * EYE_INPUTS + smells * SMELL_INPUTS + INTERNAL_INPUTS,
  );
  expect(plan.totalMass).toBeCloseTo(mass, 9);
  expect(plan.totalVolume).toBeCloseTo(volume, 9);
}

/** Random (but seed-determined) genome built without the body-ops module. */
function randomBody(rng: RNG): BodyGene[] {
  const n = 1 + rng.int(8);
  const genes: BodyGene[] = [];
  for (let i = 0; i < n; i++) {
    genes.push(
      gene({
        id: i * 3 + 1, // non-contiguous ids: order must come from ids, not indices
        parent: i === 0 ? -1 : genes[rng.int(i)].id,
        shape: rng.chance(0.5) ? 'capsule' : 'box',
        size: { x: rng.range(0.05, 0.7), y: rng.range(0.05, 0.7), z: rng.range(0.05, 0.7) },
        density: rng.range(0.6, 1.6),
        anchor: { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) },
        rotation: { x: rng.range(-3, 3), y: rng.range(-3, 3), z: rng.range(-3, 3) },
        jointAxis: { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) },
        jointLimits: [rng.range(-2, 0), rng.range(0, 2)],
        muscle: rng.next(),
        recursion: rng.int(MAX_RECURSION + 1),
        mirror: rng.chance(0.5),
        eyes: rng.int(MAX_EYES_PER_PART + 1),
        eyeDir: { x: rng.range(-1, 1), y: rng.range(-1, 1), z: rng.range(-1, 1) },
        smell: rng.chance(0.3),
        mouth: rng.chance(0.5),
      }),
    );
  }
  return genes;
}

function randomOrg(rng: RNG): OrganismGenes {
  return org({ gutHerbivory: rng.next(), sizeScale: rng.range(0.6, 1.8) });
}

describe('develop', () => {
  it('returns a non-viable plan with empty parts when there is no root gene', () => {
    const plan = develop([gene({ id: 1, parent: 0 }), gene({ id: 2, parent: 1 })], org());
    expect(plan.viable).toBe(false);
    expect(plan.parts).toEqual([]);
    expect(plan.numJoints).toBe(0);
    expect(plan.numOutputs).toBe(0);
    expect(plan.totalMass).toBe(0);
    expectPlanInvariants(plan);
  });

  it('is deterministic: the same genome develops to a deep-equal plan every time', () => {
    for (const seed of [1, 42, 777, 123456]) {
      const a = develop(randomBody(new RNG(seed)), randomOrg(new RNG(seed ^ 0x5f5f)));
      const b = develop(randomBody(new RNG(seed)), randomOrg(new RNG(seed ^ 0x5f5f)));
      expect(a).toEqual(b);
      expectPlanInvariants(a);
    }
  });

  it('does not mutate the input genome', () => {
    const body = randomBody(new RNG(9001));
    const organism = randomOrg(new RNG(9002));
    const bodyCopy = structuredClone(body);
    const orgCopy = structuredClone(organism);
    develop(body, organism);
    expect(body).toEqual(bodyCopy);
    expect(organism).toEqual(orgCopy);
  });

  it('builds a two-part body with documented anchors and viability', () => {
    const body = [
      gene({ id: 0, parent: -1, size: { x: 0.3, y: 0.25, z: 0.2 }, mouth: true }),
      gene({
        id: 1,
        parent: 0,
        shape: 'capsule',
        size: { x: 0.1, y: 0.3, z: 0.1 },
        anchor: { x: 0.5, y: -1, z: 0 },
      }),
    ];
    const plan = develop(body, org());
    expect(plan.viable).toBe(true);
    expect(plan.parts.length).toBe(2);
    const [rootPart, limb] = plan.parts;
    expect(rootPart.parentIndex).toBe(-1);
    expect(rootPart.anchorOnParent).toEqual({ x: 0, y: 0, z: 0 });
    expect(rootPart.anchorOnSelf).toEqual({ x: 0, y: 0, z: 0 });
    expect(limb.parentIndex).toBe(0);
    // anchorOnParent = normalized anchor * parent (box) half extents
    expect(limb.anchorOnParent.x).toBeCloseTo(0.5 * 0.3, 9);
    expect(limb.anchorOnParent.y).toBeCloseTo(-1 * 0.25, 9);
    expect(limb.anchorOnParent.z).toBeCloseTo(0, 9);
    // capsule hangs from its local top: (0, hh + r, 0)
    expect(limb.anchorOnSelf).toEqual({ x: 0, y: 0.3 + 0.1, z: 0 });
    expectPlanInvariants(plan);
  });

  it('chain recursion grows 1 + recursion copies linked through parentIndex', () => {
    const body = [
      gene({ id: 0, parent: -1, mouth: true }),
      gene({ id: 1, parent: 0, recursion: 2 }),
    ];
    const plan = develop(body, org());
    expect(plan.parts.length).toBe(4); // root + chain of 3
    expect(plan.parts[1].parentIndex).toBe(0);
    expect(plan.parts[2].parentIndex).toBe(1);
    expect(plan.parts[3].parentIndex).toBe(2);
    for (const i of [1, 2, 3]) expect(plan.parts[i].geneId).toBe(1);
    expect(plan.outputLabels).toEqual(['joint:1', 'joint:2', 'joint:3']);
    expectPlanInvariants(plan);
  });

  it('respects the MAX_PARTS hard cap on high-recursion mirrored genomes', () => {
    const body = [
      gene({ id: 0, parent: -1, mouth: true }),
      gene({ id: 1, parent: 0, recursion: MAX_RECURSION, mirror: true, anchor: { x: 0.8, y: -1, z: 0 } }),
      gene({ id: 2, parent: 1, recursion: MAX_RECURSION, mirror: true, anchor: { x: 0.6, y: -1, z: 0 } }),
    ];
    const plan = develop(body, org());
    // demand = 1 + 2*4 + 4*4 parts > MAX_PARTS, so the cap binds exactly
    expect(plan.parts.length).toBe(MAX_PARTS);
    expectPlanInvariants(plan);
  });

  it('mirror grows a sibling with mirrored anchor/rotation/axis and equal size', () => {
    const body = [
      gene({ id: 0, parent: -1, size: { x: 0.3, y: 0.3, z: 0.3 }, mouth: true }),
      gene({
        id: 1,
        parent: 0,
        mirror: true,
        size: { x: 0.12, y: 0.2, z: 0.15 },
        anchor: { x: 0.5, y: -0.4, z: 0.25 },
        rotation: { x: 0.3, y: 0.4, z: -0.2 },
        jointAxis: { x: 0, y: 0.6, z: 0.8 },
        jointLimits: [-0.9, 1.3],
      }),
    ];
    const plan = develop(body, org());
    expect(plan.parts.length).toBe(3);
    const [, left, right] = plan.parts;
    expect(left.geneId).toBe(1);
    expect(right.geneId).toBe(1);
    expect(left.size).toEqual(right.size);
    // anchors mirror in x only
    expect(right.anchorOnParent.x).toBeCloseTo(-left.anchorOnParent.x, 9);
    expect(left.anchorOnParent.x).not.toBeCloseTo(0, 3);
    expect(right.anchorOnParent.y).toBeCloseTo(left.anchorOnParent.y, 9);
    expect(right.anchorOnParent.z).toBeCloseTo(left.anchorOnParent.z, 9);
    expect(right.anchorOnSelf).toEqual(left.anchorOnSelf);
    // euler mirrors as (x, -y, -z)
    expect(right.rotation.x).toBeCloseTo(left.rotation.x, 9);
    expect(right.rotation.y).toBeCloseTo(-left.rotation.y, 9);
    expect(right.rotation.z).toBeCloseTo(-left.rotation.z, 9);
    // axial vector mirrors as (x, -y, -z); limits stay equal
    expect(right.jointAxis.x).toBeCloseTo(left.jointAxis.x, 9);
    expect(right.jointAxis.y).toBeCloseTo(-left.jointAxis.y, 9);
    expect(right.jointAxis.z).toBeCloseTo(-left.jointAxis.z, 9);
    expect(right.jointLimits).toEqual(left.jointLimits);
    expectPlanInvariants(plan);
  });

  it('propagates mirror parity to children of a mirrored branch', () => {
    const body = [
      gene({ id: 0, parent: -1, size: { x: 0.3, y: 0.3, z: 0.3 }, mouth: true }),
      gene({ id: 1, parent: 0, mirror: true, anchor: { x: 0.5, y: -1, z: 0 } }),
      gene({ id: 2, parent: 1, anchor: { x: 0.7, y: -1, z: 0.1 } }),
    ];
    const plan = develop(body, org());
    expect(plan.parts.length).toBe(5);
    const [, leftArm, rightArm, leftHand, rightHand] = plan.parts;
    expect(leftHand.parentIndex).toBe(leftArm.index);
    expect(rightHand.parentIndex).toBe(rightArm.index);
    expect(rightHand.anchorOnParent.x).toBeCloseTo(-leftHand.anchorOnParent.x, 9);
    expect(leftHand.anchorOnParent.x).not.toBeCloseTo(0, 3);
    expectPlanInvariants(plan);
  });

  it('caps whole-body eye rays at MAX_EYE_RAYS in part order', () => {
    const body = [
      gene({ id: 0, parent: -1, eyes: 3, mouth: true }),
      gene({ id: 1, parent: 0, mirror: true, eyes: 3, anchor: { x: 0.5, y: -1, z: 0 } }),
    ];
    const plan = develop(body, org());
    expect(plan.parts.map((p) => p.eyes.length)).toEqual([3, 3, 0]); // budget spent in creation order
    const rays = plan.parts.reduce((acc, p) => acc + p.eyes.length, 0);
    expect(rays).toBe(MAX_EYE_RAYS);
    expect(plan.inputLabels).toContain(`eye${MAX_EYE_RAYS - 1}.b`);
    expect(plan.inputLabels).not.toContain(`eye${MAX_EYE_RAYS}.dist`);
    expectPlanInvariants(plan);
  });

  it('lays out brain IO labels exactly matching numInputs/numOutputs (D17)', () => {
    const body = [
      gene({ id: 0, parent: -1, eyes: 2, smell: true, mouth: true }),
      gene({ id: 1, parent: 0 }),
    ];
    const plan = develop(body, org());
    // 2 touch + 2 rays * 4 + 1 smell * 4 + 8 internals = 22 inputs, 1 output
    expect(plan.numInputs).toBe(2 + 2 * EYE_INPUTS + SMELL_INPUTS + INTERNAL_INPUTS);
    expect(plan.inputLabels.length).toBe(plan.numInputs);
    expect(plan.numOutputs).toBe(1);
    expect(plan.outputLabels).toEqual(['joint:1']);
    expect(plan.inputLabels[0]).toBe('touch:0');
    expect(plan.inputLabels.slice(-INTERNAL_INPUTS)).toEqual([
      'hunger',
      'energyFrac',
      'health',
      'speed',
      'upright',
      'sinOsc',
      'cosOsc',
      'bias',
    ]);
    expectPlanInvariants(plan);
  });

  it('marks a genome without any mouth part as non-viable', () => {
    const body = [gene({ id: 0, parent: -1 }), gene({ id: 1, parent: 0 })];
    const plan = develop(body, org());
    expect(plan.parts.length).toBe(2);
    expect(plan.viable).toBe(false);
    // same body with a mouth is viable
    const withMouth = develop([gene({ id: 0, parent: -1, mouth: true }), body[1]], org());
    expect(withMouth.viable).toBe(true);
  });

  it('marks a lone root part (no joints) as non-viable', () => {
    const plan = develop([gene({ id: 0, parent: -1, mouth: true })], org());
    expect(plan.parts.length).toBe(1);
    expect(plan.viable).toBe(false);
  });

  it('computes box and capsule volume, mass and torque from the formulas', () => {
    const body = [
      gene({ id: 0, parent: -1, size: { x: 0.1, y: 0.2, z: 0.3 }, density: 0.8, muscle: 0.5, mouth: true }),
      gene({ id: 1, parent: 0, shape: 'capsule', size: { x: 0.2, y: 0.3, z: 0.1 }, density: 1.2, muscle: 1 }),
    ];
    const plan = develop(body, org());
    const boxVol = 8 * 0.1 * 0.2 * 0.3;
    const capVol = Math.PI * 0.2 * 0.2 * (2 * 0.3) + (4 / 3) * Math.PI * 0.2 ** 3;
    expect(plan.parts[0].volume).toBeCloseTo(boxVol, 12);
    expect(plan.parts[1].volume).toBeCloseTo(capVol, 12);
    expect(plan.parts[0].mass).toBeCloseTo(boxVol * TISSUE_DENSITY * 0.8, 9);
    expect(plan.parts[1].mass).toBeCloseTo(capVol * TISSUE_DENSITY * 1.2, 9);
    expect(plan.parts[0].maxTorque).toBeCloseTo(0.5 * MUSCLE_TORQUE_PER_VOLUME * boxVol, 9);
    expect(plan.parts[1].maxTorque).toBeCloseTo(1 * MUSCLE_TORQUE_PER_VOLUME * capVol, 9);
    expect(plan.totalVolume).toBeCloseTo(boxVol + capVol, 9);
    expect(plan.totalMass).toBeGreaterThan(0);
    expectPlanInvariants(plan);
  });

  it('applies sizeScale and clamps each size component to [MIN, MAX]', () => {
    const body = [
      gene({ id: 0, parent: -1, size: { x: 0.5, y: 0.3, z: 0.04 }, mouth: true }),
      gene({ id: 1, parent: 0, size: { x: 0.2, y: 0.2, z: 0.2 } }),
    ];
    const plan = develop(body, org({ sizeScale: 1.8 }));
    expect(plan.parts[0].size.x).toBeCloseTo(MAX_PART_DIM, 9); // 0.9 clamped down
    expect(plan.parts[0].size.y).toBeCloseTo(0.3 * 1.8, 9); // in range
    expect(plan.parts[0].size.z).toBeCloseTo(MIN_PART_DIM, 9); // 0.072 clamped up
    expect(plan.parts[1].size.x).toBeCloseTo(0.36, 9);
    expectPlanInvariants(plan);
  });

  it('normalizes the joint axis and falls back to +X when it is near zero', () => {
    const body = [
      gene({ id: 0, parent: -1, mouth: true }),
      gene({ id: 1, parent: 0, jointAxis: { x: 0, y: 0, z: 0 } }),
      gene({ id: 2, parent: 0, jointAxis: { x: 0, y: 3, z: 4 } }),
    ];
    const plan = develop(body, org());
    expect(plan.parts[1].jointAxis).toEqual({ x: 1, y: 0, z: 0 });
    expect(plan.parts[2].jointAxis.y).toBeCloseTo(0.6, 9);
    expect(plan.parts[2].jointAxis.z).toBeCloseTo(0.8, 9);
    expectPlanInvariants(plan);
  });

  it('sanitizes joint limits so lo <= 0 <= hi', () => {
    const body = [
      gene({ id: 0, parent: -1, mouth: true }),
      gene({ id: 1, parent: 0, jointLimits: [0.4, 1.2] }),
    ];
    const plan = develop(body, org());
    expect(plan.parts[1].jointLimits[0]).toBe(0);
    expect(plan.parts[1].jointLimits[1]).toBe(1.2);
  });
});
