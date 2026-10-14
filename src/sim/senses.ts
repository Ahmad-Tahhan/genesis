/**
 * Sensory system: vision rays (Rapier casts against creatures/terrain merged
 * with an analytic march against the plant grid), smell gradients from the
 * ecosystem fields, touch flags, and internal state — written into the brain
 * in the canonical IO order defined by types.ts/BodyPlan.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { TerrainData, Vec3 } from '../shared/types';
import { EYE_RANGE, PLANT_MAX_BIOMASS, SOIL_GRID_RES, TERRAIN_SIZE } from '../shared/constants';
import { hslToRgb, norm, rotateVec, type Quat } from './math3';
import type { Creature } from './creature';
import type { Ecosystem, Plant } from './ecology/plants';

export interface ColliderOwner {
  creature: Creature;
  part: number;
}

const PLANT_RGB: [number, number, number] = [0.22, 0.72, 0.28];
const TERRAIN_RGB: [number, number, number] = [0.42, 0.38, 0.3];

export class Senses {
  private readonly world: RAPIER.World;
  private readonly eco: Ecosystem;
  private readonly owners: Map<number, ColliderOwner>;
  private readonly cells: Plant[][];
  private readonly cellSize: number;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor(world: RAPIER.World, eco: Ecosystem, _terrain: TerrainData, owners: Map<number, ColliderOwner>) {
    this.world = world;
    this.eco = eco;
    this.owners = owners;
    this.cells = Array.from({ length: SOIL_GRID_RES * SOIL_GRID_RES }, () => []);
    this.cellSize = TERRAIN_SIZE / SOIL_GRID_RES;
  }

  /** Rebuild the plant spatial hash (plants move never, grow slowly — call every N ticks). */
  rebuildPlantIndex(): void {
    for (const c of this.cells) c.length = 0;
    for (const p of this.eco.plants) {
      if (!p.alive || p.biomass < 0.25) continue;
      const i = this.cellIndex(p.x, p.z);
      if (i >= 0) this.cells[i].push(p);
    }
  }

  private cellIndex(x: number, z: number): number {
    const half = TERRAIN_SIZE / 2;
    const cx = Math.floor((x + half) / this.cellSize);
    const cz = Math.floor((z + half) / this.cellSize);
    if (cx < 0 || cz < 0 || cx >= SOIL_GRID_RES || cz >= SOIL_GRID_RES) return -1;
    return cz * SOIL_GRID_RES + cx;
  }

  /**
   * Fill all brain inputs for a creature. Order per BodyPlan contract:
   * per part [touch, eye rays x4..., smell x4], then 8 internals.
   */
  fillInputs(c: Creature, time: number, selfColliders: Set<number>): void {
    let k = 0;
    const parts = c.plan.parts;
    const rootBody = c.phys.bodies[0];
    const rootRot = rootBody.rotation() as Quat;
    const fwd = rotateVec(rootRot, { x: 0, y: 0, z: 1 });

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const body = c.phys.bodies[i];
      const pos = body.translation();
      const rot = body.rotation() as Quat;

      c.brain.setInput(k++, c.touch[i]);

      for (const eye of part.eyes) {
        const dir = norm(rotateVec(rot, eye.dir));
        const hit = this.castEye(pos, dir, selfColliders);
        c.brain.setInput(k++, hit[0]);
        c.brain.setInput(k++, hit[1]);
        c.brain.setInput(k++, hit[2]);
        c.brain.setInput(k++, hit[3]);
      }

      if (part.smell) {
        const sp = this.eco.smellPlant(pos.x, pos.z);
        const sc = this.eco.smellCarrion(pos.x, pos.z);
        c.brain.setInput(k++, squash(sp.v));
        c.brain.setInput(k++, squash(sp.gx * fwd.x + sp.gz * fwd.z, 8));
        c.brain.setInput(k++, squash(sc.v));
        c.brain.setInput(k++, squash(sc.gx * fwd.x + sc.gz * fwd.z, 8));
      }
    }

    // internals: hunger, energyFrac, health, speed, upright, sinOsc, cosOsc, bias
    const eFrac = c.energy / c.capacity;
    const lv = rootBody.linvel();
    const speed = Math.min(1, Math.hypot(lv.x, lv.y, lv.z) / 8);
    const up = rotateVec(rootRot, { x: 0, y: 1, z: 0 }).y;
    c.brain.setInput(k++, 1 - eFrac);
    c.brain.setInput(k++, eFrac);
    c.brain.setInput(k++, c.health / 100);
    c.brain.setInput(k++, speed);
    c.brain.setInput(k++, up);
    c.brain.setInput(k++, Math.sin(time * Math.PI * 3));
    c.brain.setInput(k++, Math.cos(time * Math.PI * 3));
    c.brain.setInput(k, 1);
  }

  /** Returns [proximity(0..1), r, g, b]; proximity 0 when nothing in range. */
  private castEye(origin: Vec3, dir: Vec3, selfColliders: Set<number>): [number, number, number, number] {
    // physics hit (creatures + terrain)
    this.ray.origin.x = origin.x;
    this.ray.origin.y = origin.y;
    this.ray.origin.z = origin.z;
    this.ray.dir.x = dir.x;
    this.ray.dir.y = dir.y;
    this.ray.dir.z = dir.z;
    let bestDist = EYE_RANGE;
    let rgb: [number, number, number] | null = null;

    const hit = this.world.castRay(
      this.ray,
      EYE_RANGE,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      (collider: RAPIER.Collider) => !selfColliders.has(collider.handle),
    );
    if (hit) {
      bestDist = hit.timeOfImpact;
      const owner = this.owners.get(hit.collider.handle);
      if (owner) {
        const col = owner.creature.plan.parts[owner.part]?.color ?? owner.creature.plan.parts[0].color;
        rgb = hslToRgb(col[0], col[1] * 0.8 + 0.2, col[2] * 0.6 + 0.2);
      } else {
        rgb = TERRAIN_RGB;
      }
    }

    // plant march (grid DDA, coarse)
    const step = this.cellSize * 0.8;
    for (let d = step * 0.5; d < bestDist; d += step) {
      const px = origin.x + dir.x * d;
      const pz = origin.z + dir.z * d;
      const py = origin.y + dir.y * d;
      const ci = this.cellIndex(px, pz);
      if (ci < 0) break;
      for (const p of this.cells[ci]) {
        const r = 0.4 + (p.biomass / PLANT_MAX_BIOMASS) * 0.8;
        const dx = p.x - px;
        const dy = p.y + r * 0.5 - py;
        const dz = p.z - pz;
        if (dx * dx + dy * dy + dz * dz < r * r) {
          const pd = d;
          if (pd < bestDist) {
            bestDist = pd;
            rgb = PLANT_RGB;
          }
          break;
        }
      }
      if (rgb === PLANT_RGB) break;
    }

    if (!rgb) return [0, 0, 0, 0];
    return [1 - bestDist / EYE_RANGE, rgb[0], rgb[1], rgb[2]];
  }
}

function squash(v: number, gain = 1): number {
  return Math.tanh(v * gain);
}
