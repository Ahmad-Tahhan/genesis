/**
 * Creature runtime: owns the physics multibody, the compiled brain network,
 * the energy store and health. Sensing/eating/reproduction orchestration
 * lives in world.ts; metabolism and actuation live here.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import type { BodyPlan, DeathCause, Genome, Vec3 } from '../shared/types';
import {
  CREATURE_MAX_HEALTH,
  DIET_BASE_EFF,
  DIGEST_LOSS,
  DT,
  HEALTH_REGEN,
  HEALTH_REGEN_COST,
  JOINT_MAX_SPEED,
  KLEIBER_COEFF,
  MUSCLE_ACTIVATION_COST,
  MUSCLE_WORK_COST,
  NEURON_COST,
  STORE_PER_MASS,
  SYNAPSE_COST,
  THERMO_COST_COEFF,
  TISSUE_ENERGY_DENSITY,
} from '../shared/constants';
import { Network } from './genome/brain';
import { driveJoint, type CreaturePhysics } from './physics';
import type { Ledger } from './ecology/ledger';

export class Creature {
  readonly id: number;
  readonly genome: Genome;
  readonly plan: BodyPlan;
  readonly phys: CreaturePhysics;
  readonly brain: Network;
  speciesId = -1;
  readonly generation: number;
  readonly parents: number[];

  /** Metabolizable store (E). Biomass (structural energy) is fixed at birth. */
  energy: number;
  readonly capacity: number;
  readonly biomass: number;
  health = CREATURE_MAX_HEALTH;
  age = 0;
  reproCooldown = 0;
  childCount = 0;
  dietPlant = 0;
  dietMeat = 0;
  submergedTime = 0;
  alive = true;
  deathCause: DeathCause | null = null;

  /** Per-part touch flags, decayed each tick, set by contact events. */
  readonly touch: Float32Array;
  /** Scratch: last brain outputs (for muscle cost + inspector). */
  readonly outputs: Float32Array;

  constructor(
    id: number,
    genome: Genome,
    plan: BodyPlan,
    phys: CreaturePhysics,
    startEnergy: number,
    parents: number[],
  ) {
    this.id = id;
    this.genome = genome;
    this.plan = plan;
    this.phys = phys;
    this.generation = genome.generation;
    this.parents = parents;
    this.capacity = STORE_PER_MASS * plan.totalMass;
    this.biomass = TISSUE_ENERGY_DENSITY * plan.totalMass;
    this.energy = Math.min(startEnergy, this.capacity);
    this.brain = new Network(genome.brain, plan.numInputs, plan.numOutputs);
    this.touch = new Float32Array(plan.parts.length);
    this.outputs = new Float32Array(plan.numOutputs);
  }

  /** Digestion efficiencies from the gut gene (trade-off spectrum). */
  get plantEff(): number {
    return (DIET_BASE_EFF + 0.7 * this.genome.organism.gutHerbivory) * (1 - DIGEST_LOSS);
  }
  get meatEff(): number {
    return (DIET_BASE_EFF + 0.7 * (1 - this.genome.organism.gutHerbivory)) * (1 - DIGEST_LOSS);
  }

  rootPos(): Vec3 {
    const t = this.phys.bodies[0].translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  /**
   * Run brain outputs into joint motors and expense muscle work.
   * Returns the muscle energy spent this tick (already booked by caller).
   */
  actuate(): number {
    let cost = 0;
    const parts = this.plan.parts;
    for (let i = 1; i < parts.length; i++) {
      const joint = this.phys.joints[i];
      if (!joint) continue;
      const o = clamp(this.brain.getOutput(i - 1), -1, 1);
      this.outputs[i - 1] = o;
      const part = parts[i];
      driveJoint(joint, o * JOINT_MAX_SPEED, part.maxTorque);
      // commanded torque x joint speed = mechanical power expensed as metabolic cost
      const wRel = jointSpeed(this.phys.bodies[i], this.phys.bodies[part.parentIndex]);
      cost += Math.abs(o) * part.maxTorque * wRel * DT * MUSCLE_WORK_COST;
      cost += (Math.abs(o) * part.maxTorque * 0.01) * MUSCLE_ACTIVATION_COST * DT;
    }
    return cost;
  }

  /**
   * Basal + brain + thermoregulation + provided muscle cost. Deducts from the
   * store and books heat on the ledger. Returns true if still alive.
   */
  metabolize(coldStress: number, muscleCost: number, ledger: Ledger): boolean {
    const m = this.plan.totalMass;
    const basal = KLEIBER_COEFF * Math.pow(m, 0.75);
    const brainCost =
      NEURON_COST * this.genome.brain.nodes.length +
      SYNAPSE_COST * this.genome.brain.conns.reduce((n, c) => n + (c.on ? 1 : 0), 0);
    const thermo = THERMO_COST_COEFF * Math.pow(m, 0.75) * coldStress;
    let spend = (basal + brainCost + thermo) * DT + muscleCost;

    // health regeneration costs energy
    if (this.health < CREATURE_MAX_HEALTH && this.energy > this.capacity * 0.5) {
      const heal = Math.min(HEALTH_REGEN * DT, CREATURE_MAX_HEALTH - this.health);
      this.health += heal;
      spend += heal * HEALTH_REGEN_COST;
    }

    const paid = Math.min(spend, this.energy);
    this.energy -= paid;
    ledger.creatureHeat(paid);
    if (this.energy <= 0) {
      this.die('starved');
      return false;
    }
    return true;
  }

  /** Absorb net energy already booked on the ledger (eating). */
  absorb(net: number, kind: 'plant' | 'meat'): void {
    this.energy = Math.min(this.energy + net, this.capacity);
    if (kind === 'plant') this.dietPlant += net;
    else this.dietMeat += net;
  }

  damage(amount: number, cause: DeathCause): boolean {
    this.health -= amount;
    if (this.health <= 0 && this.alive) {
      this.die(cause);
      return true;
    }
    return false;
  }

  die(cause: DeathCause): void {
    if (!this.alive) return;
    this.alive = false;
    this.deathCause = cause;
  }

  /** Total energy the corpse carries (store + structural biomass). */
  corpseEnergy(): number {
    return Math.max(0, this.energy) + this.biomass;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** |relative angular speed| between two bodies (rad/s), cheap proxy for joint speed. */
function jointSpeed(a: RAPIER.RigidBody, b: RAPIER.RigidBody): number {
  const wa = a.angvel();
  const wb = b.angvel();
  const x = wa.x - wb.x;
  const y = wa.y - wb.y;
  const z = wa.z - wb.z;
  const s = Math.sqrt(x * x + y * y + z * z);
  return s > JOINT_MAX_SPEED * 2 ? JOINT_MAX_SPEED * 2 : s;
}
