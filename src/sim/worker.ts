/**
 * Simulation worker: owns the World, runs the tick loop at the requested
 * speed, and streams snapshots/stats/events to the main thread.
 * Max speed (-1) free-runs in ~12 ms chunks with stats at ~4 Hz and no
 * snapshots (DECISIONS.md D9).
 */
import type { MainToWorker, Speed, WorkerToMain } from '../shared/protocol';
import { World } from './world';

const ctx = self as unknown as Worker;

let world: World | null = null;
let worldReady = false;
let speed: Speed = 1;
let running = false;
let lastFrame = 0;
let tickDebt = 0;
let tpsCounter = 0;
let tpsWindowStart = 0;
let tps = 0;
let lastMaxStats = 0;
let lastSnapshotAt = 0;
let lastPlantsAt = 0;
let lastInspectAt = 0;

function post(msg: WorkerToMain, transfer?: Transferable[]): void {
  if (transfer) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

ctx.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      boot(msg.seed).catch((e: unknown) => {
        // rethrow outside the promise chain so the worker 'error' event fires
        setTimeout(() => {
          throw e;
        });
      });
      break;
    case 'setSpeed':
      speed = msg.speed;
      tickDebt = 0;
      break;
    case 'select':
      if (world && worldReady) world.selectedId = msg.creatureId;
      if (world && worldReady && msg.creatureId !== null) {
        post({ type: 'inspect', detail: world.detail(msg.creatureId) });
      }
      break;
    case 'pick': {
      if (!world || !worldReady) break;
      const id = world.pick(msg.origin, msg.dir);
      post({ type: 'picked', id });
      break;
    }
    case 'queryPhylo':
      if (world && worldReady) post({ type: 'phylo', nodes: world.phylo() });
      break;
    case 'queryHistory':
      if (world && worldReady) post({ type: 'history', series: world.history() });
      break;
    case 'returnBuffer':
      // buffer pooling is a no-op for now: snapshots allocate fresh arrays
      break;
  }
};

async function boot(seed: number): Promise<void> {
  world = new World();
  await world.init(seed);
  const t = world.terrain;
  post({
    type: 'ready',
    seed,
    terrain: {
      heights: t.heights,
      res: t.res,
      size: t.size,
      waterLevel: t.waterLevel,
      moisture: t.moisture,
      fertility: t.fertility,
    },
  });
  worldReady = true;
  flushOutboxes(true);
  running = true;
  lastFrame = performance.now();
  tpsWindowStart = lastFrame;
  loop();
}

function loop(): void {
  if (!running || !world) return;
  const now = performance.now();

  if (speed === 0) {
    lastFrame = now;
    flushOutboxes(false); // nothing may sit stranded for the whole pause
    setTimeout(loop, 50);
    return;
  }

  if (speed === -1) {
    // free-run: chew sim ticks for ~12 ms, then yield to the message queue
    const deadline = now + 12;
    while (performance.now() < deadline) {
      world.step();
      tpsCounter++;
    }
    updateTps();
    if (performance.now() - lastMaxStats > 250) {
      lastMaxStats = performance.now();
      flushOutboxes(false);
    } else {
      // keep outbox bounded even between flushes
      trimOutboxes();
    }
    setTimeout(loop, 0);
    return;
  }

  // realtime (1x) or fast (10x): run `speed` ticks per 1/60 s of wall time
  const frameDt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  tickDebt += frameDt * 60 * speed;
  const budget = now + 14;
  let ran = 0;
  while (tickDebt >= 1 && performance.now() < budget && ran < speed * 3) {
    world.step();
    tpsCounter++;
    ran++;
    tickDebt--;
  }
  if (tickDebt > speed * 6) tickDebt = speed * 6; // drop debt when overloaded
  updateTps();

  if (ran > 0) {
    const wall = performance.now();
    if (wall - lastSnapshotAt >= 15) {
      lastSnapshotAt = wall;
      const snap = world.encodeSnapshot().buffer as ArrayBuffer;
      post({ type: 'snapshot', buffer: snap }, [snap]);
    }
    if (wall - lastPlantsAt >= 200) {
      lastPlantsAt = wall;
      const plants = world.encodePlants().buffer as ArrayBuffer;
      post({ type: 'plants', buffer: plants }, [plants]);
    }
    if (world.selectedId !== null && wall - lastInspectAt >= 100) {
      lastInspectAt = wall;
      post({ type: 'inspect', detail: world.detail(world.selectedId) });
    }
    flushOutboxes(false);
  }
  setTimeout(loop, speed === 1 ? 8 : 0);
}

function updateTps(): void {
  const now = performance.now();
  if (now - tpsWindowStart >= 1000) {
    tps = (tpsCounter * 1000) / (now - tpsWindowStart);
    tpsCounter = 0;
    tpsWindowStart = now;
  }
}

function flushOutboxes(force: boolean): void {
  if (!world) return;
  for (const b of world.outBirths) post({ type: 'birth', creature: b });
  world.outBirths.length = 0;
  for (const d of world.outDeaths) post({ type: 'death', id: d.id, cause: d.cause });
  world.outDeaths.length = 0;
  if (world.outEvents.length > 0) {
    post({ type: 'events', events: world.outEvents.slice() });
    world.outEvents.length = 0;
  }
  if (world.statsDirty || force) {
    if (world.statsDirty) {
      world.statsDirty.tps = tps;
      post({ type: 'stats', stats: world.statsDirty });
      world.statsDirty = null;
    }
  }
}

/** In max mode between flushes, cap outbox growth (drop low-interest events). */
function trimOutboxes(): void {
  if (!world) return;
  if (world.outEvents.length > 400) {
    // keep the interesting ones IN ORDER (the timeline assumes chronology)
    const kept = world.outEvents.filter((e) => e.interest >= 0.5);
    world.outEvents.length = 0;
    world.outEvents.push(...kept.slice(-200));
  }
}

export {};
