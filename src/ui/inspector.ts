/**
 * Creature inspector panel (UI group: inspector + phylogeny).
 *
 * Shows the selected creature's identity header, energy/health meters, its
 * lifetime diet split (how herbivory/carnivory emerges), lineage chips, a
 * live NEAT brain graph drawn on a canvas, and a collapsible genome summary.
 *
 * `update()` is called at ~10 Hz with the latest `CreatureDetail`; the brain
 * graph layout is cached per network topology so node positions stay stable
 * between updates (no jitter). All theme values resolve at runtime from the
 * CSS custom properties declared on `:root` in src/ui/style.css — the
 * fallback strings below are only a guard for the stylesheet not having
 * loaded, never an alternative theme.
 */
import type { CreatureDetail, Genome } from '../shared/types';
import { CREATURE_MAX_HEALTH } from '../shared/constants';
import { fmt } from './charts';

// ----------------------------------------------------------- small helpers

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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Append a `.k`/`.v` pair to a shared `.kv` grid container (style.css
 * convention) and return the value span for later updates.
 */
function kvPair(kv: HTMLElement, key: string): HTMLSpanElement {
  kv.append(el('span', 'k', key));
  const v = el('span', 'v');
  kv.append(v);
  return v;
}

interface Meter {
  fill: HTMLDivElement;
  val: HTMLSpanElement;
}

/** Append a shared `.bar-row` with `.meter > .meter-fill` (checklist item 6). */
function barRow(parent: HTMLElement, label: string): Meter {
  const row = el('div', 'bar-row');
  row.append(el('span', undefined, label));
  const meter = el('div', 'meter');
  const fill = el('div', 'meter-fill');
  meter.append(fill);
  const val = el('span', 'v');
  row.append(meter, val);
  parent.append(row);
  return { fill, val };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// -------------------------------------------------------- brain graph layout

interface BrainLayout {
  key: string;
  /** Normalized 0..1 positions by node id. */
  x: Map<number, number>;
  y: Map<number, number>;
  /** Largest node count in any column (sets node radius / spacing). */
  maxCol: number;
  leftLabels: { yn: number; text: string }[];
  rightLabels: { yn: number; text: string }[];
}

/** Stable hash of the network's node id set + connection topology. */
function brainKey(detail: CreatureDetail): string {
  let h = 5381 >>> 0;
  const ns = detail.brain.nodes;
  for (let i = 0; i < ns.length; i++) h = (((h << 5) + h) ^ ns[i].id) >>> 0;
  const cs = detail.brain.conns;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    h = (((h << 5) + h) ^ (c.from * 8191 + c.to * 131 + (c.on ? 1 : 0))) >>> 0;
  }
  return `${detail.id}:${ns.length}:${cs.length}:${h.toString(36)}`;
}

function buildLayout(detail: CreatureDetail, key: string): BrainLayout {
  const nodes = detail.brain.nodes;
  const conns = detail.brain.conns;
  const ins: typeof nodes = [];
  const outs: typeof nodes = [];
  const hid: typeof nodes = [];
  for (const n of nodes) {
    if (n.type === 'in') ins.push(n);
    else if (n.type === 'out') outs.push(n);
    else hid.push(n);
  }

  // BFS depth from the inputs over enabled connections (recurrent edges are
  // simply ignored for layering — they get drawn as curves later).
  const adj = new Map<number, number[]>();
  for (const c of conns) {
    if (!c.on) continue;
    let a = adj.get(c.from);
    if (!a) {
      a = [];
      adj.set(c.from, a);
    }
    a.push(c.to);
  }
  const depth = new Map<number, number>();
  const queue: number[] = [];
  for (const n of ins) {
    depth.set(n.id, 0);
    queue.push(n.id);
  }
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    const d = depth.get(id)!;
    const next = adj.get(id);
    if (next) {
      for (const t of next) {
        if (!depth.has(t)) {
          depth.set(t, d + 1);
          queue.push(t);
        }
      }
    }
  }

  const x = new Map<number, number>();
  const y = new Map<number, number>();
  ins.forEach((n, i) => {
    x.set(n.id, 0);
    y.set(n.id, (i + 0.5) / Math.max(1, ins.length));
  });
  outs.forEach((n, i) => {
    x.set(n.id, 1);
    y.set(n.id, (i + 0.5) / Math.max(1, outs.length));
  });

  // Hidden nodes: layered x by BFS depth; unreached ones sit in layer 1.
  let maxD = 1;
  const dOf = new Map<number, number>();
  for (const n of hid) {
    const d = Math.max(1, depth.get(n.id) ?? 1);
    dOf.set(n.id, d);
    if (d > maxD) maxD = d;
  }
  const groups = new Map<number, number[]>();
  for (const n of hid) {
    const d = dOf.get(n.id)!;
    let g = groups.get(d);
    if (!g) {
      g = [];
      groups.set(d, g);
    }
    g.push(n.id);
  }
  let maxCol = Math.max(1, ins.length, outs.length);
  for (const [d, list] of groups) {
    list.sort((a, b) => a - b);
    for (let j = 0; j < list.length; j++) {
      x.set(list[j], d / (maxD + 1));
      y.set(list[j], (j + 0.5) / list.length);
    }
    if (list.length > maxCol) maxCol = list.length;
  }

  const leftLabels = ins.map((n, i) => ({
    yn: (i + 0.5) / Math.max(1, ins.length),
    text: (n.label ?? `in ${i}`).slice(0, 15),
  }));
  const rightLabels = outs.map((n, i) => ({
    yn: (i + 0.5) / Math.max(1, outs.length),
    text: (n.label ?? `out ${i}`).slice(0, 12),
  }));

  return { key, x, y, maxCol, leftLabels, rightLabels };
}

// ================================================================ Inspector

/**
 * Right-panel creature inspector. Construct once with the tab-panel container
 * and a selection callback; feed it `update(detail)` at ~10 Hz for the
 * selected creature and `clear()` on deselection.
 */
export class Inspector {
  private readonly onSelect: (id: number | null) => void;
  private readonly empty: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly spName: HTMLElement;
  private readonly spId: HTMLSpanElement;
  private readonly vGen: HTMLSpanElement;
  private readonly vAge: HTMLSpanElement;
  private readonly vMass: HTMLSpanElement;
  private readonly energy: Meter;
  private readonly health: Meter;
  private readonly dietBar: HTMLDivElement;
  private readonly dietPlant: HTMLDivElement;
  private readonly dietMeat: HTMLDivElement;
  private readonly dietPlantLbl: HTMLSpanElement;
  private readonly dietMeatLbl: HTMLSpanElement;
  private readonly vGut: HTMLSpanElement;
  private readonly parentsVal: HTMLSpanElement;
  private readonly vChildren: HTMLSpanElement;
  private readonly brainCanvas: HTMLCanvasElement;
  private readonly genomeBox: HTMLDivElement;
  private lastId: number | null = null;
  private layout: BrainLayout | null = null;

  constructor(container: HTMLElement, onSelectCreature: (id: number | null) => void) {
    this.onSelect = onSelectCreature;
    const root = el('div', 'inspector');
    this.empty = el('div', 'insp-empty', 'Click a creature to inspect it');
    this.content = el('div', 'insp-content');
    this.content.hidden = true;

    // header
    const title = el('div', 'insp-title');
    this.spName = el('i', 'sp-name');
    this.spId = el('span', 'cid');
    title.append(this.spName, this.spId);
    this.content.append(title);
    const idKv = el('div', 'kv');
    this.vGen = kvPair(idKv, 'Generation');
    this.vAge = kvPair(idKv, 'Age');
    this.vMass = kvPair(idKv, 'Mass');
    this.content.append(idKv);

    // meters
    this.energy = barRow(this.content, 'Energy');
    this.energy.fill.style.background = 'var(--accent)';
    this.health = barRow(this.content, 'Health');
    this.health.fill.style.background = 'var(--ok)';

    // diet
    this.content.append(el('div', 'sec-title', 'Diet'));
    this.dietBar = el('div', 'diet-bar');
    this.dietPlant = el('div', 'diet-plant');
    this.dietMeat = el('div', 'diet-meat');
    this.dietBar.append(this.dietPlant, this.dietMeat);
    const dietLabels = el('div', 'diet-labels');
    this.dietPlantLbl = el('span', undefined, 'Plants —');
    this.dietMeatLbl = el('span', undefined, 'Meat —');
    dietLabels.append(this.dietPlantLbl, this.dietMeatLbl);
    this.content.append(this.dietBar, dietLabels);
    const gutKv = el('div', 'kv');
    this.vGut = kvPair(gutKv, 'Gut');
    this.content.append(gutKv);

    // lineage
    this.content.append(el('div', 'sec-title', 'Lineage'));
    const linKv = el('div', 'kv');
    this.parentsVal = kvPair(linKv, 'Parents');
    this.parentsVal.classList.add('chips');
    this.vChildren = kvPair(linKv, 'Children');
    this.content.append(linKv);

    // brain graph
    this.content.append(el('div', 'sec-title', 'Brain'));
    this.brainCanvas = el('canvas', 'brain-canvas');
    this.brainCanvas.setAttribute('role', 'img');
    this.brainCanvas.setAttribute('aria-label', 'Live brain network graph');
    this.content.append(this.brainCanvas);

    // genome summary (collapsed)
    const det = el('details', 'genome');
    det.append(el('summary', undefined, 'Genome'));
    this.genomeBox = el('div', 'genome-body');
    det.append(this.genomeBox);
    this.content.append(det);

    root.append(this.empty, this.content);
    container.append(root);
  }

  /** Feed the latest detail for the selected creature (~10 Hz). Null = empty state. */
  update(detail: CreatureDetail | null): void {
    if (!detail) {
      this.clear();
      return;
    }
    this.empty.hidden = true;
    this.content.hidden = false;
    if (detail.id !== this.lastId) {
      this.lastId = detail.id;
      this.layout = null;
      this.buildStatic(detail);
    }

    this.vAge.textContent = `${fmt(detail.age)} s`;
    this.vMass.textContent = `${fmt(detail.mass)} kg`;

    const eFrac = detail.energyCapacity > 0 ? clamp01(detail.energy / detail.energyCapacity) : 0;
    this.energy.fill.style.width = `${eFrac * 100}%`;
    this.energy.val.textContent = `${fmt(detail.energy)} / ${fmt(detail.energyCapacity)}`;
    const hFrac = clamp01(detail.health / CREATURE_MAX_HEALTH);
    this.health.fill.style.width = `${hFrac * 100}%`;
    this.health.fill.style.background = hFrac < 0.35 ? 'var(--danger)' : 'var(--ok)';
    this.health.val.textContent = `${fmt(detail.health)} / ${fmt(CREATURE_MAX_HEALTH)}`;

    const total = detail.dietPlant + detail.dietMeat;
    const pPct = total > 0 ? (detail.dietPlant / total) * 100 : 50;
    this.dietPlant.style.width = `${pPct}%`;
    this.dietMeat.style.width = `${100 - pPct}%`;
    this.dietBar.classList.toggle('diet-none', total <= 0);
    if (total > 0) {
      this.dietPlantLbl.textContent = `Plants ${fmt(pPct)}%`;
      this.dietMeatLbl.textContent = `Meat ${fmt(100 - pPct)}%`;
    } else {
      this.dietPlantLbl.textContent = 'Plants —';
      this.dietMeatLbl.textContent = 'Meat —';
    }
    this.vGut.textContent = `${fmt(detail.genome.organism.gutHerbivory * 100)}% herbivorous`;
    this.vChildren.textContent = fmt(detail.childCount);

    this.drawBrain(detail);
  }

  /** Reset to the empty state ("Click a creature to inspect it"). */
  clear(): void {
    this.lastId = null;
    this.layout = null;
    this.empty.hidden = false;
    this.content.hidden = true;
  }

  // ------------------------------------------------------------- internals

  /** Rebuild the parts that only change when a different creature is selected. */
  private buildStatic(detail: CreatureDetail): void {
    this.spName.textContent = detail.speciesName;
    this.spId.textContent = ` #${detail.id}`;
    this.vGen.textContent = fmt(detail.generation);

    this.parentsVal.textContent = '';
    if (detail.parents.length === 0) {
      this.parentsVal.textContent = 'founder';
    } else {
      for (const pid of detail.parents) {
        const chip = el('button', 'btn id-chip', `#${pid}`);
        chip.type = 'button';
        chip.title = `Select parent #${pid}`;
        chip.addEventListener('click', () => this.onSelect(pid));
        this.parentsVal.append(chip);
      }
    }
    this.buildGenome(detail.genome);
  }

  /** Compact genome summary: body-gene table + organism genes. */
  private buildGenome(g: Genome): void {
    this.genomeBox.textContent = '';
    const table = el('table', 'genome-table');
    const thead = el('thead');
    const trh = el('tr');
    for (const col of ['id', 'shape', 'par', 'mus', 'eyes', 'mo', 'mir', 'rec']) {
      trh.append(el('th', undefined, col));
    }
    thead.append(trh);
    table.append(thead);
    const tbody = el('tbody');
    for (const bg of g.body) {
      const tr = el('tr');
      tr.append(el('td', undefined, String(bg.id)));
      tr.append(el('td', undefined, bg.shape));
      tr.append(el('td', undefined, String(bg.parent)));
      tr.append(el('td', undefined, `${fmt(bg.muscle * 100)}%`));
      tr.append(el('td', undefined, String(bg.eyes)));
      tr.append(el('td', undefined, bg.mouth ? 'yes' : '–'));
      tr.append(el('td', undefined, bg.mirror ? 'yes' : '–'));
      tr.append(el('td', undefined, String(bg.recursion)));
      tbody.append(tr);
    }
    table.append(tbody);
    this.genomeBox.append(table);

    const o = g.organism;
    const org = el('div', 'kv');
    kvPair(org, 'Gut herbivory').textContent = `${fmt(o.gutHerbivory * 100)}%`;
    kvPair(org, 'Sexual repro').textContent = `${fmt(o.sexual * 100)}%`;
    kvPair(org, 'Offspring energy').textContent = `${fmt(o.offspringEnergyFrac * 100)}%`;
    kvPair(org, 'Size scale').textContent = `${fmt(o.sizeScale)}x`;
    let onConns = 0;
    for (const c of g.brain.conns) if (c.on) onConns++;
    kvPair(org, 'Brain').textContent = `${fmt(g.brain.nodes.length)} nodes, ${fmt(onConns)} links`;
    this.genomeBox.append(org);
  }

  /** Redraw the live network graph (layout cached per topology). */
  private drawBrain(detail: CreatureDetail): void {
    const c = this.brainCanvas;
    const w = c.clientWidth || 300;
    const h = c.clientHeight || 260;
    const ctx = fitCanvas(c, w, h);
    const key = brainKey(detail);
    if (!this.layout || this.layout.key !== key) this.layout = buildLayout(detail, key);
    const lay = this.layout;

    ctx.clearRect(0, 0, w, h);
    const accent = token('--accent', '#7fb4ff');
    const danger = token('--danger', '#ff6a6a');
    const dim = token('--text-dim', '#98a2ab');
    const border = token('--panel-border', '#39424a');
    const font = `${token('--fs-s', '11px')} ${token('--font', 'system-ui, sans-serif')}`;

    const padY = 12;
    const padL = 92;
    const padR = 64;
    const plotW = Math.max(40, w - padL - padR);
    const plotH = h - padY * 2;
    const px = (xn: number): number => padL + xn * plotW;
    const py = (yn: number): number => padY + yn * plotH;
    const r = Math.max(2, Math.min(5, (plotH / lay.maxCol) * 0.32));

    // connections: width ~ |w| (cap 3), sign-coded color, alpha ~ |w|
    for (const cn of detail.brain.conns) {
      if (!cn.on) continue;
      const x1n = lay.x.get(cn.from);
      const y1n = lay.y.get(cn.from);
      const x2n = lay.x.get(cn.to);
      const y2n = lay.y.get(cn.to);
      if (x1n === undefined || y1n === undefined || x2n === undefined || y2n === undefined) continue;
      const x1 = px(x1n);
      const yy1 = py(y1n);
      const x2 = px(x2n);
      const yy2 = py(y2n);
      const aw = Math.abs(cn.w);
      ctx.strokeStyle = cn.w >= 0 ? accent : danger;
      ctx.globalAlpha = Math.min(0.85, 0.14 + 0.3 * aw);
      ctx.lineWidth = Math.min(3, 0.5 + aw);
      ctx.beginPath();
      if (cn.from === cn.to) {
        // self-recurrent: small loop beside the node
        ctx.arc(x1 + r + 3, yy1 - r - 2, r + 2, 0, Math.PI * 2);
      } else if (x2 <= x1) {
        // recurrent/backward edge: arc above the direct path
        ctx.moveTo(x1, yy1);
        ctx.quadraticCurveTo((x1 + x2) / 2, Math.min(yy1, yy2) - 14 - (x1 - x2) * 0.06, x2, yy2);
      } else {
        ctx.moveTo(x1, yy1);
        ctx.lineTo(x2, yy2);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nodes: fill maps activation (-1..1) onto accent (+) / danger (−)
    for (const n of detail.brain.nodes) {
      const xn = lay.x.get(n.id);
      const yn = lay.y.get(n.id);
      if (xn === undefined || yn === undefined) continue;
      const cx = px(xn);
      const cy = py(yn);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = border;
      ctx.fill();
      const v = n.value < -1 ? -1 : n.value > 1 ? 1 : n.value;
      if (v > 0.02 || v < -0.02) {
        ctx.fillStyle = v > 0 ? accent : danger;
        ctx.globalAlpha = Math.abs(v);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = dim;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // IO labels (skip every k-th when rows get tighter than ~10px)
    ctx.font = font;
    ctx.fillStyle = dim;
    ctx.textBaseline = 'middle';
    const stepL = plotH / Math.max(1, lay.leftLabels.length);
    const skipL = stepL >= 10 ? 1 : Math.ceil(10 / stepL);
    ctx.textAlign = 'right';
    for (let i = 0; i < lay.leftLabels.length; i++) {
      if (i % skipL !== 0) continue;
      const lb = lay.leftLabels[i];
      ctx.fillText(lb.text, padL - r - 5, py(lb.yn));
    }
    const stepR = plotH / Math.max(1, lay.rightLabels.length);
    const skipR = stepR >= 10 ? 1 : Math.ceil(10 / stepR);
    ctx.textAlign = 'left';
    for (let i = 0; i < lay.rightLabels.length; i++) {
      if (i % skipR !== 0) continue;
      const lb = lay.rightLabels[i];
      ctx.fillText(lb.text, padL + plotW + r + 5, py(lb.yn));
    }
  }
}
