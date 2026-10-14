/**
 * Documentary captions: the single event-wording dictionary (`captionFor`,
 * UI checklist #8) consumed by both the bottom caption strip and the event
 * timeline, plus the caption strip itself.
 */
import type { SimEvent } from '../shared/types';
import { fmt } from './charts';

/** Canonical season display names, indexed by `WorldStats.season` (0..3). */
export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;

const SEASON_ICONS = ['🌸', '☀️', '🍂', '❄️'] as const;

const SEASON_LINES = [
  'Spring arrives — the land wakes',
  'Summer settles over the land',
  'Autumn draws in',
  'Winter closes in',
] as const;

/** `data[key]` as a finite number, or null. */
function num(e: SimEvent, key: string): number | null {
  const v = e.data?.[key];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Species display name: the event's own payload first, then the resolver. */
function who(e: SimEvent, speciesName: (id?: number) => string): string {
  const n = e.data?.name;
  return typeof n === 'string' && n.length > 0 ? n : speciesName(e.speciesId);
}

/**
 * The one dictionary mapping an event to its documentary line. Returns the
 * icon and sentence separately (callers compose them), or null for event
 * kinds not worth narrating (births, deaths, maturation).
 */
export function captionFor(
  e: SimEvent,
  speciesName: (id?: number) => string,
): { icon: string; text: string } | null {
  switch (e.kind) {
    case 'hunt':
      return { icon: '🐾', text: `A ${who(e, speciesName)} runs down its prey` };
    case 'kill':
      return { icon: '🩸', text: `A ${who(e, speciesName)} makes a kill` };
    case 'speciesBorn':
      return { icon: '🌱', text: `A new species emerges: ${who(e, speciesName)}` };
    case 'speciesExtinct':
      return { icon: '🪦', text: `${who(e, speciesName)} goes extinct` };
    case 'firstPredation':
      return { icon: '⚡', text: `First predation — ${who(e, speciesName)} has tasted flesh` };
    case 'massExtinction': {
      const from = num(e, 'from');
      const to = num(e, 'to');
      const text =
        from !== null && to !== null
          ? `Mass extinction — population collapses from ${fmt(from)} to ${fmt(to)}`
          : 'Mass extinction — the population collapses';
      return { icon: '💀', text };
    }
    case 'migration':
      return { icon: '🧭', text: `${who(e, speciesName)} is on the move` };
    case 'seasonChange': {
      const idx = ((num(e, 'season') ?? 0) % 4 + 4) % 4;
      return { icon: SEASON_ICONS[idx], text: SEASON_LINES[idx] };
    }
    case 'birth':
    case 'death':
    case 'matured':
      return null;
  }
}

const CAPTION_SECONDS = 4.5;

/**
 * The bottom caption strip of the documentary camera. `show()` displays a
 * line that fades out after `seconds`; `update(dt)` drives the timer from
 * the frame loop (no per-frame DOM writes unless state changes).
 */
export class Captions {
  private readonly el: HTMLElement;
  private timer = 0;

  constructor(root: HTMLElement) {
    this.el = root;
    root.classList.add('caption');
    root.setAttribute('aria-live', 'polite');
  }

  /** Shows a caption for `seconds` (default 4.5 s), replacing any current one. */
  show(text: string, seconds: number = CAPTION_SECONDS): void {
    this.el.textContent = text;
    this.timer = Math.max(0.1, seconds);
    this.el.classList.add('visible');
  }

  /** Advances the fade timer; call once per rendered frame with dt seconds. */
  update(dt: number): void {
    if (this.timer <= 0) return;
    this.timer -= dt;
    if (this.timer <= 0) this.el.classList.remove('visible');
  }
}
