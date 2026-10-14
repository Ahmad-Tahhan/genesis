/**
 * Main-thread bootstrap: spawns the sim worker, builds the renderer and UI,
 * and routes the worker protocol to the visual/audio subsystems.
 */
import './ui/style.css';
import './ui/inspector.css';
import * as THREE from 'three';
import type { MainToWorker, Speed, WorkerToMain } from './shared/protocol';
import type { CreatureInfo, SimEvent, WorldStats } from './shared/types';
import { DAY_LENGTH, YEAR_LENGTH } from './shared/constants';
import { Renderer } from './render/renderer';
import { CreatureMeshes } from './render/creatures';
import { PlantMeshes } from './render/plants';
import { Hud } from './ui/hud';
import { SidePanel, type TabName } from './ui/panel';
import { PopulationChart } from './ui/charts';
import { Timeline } from './ui/timeline';
import { Captions, captionFor } from './ui/captions';
import { Inspector } from './ui/inspector';
import { PhyloView } from './ui/phylo';
import { Soundscape } from './audio/soundscape';

// ----------------------------------------------------------- DOM scaffold
const app = document.getElementById('app')!;
app.innerHTML = '';
const stage = document.createElement('div');
stage.id = 'stage';
const overlay = document.createElement('div');
overlay.id = 'overlay';
const hudRoot = document.createElement('div');
const sideRoot = document.createElement('div');
const captionRoot = document.createElement('div');
overlay.append(hudRoot, sideRoot, captionRoot);
app.append(stage, overlay);

// --------------------------------------------------------------- systems
const urlSeed = Number(new URLSearchParams(location.search).get('seed'));
const seed = Number.isFinite(urlSeed) && urlSeed > 0 ? Math.floor(urlSeed) : (Date.now() % 2147483647) | 0;

const renderer = new Renderer(stage);
const creatures = new CreatureMeshes(renderer.scene);
const plants = new PlantMeshes(renderer.scene);
const sound = new Soundscape();

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
function send(msg: MainToWorker, transfer?: Transferable[]): void {
  if (transfer) worker.postMessage(msg, transfer);
  else worker.postMessage(msg);
}

// --------------------------------------------------------------- UI state
const infoById = new Map<number, CreatureInfo>();
const speciesNames = new Map<number, string>();
let lastStats: WorldStats | null = null;
let selected: number | null = null;
let speed: Speed = 1;
// Sim clock kept main-side in float64 (snapshot floats are f32 and would go
// steppy on long runs): advanced locally, resynced from stats messages.
let simTime = 0;
let simRate = 1; // sim-seconds per wall-second (estimated in max mode)
let lastStatsSync: { wall: number; time: number } | null = null;
let waterLevel = 0;
let ready = false;
let activeTab: TabName = 'inspector';
const deferredDeaths: number[] = [];

const sunAngleOf = (t: number): number => ((t % DAY_LENGTH) / DAY_LENGTH) * Math.PI * 2;
const seasonPhaseOf = (t: number): number => (t % YEAR_LENGTH) / YEAR_LENGTH;

const speciesName = (id?: number): string =>
  id === undefined ? '?' : (speciesNames.get(id) ?? `species ${id}`);

const hud = new Hud(hudRoot, {
  onSpeed: (s) => setSpeed(s),
  onToggleSound: () => {
    sound.start();
    return sound.toggle();
  },
  onToggleDocCam: () => {
    renderer.docCam.auto = !renderer.docCam.auto;
    return renderer.docCam.auto;
  },
});

const panel = new SidePanel(sideRoot);
const inspector = new Inspector(panel.content('inspector'), (id) => select(id));
const chart = new PopulationChart(panel.content('species'));
const phylo = new PhyloView(panel.content('phylo'));
const timeline = new Timeline(panel.content('events'), (e) => {
  if (e.pos) renderer.docCam.focusEvent(e);
});
const captions = new Captions(captionRoot);

function setSpeed(s: Speed): void {
  const wasMax = speed === -1;
  speed = s;
  send({ type: 'setSpeed', speed: s });
  hud.setSpeed(s);
  simRate = s === 0 ? 0 : s === 1 ? 1 : s === 10 ? 10 : simRate;
  if (s === -1) {
    captions.show('⏩ Simulating at maximum speed — rendering paused');
  } else if (wasMax) {
    // deaths deferred during max (no snapshots arrive) are applied now
    for (const id of deferredDeaths) creatures.remove(id);
    deferredDeaths.length = 0;
  }
}

function select(id: number | null): void {
  if (id !== null && !infoById.has(id)) {
    captions.show('That creature is no longer alive', 2);
    return;
  }
  selected = id;
  creatures.setSelected(id);
  send({ type: 'select', creatureId: id });
  if (id === null) inspector.clear();
  else panel.select('inspector');
}

// ------------------------------------------------------------- messages
worker.onerror = () => {
  captions.show('⚠️ The simulation worker crashed — reload the page to restart', 30);
};
worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'ready':
      waterLevel = msg.terrain.waterLevel;
      renderer.buildTerrain(msg.terrain);
      ready = true;
      break;
    case 'birth':
      infoById.set(msg.creature.id, msg.creature);
      creatures.add(msg.creature);
      break;
    case 'death':
      infoById.delete(msg.id);
      // in max mode no snapshots arrive, so removing meshes immediately would
      // visibly drain the world while the sim reports a full population
      if (speed === -1) deferredDeaths.push(msg.id);
      else creatures.remove(msg.id);
      if (selected === msg.id) select(null);
      break;
    case 'snapshot': {
      const arr = new Float32Array(msg.buffer);
      creatures.applySnapshot(arr);
      break;
    }
    case 'plants':
      plants.applyPlants(new Float32Array(msg.buffer));
      break;
    case 'stats': {
      lastStats = msg.stats;
      for (const s of msg.stats.species) speciesNames.set(s.id, s.name);
      hud.update(msg.stats, renderer.fps(), seed);
      // float64 clock resync (and rate estimate for max mode)
      const wall = performance.now() / 1000;
      if (lastStatsSync && speed === -1) {
        const dw = wall - lastStatsSync.wall;
        if (dw > 0.1) simRate = Math.max(0, (msg.stats.time - lastStatsSync.time) / dw);
      }
      lastStatsSync = { wall, time: msg.stats.time };
      simTime = msg.stats.time;
      break;
    }
    case 'events':
      handleEvents(msg.events);
      break;
    case 'inspect':
      if (msg.detail && msg.detail.id === selected) inspector.update(msg.detail);
      break;
    case 'phylo':
      phylo.update(msg.nodes, lastStats?.tick ?? 0);
      for (const n of msg.nodes) speciesNames.set(n.id, n.name);
      break;
    case 'history':
      chart.setHistory(msg.series);
      chart.draw();
      break;
    case 'picked':
      if (msg.id !== null) select(msg.id);
      break;
  }
};

function handleEvents(events: SimEvent[]): void {
  timeline.add(events, speciesName);
  for (const e of events) {
    if (e.interest >= 0.55) {
      if (e.pos) renderer.docCam.offerEvent(e); // a camera cannot frame nowhere
      const cap = captionFor(e, speciesName);
      if (cap) captions.show(`${cap.icon} ${cap.text}`);
      sound.event(e.kind);
    }
  }
}

send({ type: 'init', seed });

// tiny debug/testing handle (harmless in production)
(window as unknown as Record<string, unknown>).__genesis = {
  select,
  ids: () => [...infoById.keys()],
};

// ------------------------------------------------------------ interaction
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt: [number, number] | null = null;
renderer.canvas.addEventListener('pointerdown', (e) => {
  downAt = [e.clientX, e.clientY];
  sound.start();
});
renderer.canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) return; // drag = orbit, not click
  const rect = renderer.canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
  raycaster.setFromCamera(ndc, renderer.camera);
  const id = creatures.pick(raycaster);
  select(id);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
});

// doc-cam follows creatures via mesh positions
renderer.setPositionResolver((id) => creatures.getPosition(id));
renderer.docCam.auto = true;

// panel-driven queries
let queryTimer = 0;
panel.onSelect = (tab: TabName) => {
  activeTab = tab;
  if (tab === 'phylo') send({ type: 'queryPhylo' });
  if (tab === 'species') send({ type: 'queryHistory' });
};

// ------------------------------------------------------------ frame loop
let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (ready) {
    simTime += dt * simRate;
    const sunAngle = sunAngleOf(simTime);
    renderer.setSun(sunAngle, seasonPhaseOf(simTime));
    creatures.update(dt);
    plants.update(dt, simTime);
    captions.update(dt);
    renderer.frame(dt, simTime);

    const cam = renderer.camera.position;
    const dayness = Math.max(0, Math.sin(sunAngle));
    sound.update(dt, {
      wind: 0.35 + Math.min(0.5, cam.y / 160),
      nearWater: Math.max(0, 1 - Math.max(0, cam.y - waterLevel) / 25),
      dayness,
    });

    queryTimer += dt;
    if (queryTimer > 2.5) {
      queryTimer = 0;
      // only the visible panel's data is worth shipping and redrawing
      if (activeTab === 'species') send({ type: 'queryHistory' });
      if (activeTab === 'phylo') send({ type: 'queryPhylo' });
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

setSpeed(1);
