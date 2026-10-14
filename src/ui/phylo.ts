/**
 * Live phylogenetic tree view (UI group: inspector + phylogeny).
 *
 * Draws every recorded species as a horizontal lifespan line over time:
 * x = tick (bornTick → extinctTick, or the current tick while alive),
 * y = a lineage lane assigned by pre-order DFS over the parent tree so
 * children sit directly under their parents. Line thickness scales with
 * log(peak population); a thin connector drops from the parent's lane at the
 * child's birth tick; extinct lines fade to transparent at their end; living
 * species get a small dim name label when lane spacing allows. The x axis is
 * labelled in day numbers.
 *
 * `update()` redraws from scratch — callers invoke it at <= 1 Hz. Lane height
 * compresses automatically, so 100+ species stay readable (labels are skipped
 * when lanes get dense). Theme values resolve at runtime from the CSS custom
 * properties in src/ui/style.css; the fallbacks are only a stylesheet-missing
 * guard.
 */
import type { PhyloNode } from '../shared/types';
import { DAY_LENGTH, DT } from '../shared/constants';
import { fmt, speciesColor } from './charts';

const tokenCache = new Map<string, string>();

/** Resolve a CSS custom property declared on :root (cached after first hit). */
function token(name: string, fallback: string): string {
  const hit = tokenCache.get(name);
  if (hit !== undefined) return hit;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (v) {
    tokenCache.set(name, v);
    return v;
  }
  return fallback;
}

/** Size a canvas backing store for devicePixelRatio and return its 2D context. */
function fitCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (c.width !== pw || c.height !== ph) {
    c.width = pw;
    c.height = ph;
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Fully transparent stop matching a species hue (for extinct-line fades). */
function transparentHue(hue: number): string {
  return `hsla(${Math.round(hue * 360)}, 70%, 60%, 0)`;
}

/**
 * Canvas tree-over-time of all species ever recorded. Construct once with the
 * tab-panel container; call `update(nodes, currentTick)` whenever a fresh
 * phylogeny arrives from the worker.
 */
export class PhyloView {
  private readonly canvas: HTMLCanvasElement;

  constructor(container: HTMLElement) {
    const wrap = document.createElement('div');
    wrap.className = 'phylo-view';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'phylo-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Phylogenetic tree of species over time');
    wrap.append(this.canvas);
    container.append(wrap);
  }

  /** Redraw the tree from the full species list (callers keep this <= 1 Hz). */
  update(nodes: PhyloNode[], currentTick: number): void {
    const w = this.canvas.clientWidth || 320;
    const h = this.canvas.clientHeight || 340;
    const ctx = fitCanvas(this.canvas, w, h);
    ctx.clearRect(0, 0, w, h);

    const dim = token('--text-dim', '#98a2ab');
    const border = token('--panel-border', '#39424a');
    const font = `${token('--fs-s', '11px')} ${token('--font', 'system-ui, sans-serif')}`;
    ctx.font = font;

    if (nodes.length === 0) {
      ctx.fillStyle = dim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No species yet', w / 2, h / 2);
      return;
    }

    // ---------------------------------------------------------- tree shape
    const byId = new Map<number, PhyloNode>();
    for (const n of nodes) byId.set(n.id, n);
    const kids = new Map<number, PhyloNode[]>();
    const roots: PhyloNode[] = [];
    for (const n of nodes) {
      if (n.parentId >= 0 && n.parentId !== n.id && byId.has(n.parentId)) {
        let list = kids.get(n.parentId);
        if (!list) {
          list = [];
          kids.set(n.parentId, list);
        }
        list.push(n);
      } else {
        roots.push(n);
      }
    }
    const byBirth = (a: PhyloNode, b: PhyloNode): number => a.bornTick - b.bornTick || a.id - b.id;
    roots.sort(byBirth);
    for (const [, list] of kids) list.sort(byBirth);

    // pre-order DFS: each species gets the next lane, children right below it
    const lane = new Map<number, number>();
    let nextLane = 0;
    const stack: PhyloNode[] = [];
    for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (lane.has(n.id)) continue; // guards malformed parent cycles
      lane.set(n.id, nextLane++);
      const list = kids.get(n.id);
      if (list) for (let i = list.length - 1; i >= 0; i--) stack.push(list[i]);
    }

    // ------------------------------------------------------------- scales
    const padT = 8;
    const padL = 8;
    const padR = 8;
    const axisH = 20;
    const plotW = Math.max(20, w - padL - padR);
    const plotH = Math.max(20, h - padT - axisH);
    let t0 = Infinity;
    for (const n of nodes) if (n.bornTick < t0) t0 = n.bornTick;
    if (!Number.isFinite(t0)) t0 = 0;
    const t1 = Math.max(currentTick, t0 + 1);
    const x = (t: number): number => padL + ((t - t0) / (t1 - t0)) * plotW;
    const laneH = Math.min(26, plotH / Math.max(1, nextLane));
    const laneY = (l: number): number => padT + (l + 0.5) * laneH;

    // ------------------------------------------------------------ day axis
    const ticksPerDay = DAY_LENGTH / DT;
    const day0 = t0 / ticksPerDay;
    const day1 = t1 / ticksPerDay;
    const span = Math.max(0.001, day1 - day0);
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (span / s <= 8) {
        step = s;
        break;
      }
    }
    const axisY = h - axisH;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(padL, axisY + 0.5);
    ctx.lineTo(w - padR, axisY + 0.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = dim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = Math.ceil(day0 / step) * step; d <= day1 + 1e-9; d += step) {
      const xx = x(d * ticksPerDay);
      if (xx < padL + 6 || xx > w - padR - 6) continue;
      ctx.strokeStyle = border;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(xx + 0.5, padT);
      ctx.lineTo(xx + 0.5, axisY);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(`d${fmt(d)}`, xx, axisY + 4);
    }

    // --------------------------------------------------------- connectors
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    for (const n of nodes) {
      const childLane = lane.get(n.id);
      const parentLane = lane.get(n.parentId);
      if (childLane === undefined || parentLane === undefined) continue;
      const bx = x(n.bornTick);
      ctx.strokeStyle = speciesColor(n.hue);
      ctx.beginPath();
      ctx.moveTo(bx, laneY(parentLane));
      ctx.lineTo(bx, laneY(childLane));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // ------------------------------------------------------- species lines
    const maxThick = Math.min(6, Math.max(1, laneH * 0.9));
    for (const n of nodes) {
      const l = lane.get(n.id);
      if (l === undefined) continue;
      const yy = laneY(l);
      const x1 = x(n.bornTick);
      const x2 = Math.max(x1 + 1, x(n.extinctTick ?? currentTick));
      const thick = Math.min(maxThick, Math.max(1, 1 + Math.log2(1 + n.peakPopulation) * 0.6));
      if (n.extinctTick !== null) {
        const col = speciesColor(n.hue);
        const grad = ctx.createLinearGradient(x1, 0, x2, 0);
        const fadeFrom = Math.max(0, 1 - Math.min(0.5, 40 / Math.max(1, x2 - x1)));
        grad.addColorStop(0, col);
        grad.addColorStop(fadeFrom, col);
        grad.addColorStop(1, transparentHue(n.hue));
        ctx.strokeStyle = grad;
      } else {
        ctx.strokeStyle = speciesColor(n.hue);
      }
      ctx.lineWidth = thick;
      ctx.beginPath();
      ctx.moveTo(x1, yy);
      ctx.lineTo(x2, yy);
      ctx.stroke();
    }

    // ------------------------------------- name labels for living species
    if (laneH >= 10) {
      ctx.fillStyle = dim;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      for (const n of nodes) {
        if (n.extinctTick !== null) continue;
        const l = lane.get(n.id);
        if (l === undefined) continue;
        const yy = laneY(l);
        const thick = Math.min(maxThick, Math.max(1, 1 + Math.log2(1 + n.peakPopulation) * 0.6));
        const ly = Math.max(padT + 9, yy - thick / 2 - 1);
        ctx.fillText(n.name, x(n.extinctTick ?? currentTick) - 2, ly);
      }
    }
  }
}
