import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../src/shared/types';
import { fmt, speciesColor } from '../src/ui/charts';
import { captionFor, SEASON_NAMES } from '../src/ui/captions';

const names = new Map<number, string>([[7, 'Velox arenae']]);
const speciesName = (id?: number): string => (id === undefined ? '?' : (names.get(id) ?? `species ${id}`));

function ev(partial: Partial<SimEvent> & { kind: SimEvent['kind'] }): SimEvent {
  return { tick: 7200, interest: 1, ...partial };
}

describe('fmt', () => {
  it('keeps small numbers plain with at most one decimal', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(5)).toBe('5');
    expect(fmt(3.14159)).toBe('3.1');
    expect(fmt(999)).toBe('999');
    expect(fmt(-2.55)).toBe('-2.5');
  });

  it('uses k and M suffixes', () => {
    expect(fmt(1000)).toBe('1k');
    expect(fmt(1234)).toBe('1.2k');
    expect(fmt(10500)).toBe('10.5k');
    expect(fmt(2500000)).toBe('2.5M');
    expect(fmt(-1234)).toBe('-1.2k');
  });

  it('handles non-finite input', () => {
    expect(fmt(Number.NaN)).toBe('—');
    expect(fmt(Infinity)).toBe('—');
  });
});

describe('speciesColor', () => {
  it('is a stable hsl() string with wrapped hue', () => {
    expect(speciesColor(0.5)).toBe('hsl(180, 68%, 62%)');
    expect(speciesColor(1.5)).toBe(speciesColor(0.5));
    expect(speciesColor(-0.25)).toBe(speciesColor(0.75));
  });
});

describe('captionFor', () => {
  it('names the species in hunt and kill lines', () => {
    const hunt = captionFor(ev({ kind: 'hunt', speciesId: 7 }), speciesName);
    expect(hunt?.icon).toBe('🐾');
    expect(hunt?.text).toBe('A Velox arenae runs down its prey');
    const kill = captionFor(ev({ kind: 'kill', speciesId: 7 }), speciesName);
    expect(kill?.text).toContain('Velox arenae');
    expect(kill?.text).toContain('kill');
  });

  it('prefers the name carried in the event payload', () => {
    const born = captionFor(ev({ kind: 'speciesBorn', speciesId: 99, data: { name: 'Umbra montis' } }), speciesName);
    expect(born?.text).toBe('A new species emerges: Umbra montis');
    const gone = captionFor(ev({ kind: 'speciesExtinct', data: { name: 'Umbra montis' } }), speciesName);
    expect(gone?.text).toBe('Umbra montis goes extinct');
  });

  it('formats mass extinction population collapse from the payload', () => {
    const cap = captionFor(ev({ kind: 'massExtinction', data: { from: 120, to: 31 } }), speciesName);
    expect(cap?.icon).toBe('💀');
    expect(cap?.text).toBe('Mass extinction — population collapses from 120 to 31');
  });

  it('survives a missing mass extinction payload', () => {
    const cap = captionFor(ev({ kind: 'massExtinction' }), speciesName);
    expect(cap?.text).toContain('Mass extinction');
  });

  it('narrates first predation and migration', () => {
    const first = captionFor(ev({ kind: 'firstPredation', speciesId: 7 }), speciesName);
    expect(first?.text).toBe('First predation — Velox arenae has tasted flesh');
    const mig = captionFor(ev({ kind: 'migration', data: { name: 'Velox arenae' } }), speciesName);
    expect(mig?.icon).toBe('🧭');
    expect(mig?.text).toBe('Velox arenae is on the move');
  });

  it('uses season names for season changes', () => {
    for (let s = 0; s < 4; s++) {
      const cap = captionFor(ev({ kind: 'seasonChange', data: { season: s } }), speciesName);
      expect(cap).not.toBeNull();
      expect(cap?.text).toContain(SEASON_NAMES[s]);
    }
  });

  it('returns null for kinds not worth narrating', () => {
    expect(captionFor(ev({ kind: 'birth' }), speciesName)).toBeNull();
    expect(captionFor(ev({ kind: 'death' }), speciesName)).toBeNull();
    expect(captionFor(ev({ kind: 'matured' }), speciesName)).toBeNull();
  });
});
