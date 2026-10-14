/**
 * Top HUD bar: time controls (pause/1x/10x/max), sound and documentary-camera
 * toggles, the world clock and headline stats. Keyboard shortcuts:
 * Space = pause/resume, 1/2/3 = 1x/10x/max.
 */
import type { Speed } from '../shared/protocol';
import type { WorldStats } from '../shared/types';
import { fmt } from './charts';
import { SEASON_NAMES } from './captions';

/** Callbacks the HUD drives; the toggles return the new state for the label. */
export interface HudCallbacks {
  onSpeed: (s: Speed) => void;
  onToggleSound: () => boolean;
  onToggleDocCam: () => boolean;
}

interface SpeedDef {
  speed: Speed;
  label: string;
  title: string;
}

const SPEEDS: SpeedDef[] = [
  { speed: 0, label: '⏸', title: 'Pause (Space)' },
  { speed: 1, label: '1x', title: 'Normal speed (1)' },
  { speed: 10, label: '10x', title: 'Fast forward (2)' },
  { speed: -1, label: '⏩', title: 'Max speed — simulation only, rendering pauses (3)' },
];

/** The top HUD bar. */
export class Hud {
  private readonly cb: HudCallbacks;
  private readonly speedButtons = new Map<Speed, HTMLButtonElement>();
  private readonly soundBtn: HTMLButtonElement;
  private readonly docBtn: HTMLButtonElement;
  private readonly clockEl: HTMLElement;
  private readonly statEls: { pop: HTMLElement; plants: HTMLElement; species: HTMLElement; fps: HTMLElement; seed: HTMLElement };
  private current: Speed = 1;
  private lastRunning: Speed = 1;
  private cache = new Map<HTMLElement, string>();

  constructor(root: HTMLElement, cb: HudCallbacks) {
    this.cb = cb;
    root.classList.add('hud', 'panel');

    // time controls
    const timeGroup = document.createElement('div');
    timeGroup.className = 'hud-group';
    timeGroup.setAttribute('role', 'group');
    timeGroup.setAttribute('aria-label', 'Time controls');
    for (const def of SPEEDS) {
      const b = this.button(def.label, def.title, () => this.chooseSpeed(def.speed));
      this.speedButtons.set(def.speed, b);
      timeGroup.appendChild(b);
    }

    // clock
    this.clockEl = document.createElement('div');
    this.clockEl.className = 'hud-clock';

    // stats
    const stats = document.createElement('div');
    stats.className = 'hud-stats';
    const stat = (label: string): HTMLElement => {
      const wrap = document.createElement('span');
      wrap.className = 'hud-stat';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'v';
      wrap.append(k, v);
      stats.appendChild(wrap);
      return v;
    };
    this.statEls = {
      pop: stat('pop'),
      plants: stat('plants'),
      species: stat('species'),
      fps: stat('fps · tps'),
      seed: stat('seed'),
    };

    // sound + doc-cam toggles
    const toggles = document.createElement('div');
    toggles.className = 'hud-group';
    this.soundBtn = this.button('🔇', 'Sound on/off', () => {
      const on = this.cb.onToggleSound();
      this.soundBtn.textContent = on ? '🔊' : '🔇';
      this.soundBtn.setAttribute('aria-pressed', String(on));
      this.soundBtn.classList.toggle('active', on);
    });
    this.soundBtn.setAttribute('aria-pressed', 'false');
    this.docBtn = this.button('🎥', 'Documentary camera: auto-follow interesting moments', () => {
      const on = this.cb.onToggleDocCam();
      this.docBtn.setAttribute('aria-pressed', String(on));
      this.docBtn.classList.toggle('active', on);
    });
    // the documentary camera starts enabled
    this.docBtn.setAttribute('aria-pressed', 'true');
    this.docBtn.classList.add('active');
    toggles.append(this.soundBtn, this.docBtn);

    root.append(timeGroup, this.clockEl, stats, toggles);
    this.applyActive(this.current);

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** Reflects the active speed button (does not fire the callback). */
  setSpeed(s: Speed): void {
    if (s !== 0) this.lastRunning = s;
    this.current = s;
    this.applyActive(s);
  }

  /**
   * Refreshes clock and stats. `stats` may be null before the first stats
   * message. Clock reads "Day N · Season · Year Y" (1-based for display).
   */
  update(stats: WorldStats | null, fps: number, seed: number): void {
    if (!stats) {
      this.text(this.clockEl, 'Growing the world…');
      return;
    }
    const season = SEASON_NAMES[stats.season % 4] ?? SEASON_NAMES[0];
    this.text(this.clockEl, `Day ${stats.day + 1} · ${season} · Year ${stats.year + 1}`);
    this.text(this.statEls.pop, fmt(stats.population));
    this.text(this.statEls.plants, fmt(stats.plantCount));
    let living = 0;
    for (const s of stats.species) if (s.count > 0) living++;
    this.text(this.statEls.species, fmt(living));
    this.text(this.statEls.fps, `${fmt(Math.round(fps))} · ${fmt(stats.tps)}`);
    this.text(this.statEls.seed, String(seed));
  }

  // ------------------------------------------------------------ internals

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  /** User picked a speed: update visuals and notify the composer. */
  private chooseSpeed(s: Speed): void {
    this.setSpeed(s);
    this.cb.onSpeed(s);
  }

  private applyActive(s: Speed): void {
    for (const [speed, b] of this.speedButtons) b.classList.toggle('active', speed === s);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    // let focused interactive elements (buttons, tabs, timeline rows, inputs)
    // keep their own key handling
    if (t && t !== document.body && (t.isContentEditable || t.matches('button, input, textarea, select, [role="button"], [tabindex]'))) return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.chooseSpeed(this.current === 0 ? this.lastRunning : 0);
    } else if (e.key === '1') this.chooseSpeed(1);
    else if (e.key === '2') this.chooseSpeed(10);
    else if (e.key === '3') this.chooseSpeed(-1);
  }

  /** Writes textContent only when the string changed (cheap stats refresh). */
  private text(el: HTMLElement, s: string): void {
    if (this.cache.get(el) !== s) {
      this.cache.set(el, s);
      el.textContent = s;
    }
  }
}
