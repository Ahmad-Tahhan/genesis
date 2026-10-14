/**
 * Event timeline: a clickable list of notable simulation events, newest
 * first, worded by the shared caption dictionary (captions.captionFor).
 */
import type { SimEvent } from '../shared/types';
import { DAY_LENGTH, DT } from '../shared/constants';
import { captionFor } from './captions';

const MAX_ROWS = 200;
const MIN_INTEREST = 0.25;

/**
 * The Events tab body. `add()` appends new events (most interesting kinds
 * only), keeps the most recent ~200 rows, and clicking (or Enter/Space on) a
 * row calls `onFocus` so the camera can fly to the event.
 */
export class Timeline {
  private readonly list: HTMLUListElement;
  private readonly onFocus: (e: SimEvent) => void;

  constructor(container: HTMLElement, onFocus: (e: SimEvent) => void) {
    this.onFocus = onFocus;
    this.list = document.createElement('ul');
    this.list.className = 'events';
    container.appendChild(this.list);
  }

  /**
   * Adds a batch of events (chronological order in, newest shown first).
   * Events below interest 0.25 or without a caption are skipped.
   */
  add(events: SimEvent[], speciesName: (id?: number) => string): void {
    for (const e of events) {
      if (e.interest < MIN_INTEREST) continue;
      const cap = captionFor(e, speciesName);
      if (!cap) continue;
      this.list.insertBefore(this.row(e, cap.icon, cap.text), this.list.firstChild);
    }
    while (this.list.children.length > MAX_ROWS) this.list.removeChild(this.list.lastChild as Node);
  }

  // ------------------------------------------------------------ internals

  private row(e: SimEvent, icon: string, text: string): HTMLLIElement {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    const day = Math.floor((e.tick * DT) / DAY_LENGTH) + 1;
    const iconEl = document.createElement('span');
    iconEl.className = 'ev-icon';
    iconEl.textContent = icon;
    iconEl.setAttribute('aria-hidden', 'true');
    const textEl = document.createElement('span');
    textEl.className = 'ev-text';
    textEl.textContent = text;
    const dayEl = document.createElement('span');
    dayEl.className = 'ev-day';
    dayEl.textContent = `Day ${day}`;
    li.append(iconEl, textEl, dayEl);
    li.setAttribute('aria-label', `${text}, day ${day}`);

    const focus = (): void => this.onFocus(e);
    li.addEventListener('click', focus);
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.code === 'Space') {
        ev.preventDefault();
        focus();
      }
    });
    return li;
  }
}
