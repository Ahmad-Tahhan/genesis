/**
 * Species tracking + phylogenetic tree (DECISIONS.md D11).
 *
 * Representative-based online clustering: a newborn joins the first living
 * species whose representative genome is within SPECIES_THRESHOLD of its own
 * (parent's species checked first as a fast path), otherwise it founds a new
 * species whose phylogenetic parent is the parent's species. Every species
 * ever founded stays in the record (living + extinct) so phylo() can return
 * the full tree.
 *
 * Determinism: the tracker consumes its RNG only when founding a species
 * (name draw + hue jitter), so an identical assign/death call sequence with
 * an identically seeded RNG reproduces identical records.
 */
import type { Genome, PhyloNode, SpeciesRecord, SpeciesTraits } from '../shared/types';
import { SPECIES_THRESHOLD } from '../shared/constants';
import { RNG } from '../shared/rng';

/** Compatibility distance between two genomes (injected; see genome modules). */
export type GenomeDistance = (a: Genome, b: Genome) => number;

/** Syllable tables for procedural latin-ish binomials. Letters only, so the
 *  result always matches /^[A-Z][a-z]+ [a-z]+$/. */
const ONSETS = [
  'v', 't', 'k', 's', 'm', 'n', 'r', 'l', 'd', 'g', 'p', 'b', 'f', 'z', 'th', 'ch', 'x', 'qu',
] as const;
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'y', 'ae', 'io'] as const;
const GENUS_ENDINGS = ['x', 'r', 's', 'n', 'us', 'or', 'ax', 'is', 'on', 'a'] as const;
const EPITHET_ENDINGS = ['us', 'is', 'um', 'ax', 'or', 'ens', 'ilis', 'atus', 'odon', 'ura'] as const;

/** One word: `syllables` onset+vowel pairs plus an ending from `endings`. */
function word(rng: RNG, syllables: number, endings: readonly string[]): string {
  let w = '';
  for (let i = 0; i < syllables; i++) w += rng.pick(ONSETS) + rng.pick(VOWELS);
  return w + rng.pick(endings);
}

/**
 * Procedural latin-ish binomial, e.g. "Vorax tilunis": capitalized genus +
 * lowercase epithet, built from syllable tables. Consumes a fixed-per-call
 * draw pattern from `rng` (deterministic per seed). Name space is ~1e10, so
 * collisions over realistic run lengths are negligible but not impossible —
 * SpeciesTracker additionally retries on collision.
 */
export function makeSpeciesName(rng: RNG): string {
  const genus = word(rng, 2 + rng.int(2), GENUS_ENDINGS);
  const epithet = word(rng, 2 + rng.int(2), EPITHET_ENDINGS);
  return genus.charAt(0).toUpperCase() + genus.slice(1) + ' ' + epithet;
}

/** Wrap a hue into [0, 1). */
function wrapHue(h: number): number {
  return ((h % 1) + 1) % 1;
}

/** Internal per-species state: the public record + the clustering representative. */
interface SpeciesEntry {
  record: SpeciesRecord;
  representative: Genome;
}

/** Max name re-draws on collision before accepting a duplicate ("unique-ish"). */
const NAME_RETRIES = 8;

/**
 * Online species clustering + full phylogeny. One instance per world; all
 * methods are O(living species) or better. Records returned by get/living/
 * all are the live internal objects — callers must treat them as read-only.
 */
export class SpeciesTracker {
  private readonly rng: RNG;
  private readonly distance: GenomeDistance;
  private readonly entries = new Map<number, SpeciesEntry>();
  private readonly usedNames = new Set<string>();
  private nextId = 0;

  constructor(rng: RNG, distance: GenomeDistance) {
    this.rng = rng;
    this.distance = distance;
  }

  /**
   * Assign a newborn to a species. Checks the parent species representative
   * first (fast path), then all living species representatives in founding
   * order; founds a new species (parent = parentSpeciesId) when all exceed
   * SPECIES_THRESHOLD. Increments population (and peak). Returns speciesId.
   * parentSpeciesId = -1 marks a seeded founder lineage.
   */
  assign(genome: Genome, parentSpeciesId: number, tick: number): number {
    // Fast path: the overwhelmingly common case is staying in the parent's species.
    const parent = this.entries.get(parentSpeciesId);
    if (parent && parent.record.extinctTick === null) {
      if (this.distance(genome, parent.representative) <= SPECIES_THRESHOLD) {
        return this.join(parent);
      }
    }
    // Full scan over living species (ascending id = founding order, deterministic).
    for (const entry of this.entries.values()) {
      if (entry.record.extinctTick !== null) continue;
      if (entry.record.id === parentSpeciesId) continue; // already checked
      if (this.distance(genome, entry.representative) <= SPECIES_THRESHOLD) {
        return this.join(entry);
      }
    }
    return this.found(genome, parentSpeciesId, tick);
  }

  /** Member died: decrement population; at 0 mark extinctTick. */
  memberDied(speciesId: number, tick: number): void {
    const entry = this.entries.get(speciesId);
    if (!entry || entry.record.population <= 0) return;
    entry.record.population--;
    if (entry.record.population === 0 && entry.record.extinctTick === null) {
      entry.record.extinctTick = tick;
    }
  }

  /**
   * Replace the clustering representative with a living member's genome.
   * Call occasionally so the representative tracks the drifting mean; stale
   * representatives make splits too eager.
   */
  refreshRepresentative(speciesId: number, genome: Genome): void {
    const entry = this.entries.get(speciesId);
    if (entry) entry.representative = genome;
  }

  /** Replace the species' mean-trait summary (copied; caller keeps its object). */
  updateTraits(speciesId: number, traits: SpeciesTraits): void {
    const entry = this.entries.get(speciesId);
    if (entry) entry.record.traits = { ...traits };
  }

  /** The record for `id`, or undefined if never founded. */
  get(id: number): SpeciesRecord | undefined {
    return this.entries.get(id)?.record;
  }

  /** Living species (population > 0), in founding order. */
  living(): SpeciesRecord[] {
    const out: SpeciesRecord[] = [];
    for (const e of this.entries.values()) {
      if (e.record.extinctTick === null) out.push(e.record);
    }
    return out;
  }

  /** Every species ever founded (living + extinct), in founding order. */
  all(): SpeciesRecord[] {
    const out: SpeciesRecord[] = [];
    for (const e of this.entries.values()) out.push(e.record);
    return out;
  }

  /**
   * Full phylogenetic tree over all species ever (living + extinct). Each
   * node's parentId is -1 or the id of an earlier-founded node, so the result
   * is always a forest ordered root-first.
   */
  phylo(): PhyloNode[] {
    const out: PhyloNode[] = [];
    for (const e of this.entries.values()) {
      const r = e.record;
      out.push({
        id: r.id,
        name: r.name,
        parentId: r.parentId,
        bornTick: r.bornTick,
        extinctTick: r.extinctTick,
        hue: r.hue,
        population: r.population,
        peakPopulation: r.peakPopulation,
      });
    }
    return out;
  }

  /** Total species ever founded. */
  count(): number {
    return this.entries.size;
  }

  /** Add one member to an existing species, maintaining peakPopulation. */
  private join(entry: SpeciesEntry): number {
    entry.record.population++;
    if (entry.record.population > entry.record.peakPopulation) {
      entry.record.peakPopulation = entry.record.population;
    }
    return entry.record.id;
  }

  /**
   * Found a new species around `genome` (its first member and representative).
   * Hue derives from the founding genome's first body gene color[0] (stable
   * chart/phylo color), jittered slightly so sibling splits are
   * distinguishable. Name regenerated on collision up to NAME_RETRIES.
   */
  private found(genome: Genome, parentSpeciesId: number, tick: number): number {
    const id = this.nextId++;
    let name = makeSpeciesName(this.rng);
    for (let i = 0; i < NAME_RETRIES && this.usedNames.has(name); i++) {
      name = makeSpeciesName(this.rng);
    }
    this.usedNames.add(name);
    const baseHue = genome.body.length > 0 ? genome.body[0].color[0] : this.rng.next();
    const record: SpeciesRecord = {
      id,
      name,
      parentId: parentSpeciesId,
      bornTick: tick,
      extinctTick: null,
      hue: wrapHue(baseHue + this.rng.range(-0.05, 0.05)),
      population: 1,
      peakPopulation: 1,
      traits: { meanMass: 0, meanHerbivory: 0, meanSpeed: 0, meanBrainSize: 0, meanParts: 0 },
    };
    this.entries.set(id, { record, representative: genome });
    return id;
  }
}
