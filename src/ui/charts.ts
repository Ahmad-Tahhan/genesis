/**
 * Shared chart helpers and the species population chart.
 *
 * This module is the single source for species colors (`speciesColor`),
 * compact number formatting (`fmt`) and dark-theme, devicePixelRatio-aware
 * canvas setup used by every canvas chart in the UI.
 */
import type { HistorySeries } from '../shared/protocol';
import { DAY_LENGTH, DT } from '../shared/constants';

/**
 * Species display color from its stable hue (0..1). Saturation/lightness are
 * fixed, tuned for readability on the dark panel background. Every UI module
 * must go through this function so a species looks the same everywhere.
 */
export function speciesColor(hue: number): string {
  const h = ((hue % 1) + 1) % 1;
  return `hsl(${Math.round(h * 360)}, 68%, 62%)`;
}

/**
 * Compact user-facing number: at most one decimal, `k`/`M` suffixes above
 * 10^3/10^6. All numbers shown in the UI go through this.
 */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  let s: string;
  if (abs >= 1e6) s = trim1(n / 1e6) + 'M';
  else if (abs >= 1e3) s = trim1(n / 1e3) + 'k';
  else s = trim1(n);
  return s;
}

/** toFixed(1) with a trailing ".0" (and negative zero) stripped. */
function trim1(n: number): string {
  let s = n.toFixed(1);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return s === '-0' ? '0' : s;
}

/** Theme ink colors and small-label font for canvas charts, from CSS tokens. */
export interface ChartTheme {
  text: string;
  dim: string;
  ok: string;
  /** Canvas font shorthand built from the --fs-s and --font tokens. */
  fontS: string;
}

let themeCache: ChartTheme | null = null;

/**
 * Reads the chart ink colors and label font from the `:root` CSS custom
 * properties so canvas charts share the stylesheet theme (single theme place).
 */
export function chartTheme(): ChartTheme {
  if (!themeCache) {
    const cs = getComputedStyle(document.documentElement);
    const fsS = cs.getPropertyValue('--fs-s').trim() || '11px';
    const font = cs.getPropertyValue('--font').trim() || 'system-ui, sans-serif';
    themeCache = {
      text: cs.getPropertyValue('--text').trim() || '#e8eef2',
      dim: cs.getPropertyValue('--text-dim').trim() || '#93a4ad',
      ok: cs.getPropertyValue('--ok').trim() || '#8fd460',
      fontS: `${fsS} ${font}`,
    };
  }
  return themeCache;
}

/**
 * Sizes a chart canvas backing store to its CSS box times devicePixelRatio
 * (capped at 2) and returns a ctx scaled to CSS-pixel coordinates, or null
 * when the canvas is not laid out yet (e.g. its tab is hidden).
 */
export function setupChartCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 4 || h < 4) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/**
 * Draws light horizontal gridlines with value labels (left, through fmt) and
 * day labels along the bottom. Returns nothing; used by the chart classes.
 */
export function drawAxes(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
  maxY: number,
  day0: number,
  day1: number,
): void {
  const t = chartTheme();
  ctx.save();
  ctx.font = t.fontS;
  ctx.fillStyle = t.dim;
  ctx.strokeStyle = t.dim;
  ctx.lineWidth = 1;

  const rows = 3;
  for (let i = 0; i <= rows; i++) {
    const frac = i / rows;
    const y = box.y + box.h - frac * box.h;
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.moveTo(box.x, y);
    ctx.lineTo(box.x + box.w, y);
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    if (i > 0) ctx.fillText(fmt(maxY * frac), box.x + 2, y - 1);
  }

  const cols = 4;
  ctx.textBaseline = 'top';
  for (let i = 0; i <= cols; i++) {
    const frac = i / cols;
    const day = day0 + (day1 - day0) * frac;
    const x = box.x + frac * box.w;
    ctx.textAlign = i === 0 ? 'left' : i === cols ? 'right' : 'center';
    ctx.fillText(`d ${fmt(day)}`, x, box.y + box.h + 3);
  }
  ctx.restore();
}

/**
 * Canvas line chart of per-species population over time, with total plant
 * biomass as a faint filled area on its own secondary scale, and an HTML
 * legend (chip + name + current count) below the canvas.
 *
 * Usage: `setHistory(h)` to store data, then `draw()` (also call `draw()` on
 * resize). The chart also redraws itself on window resize.
 */
export class PopulationChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private history: HistorySeries | null = null;

  constructor(container: HTMLElement) {
    container.classList.add('chart');
    this.canvas = document.createElement('canvas');
    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    container.append(this.canvas, this.legend);
    window.addEventListener('resize', () => this.draw());
  }

  /** Stores the latest population history; call `draw()` afterwards. */
  setHistory(h: HistorySeries): void {
    this.history = h;
  }

  /** Renders the chart from the last history; safe to call any time. */
  draw(): void {
    const ctx = setupChartCanvas(this.canvas);
    if (!ctx) return;
    const w = this.canvas.clientWidth;
    const hpx = this.canvas.clientHeight;
    const t = chartTheme();
    const h = this.history;

    if (!h || h.ticks.length < 2) {
      ctx.fillStyle = t.dim;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = t.fontS;
      ctx.fillText('Gathering history…', w / 2, hpx / 2);
      this.legend.replaceChildren();
      return;
    }

    const box = { x: 4, y: 6, w: w - 10, h: hpx - 24 };
    const n = h.ticks.length;
    const t0 = h.ticks[0];
    const t1 = h.ticks[n - 1];
    const span = Math.max(1, t1 - t0);
    const tickToDay = DT / DAY_LENGTH; // tick -> sim days

    let maxCount = 1;
    for (const s of h.series) for (const c of s.counts) if (c > maxCount) maxCount = c;
    let maxPlant = 1;
    for (const b of h.plantBiomass) if (b > maxPlant) maxPlant = b;

    const xAt = (i: number): number => box.x + ((h.ticks[i] - t0) / span) * box.w;
    const yCount = (c: number): number => box.y + box.h - (c / maxCount) * box.h;
    const yPlant = (b: number): number => box.y + box.h - (b / maxPlant) * box.h * 0.9;

    drawAxes(ctx, box, maxCount, t0 * tickToDay, t1 * tickToDay);

    // plant biomass: faint filled area, secondary scale
    if (h.plantBiomass.length >= 2) {
      const m = Math.min(n, h.plantBiomass.length);
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = t.ok;
      ctx.beginPath();
      ctx.moveTo(xAt(0), box.y + box.h);
      for (let i = 0; i < m; i++) ctx.lineTo(xAt(i), yPlant(h.plantBiomass[i]));
      ctx.lineTo(xAt(m - 1), box.y + box.h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // species population lines
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    for (const s of h.series) {
      let first = -1;
      let last = -1;
      for (let i = 0; i < s.counts.length && i < n; i++) {
        if (s.counts[i] > 0) {
          if (first < 0) first = i;
          last = i;
        }
      }
      if (first < 0) continue;
      const a = Math.max(0, first - 1);
      const b = Math.min(n - 1, last + 1);
      ctx.strokeStyle = speciesColor(s.hue);
      ctx.beginPath();
      for (let i = a; i <= b; i++) {
        const x = xAt(i);
        const y = yCount(s.counts[i]);
        if (i === a) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    this.renderLegend(h);
  }

  /** Rebuilds the HTML legend: top 8 living species by current count. */
  private renderLegend(h: HistorySeries): void {
    const living = h.series
      .map((s) => ({ s, count: s.counts.length ? s.counts[s.counts.length - 1] : 0 }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count);

    const items: HTMLElement[] = [];
    for (const { s, count } of living.slice(0, 8)) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = speciesColor(s.hue);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.name;
      const num = document.createElement('span');
      num.textContent = fmt(count);
      item.append(chip, name, num);
      items.push(item);
    }
    if (living.length > 8) {
      const more = document.createElement('span');
      more.className = 'legend-item';
      more.textContent = `+${living.length - 8} more`;
      items.push(more);
    }
    this.legend.replaceChildren(...items);
  }
}
