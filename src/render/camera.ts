/**
 * Documentary camera: keeps a priority queue of interesting sim events and,
 * when the viewer is idle, smoothly chases the actors involved — lerping the
 * orbit target to the actor midpoint, holding an 8–18 m distance band and
 * orbiting gently. Manual input always wins and pauses auto mode for 12 s.
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SimEvent } from '../shared/types';

const UP = new THREE.Vector3(0, 1, 0);
const EVENT_EXPIRY = 20; // s an offered event stays eligible
const FOLLOW_SECONDS = 15; // s a picked/focused event is chased
const MANUAL_PAUSE = 12; // s of idle required after manual input
const QUEUE_CAP = 32;

interface Queued {
  e: SimEvent;
  expires: number;
}

/**
 * Auto-following "documentary" controller layered on top of OrbitControls.
 * `getPos` resolves a creature id to its current world position (may return a
 * reused scratch vector, or null once the creature is gone).
 */
export class DocCam {
  /** Master switch for automatic event-following; focusEvent works regardless. */
  auto = true;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly getPos: (id: number) => THREE.Vector3 | null;

  private readonly queue: Queued[] = [];
  private current: SimEvent | null = null;
  private explicit = false; // current came from focusEvent (user click)
  private followUntil = 0;
  private manualUntil = 0;
  private now = 0;

  private readonly mid = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    controls: OrbitControls,
    getPos: (id: number) => THREE.Vector3 | null,
  ) {
    this.camera = camera;
    this.controls = controls;
    this.getPos = getPos;
  }

  /** Offer an event for the auto queue (kept ~20 s, ranked by interest). */
  offerEvent(e: SimEvent): void {
    if (!Number.isFinite(e.interest)) return;
    this.queue.push({ e, expires: this.now + EVENT_EXPIRY });
    if (this.queue.length > QUEUE_CAP) {
      let lo = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i].e.interest < this.queue[lo].e.interest) lo = i;
      }
      this.queue.splice(lo, 1);
    }
  }

  /** Explicit user focus (e.g. timeline click): overrides queue and manual pause. */
  focusEvent(e: SimEvent): void {
    this.current = e;
    this.explicit = true;
    this.followUntil = this.now + FOLLOW_SECONDS;
    this.manualUntil = 0;
  }

  /** Call when the user grabs the controls; pauses auto-following for 12 s. */
  notifyManualInput(): void {
    this.manualUntil = this.now + MANUAL_PAUSE;
    this.current = null;
    this.explicit = false;
  }

  /** Advance the chase / pick logic; call once per frame before controls.update(). */
  update(dt: number): void {
    this.now += dt;
    // prune expired queue entries in place (no allocation)
    let w = 0;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].expires > this.now) this.queue[w++] = this.queue[i];
    }
    this.queue.length = w;

    if (this.now < this.manualUntil) return;

    if (this.current) {
      const alive = this.now <= this.followUntil && this.resolvePoint(this.current);
      const allowed = this.auto || this.explicit;
      if (!alive || !allowed) {
        this.current = null;
        this.explicit = false;
      } else {
        this.chase(dt);
        return;
      }
    }

    if (this.auto && this.queue.length > 0) this.pickBest();
  }

  /** Midpoint of the event's living actors (fallback: its recorded position). */
  private resolvePoint(e: SimEvent): boolean {
    let n = 0;
    this.mid.set(0, 0, 0);
    if (e.actors) {
      for (const id of e.actors) {
        const p = this.getPos(id);
        if (p) {
          this.mid.add(p); // getPos may reuse a scratch vector: consume now
          n++;
        }
      }
    }
    if (n > 0) {
      this.mid.multiplyScalar(1 / n);
      return true;
    }
    if (e.pos) {
      this.mid.set(e.pos.x, e.pos.y, e.pos.z);
      return true;
    }
    return false;
  }

  /** Smooth chase: lerp target to the actors, keep 8–18 m, gentle orbit. */
  private chase(dt: number): void {
    const k = 1 - Math.exp(-2.8 * dt);
    this.controls.target.lerp(this.mid, k);

    this.offset.copy(this.camera.position).sub(this.controls.target);
    let dist = this.offset.length();
    if (dist < 1e-3) {
      this.offset.set(6, 5, 6);
      dist = this.offset.length();
    }
    const desired = THREE.MathUtils.clamp(dist, 8, 18);
    this.offset.applyAxisAngle(UP, 0.07 * dt);
    // keep a little elevation so the shot stays readable
    if (this.offset.y < dist * 0.18) this.offset.y += (dist * 0.18 - this.offset.y) * k;
    this.offset.setLength(dist + (desired - dist) * (1 - Math.exp(-1.6 * dt)));
    this.camera.position.copy(this.controls.target).add(this.offset);
  }

  /** Pick the highest-interest queued event whose position resolves. */
  private pickBest(): void {
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      if (best === -1 || this.queue[i].e.interest > this.queue[best].e.interest) best = i;
    }
    if (best === -1) return;
    const picked = this.queue[best].e;
    if (!this.resolvePoint(picked)) return; // may resolve later or expire
    this.queue.splice(best, 1);
    this.current = picked;
    this.explicit = false;
    this.followUntil = this.now + FOLLOW_SECONDS;
  }
}
