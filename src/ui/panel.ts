/**
 * Right side panel with ARIA tabs (Inspector / Species / Phylogeny / Events).
 * Collapses to a bottom sheet under 900px wide (CSS only).
 */

/** The four tab identifiers. */
export type TabName = 'inspector' | 'species' | 'phylo' | 'events';

const TABS: { name: TabName; label: string }[] = [
  { name: 'inspector', label: 'Inspector' },
  { name: 'species', label: 'Species' },
  { name: 'phylo', label: 'Phylogeny' },
  { name: 'events', label: 'Events' },
];

/**
 * Tabbed side panel. `content(tab)` returns the stable container element a
 * view renders into; `select(tab)` switches tabs and fires `onSelect`.
 */
export class SidePanel {
  /** Called whenever the selected tab changes (user or programmatic). */
  onSelect?: (tab: TabName) => void;

  private readonly tabs = new Map<TabName, HTMLButtonElement>();
  private readonly panels = new Map<TabName, HTMLElement>();
  private currentTab: TabName;

  constructor(root: HTMLElement) {
    root.classList.add('side', 'panel');

    const tablist = document.createElement('div');
    tablist.className = 'tabs';
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Observation panels');

    for (const { name, label } of TABS) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.id = `tab-${name}`;
      tab.textContent = label;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', 'false');
      tab.setAttribute('aria-controls', `tabpanel-${name}`);
      tab.tabIndex = -1;
      tab.addEventListener('click', () => this.select(name));
      this.tabs.set(name, tab);
      tablist.appendChild(tab);

      const pane = document.createElement('div');
      pane.className = 'tabpanel';
      pane.id = `tabpanel-${name}`;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', tab.id);
      pane.hidden = true;
      this.panels.set(name, pane);
    }

    tablist.addEventListener('keydown', (e) => this.onKey(e));

    root.appendChild(tablist);
    for (const pane of this.panels.values()) root.appendChild(pane);

    this.currentTab = 'inspector';
    this.apply('inspector');
  }

  /** The container element a view renders that tab's body into. */
  content(tab: TabName): HTMLElement {
    const pane = this.panels.get(tab);
    if (!pane) throw new Error(`unknown tab: ${tab}`);
    return pane;
  }

  /** Switches to `tab`; no-op if already selected. Fires `onSelect`. */
  select(tab: TabName): void {
    if (tab === this.currentTab || !this.tabs.has(tab)) return;
    this.currentTab = tab;
    this.apply(tab);
    this.onSelect?.(tab);
  }

  // ------------------------------------------------------------ internals

  private apply(tab: TabName): void {
    for (const [name, b] of this.tabs) {
      const sel = name === tab;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
    }
    for (const [name, pane] of this.panels) pane.hidden = name !== tab;
  }

  /** Roving-focus arrow keys on the tablist; selection follows focus. */
  private onKey(e: KeyboardEvent): void {
    const order = TABS.map((t) => t.name);
    const idx = order.indexOf(this.currentTab);
    let next: TabName | null = null;
    if (e.key === 'ArrowRight') next = order[(idx + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(idx + order.length - 1) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    if (next) {
      e.preventDefault();
      this.select(next);
      this.tabs.get(next)?.focus();
    }
  }
}
