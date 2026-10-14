/**
 * Renderer shell: WebGL renderer, scene, camera + OrbitControls, sky/sun rig,
 * terrain mesh, reflective water and the documentary camera. The sim worker
 * never appears here — the composer (main.ts) feeds terrain, sun state and
 * events in and calls `frame()` once per rAF.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { TerrainData } from '../shared/types';
import { buildTerrainMesh } from './terrainMesh';
import { SkyRig } from './sky';
import { WaterRig } from './water';
import { DocCam } from './camera';

/**
 * Main-thread rendering shell. Usage per frame:
 *   renderer.setSun(sunAngle, seasonPhase); renderer.frame(dt, simTime);
 *
 * DocCam actor positions resolve, by default, by scanning the scene for an
 * object with `userData.creatureId === id` (or `name === 'creature:<id>'`),
 * cached per id; call `setPositionResolver()` to wire an explicit lookup.
 */
export class Renderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly docCam: DocCam;

  private readonly webgl: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly skyRig: SkyRig;
  private readonly container: HTMLElement;
  private waterRig: WaterRig | null = null;
  private terrainMesh: THREE.Mesh | null = null;

  private readonly lastSunDir = new THREE.Vector3(0, 1, 0);
  private fpsSmoothed = 60;
  private posResolver: ((id: number) => THREE.Vector3 | null) | null = null;
  private readonly actorCache = new Map<number, THREE.Object3D>();
  private readonly actorScratch = new THREE.Vector3();
  private readonly onResize: () => void;
  private readonly resizeObserver: ResizeObserver | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.webgl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.webgl.setSize(width, height);
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.1;
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.webgl.setClearColor(0x0a0f1c, 1);
    this.canvas = this.webgl.domElement;
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xc7d6e8, 110, 840);

    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.5, 2500);
    this.camera.position.set(70, 60, 100);

    this.skyRig = new SkyRig(this.scene);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05; // just under the horizon
    this.controls.minDistance = 4;
    this.controls.maxDistance = 160;
    this.controls.target.set(0, 6, 0);
    this.docCam = new DocCam(this.camera, this.controls, (id) => this.resolveActorPosition(id));
    this.controls.addEventListener('start', () => this.docCam.notifyManualInput());

    this.onResize = () => {
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || window.innerHeight;
      if (w === 0 || h === 0) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.webgl.setSize(w, h);
    };
    window.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(container);
    }
  }

  /** Build terrain mesh + water and fit the camera's opening pose over them. */
  buildTerrain(t: TerrainData): void {
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
      (this.terrainMesh.material as THREE.Material).dispose();
    }
    if (this.waterRig) {
      this.waterRig.dispose();
      this.waterRig = null;
    }

    this.terrainMesh = buildTerrainMesh(t);
    this.scene.add(this.terrainMesh);
    this.waterRig = new WaterRig(this.scene, t);

    // opening pose: overlooking the terrain center
    const half = t.res >> 1;
    const centerH = t.heights[half * (t.res + 1) + half];
    const cy = Math.max(centerH, t.waterLevel);
    this.controls.target.set(0, cy + 2, 0);
    this.camera.position.set(t.size * 0.26, cy + t.size * 0.24, t.size * 0.4);
    this.controls.update();
    this.skyRig.focus.copy(this.controls.target);
  }

  /** Reposition sun/moon and retint lighting + fog for the time of day. */
  setSun(sunAngle: number, seasonPhase: number): void {
    this.skyRig.focus.copy(this.controls.target);
    const s = this.skyRig.update(sunAngle, seasonPhase);
    this.lastSunDir.copy(s.sunDir);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.skyRig.fogColor);
    fog.near = THREE.MathUtils.lerp(70, 110, s.dayness);
    fog.far = THREE.MathUtils.lerp(540, 840, s.dayness);
  }

  /** Doc-cam + controls update, water animation, render; `time` is sim time. */
  frame(dt: number, time: number): void {
    this.skyRig.setTime(time);
    this.docCam.update(dt);
    this.controls.update();
    if (this.waterRig) this.waterRig.update(time, this.lastSunDir);
    if (dt > 0) {
      const inst = Math.min(240, 1 / dt);
      this.fpsSmoothed += (inst - this.fpsSmoothed) * 0.07;
    }
    this.webgl.render(this.scene, this.camera);
  }

  /** Smoothed frames per second. */
  fps(): number {
    return this.fpsSmoothed;
  }

  /**
   * Optional explicit creature-position lookup for the documentary camera
   * (otherwise positions are found by scene-graph convention; see class doc).
   */
  setPositionResolver(fn: ((id: number) => THREE.Vector3 | null) | null): void {
    this.posResolver = fn;
  }

  /** Tear down listeners, controls, scene resources and the GL context. */
  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.skyRig.dispose();
    if (this.waterRig) this.waterRig.dispose();
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
      (this.terrainMesh.material as THREE.Material).dispose();
    }
    this.actorCache.clear();
    this.webgl.dispose();
    this.canvas.remove();
  }

  /** Default DocCam position lookup: cached scene scan by creature id. */
  private resolveActorPosition(id: number): THREE.Vector3 | null {
    if (this.posResolver) return this.posResolver(id);
    let obj = this.actorCache.get(id);
    if (obj && !this.isAttached(obj)) {
      this.actorCache.delete(id);
      obj = undefined;
    }
    if (!obj) {
      let found: THREE.Object3D | null = null;
      const nameKey = `creature:${id}`;
      this.scene.traverse((o) => {
        if (found) return;
        if (o.userData['creatureId'] === id || o.name === nameKey) found = o;
      });
      if (!found) return null;
      obj = found;
      this.actorCache.set(id, obj);
    }
    return obj.getWorldPosition(this.actorScratch);
  }

  private isAttached(o: THREE.Object3D): boolean {
    let p: THREE.Object3D | null = o;
    while (p) {
      if (p === this.scene) return true;
      p = p.parent;
    }
    return false;
  }
}
