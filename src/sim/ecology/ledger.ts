/**
 * Energy ledger (DECISIONS.md D4, D5). Single source of truth for every
 * energy transfer in the simulation. Five stored pools (soil, plants, seeds,
 * creatures, corpses) plus two cumulative flows: sunlightIn (the only influx)
 * and heatOut (the only outflux). Invariant, testable to float tolerance:
 *
 *    total() - initialTotal === sunlightIn - heatOut
 *
 * Every mover clamps its amount so no pool ever goes negative, and books
 * exactly the amount that actually moved (both sides of a transfer use the
 * same float value), so clamping never breaks the invariant.
 */
import type { LedgerState } from '../../shared/types';

/** Internal pool keys (the five stores of LedgerState). */
type Pool = 'soil' | 'plants' | 'seeds' | 'creatures' | 'corpses';

export class Ledger {
  private pools: Record<Pool, number> = {
    soil: 0,
    plants: 0,
    seeds: 0,
    creatures: 0,
    corpses: 0,
  };
  private sunlightIn = 0;
  private heatOut = 0;
  private initialTotal = 0;

  /** Read-only snapshot of pools and cumulative flows (a fresh object). */
  state(): LedgerState {
    return {
      sunlightIn: this.sunlightIn,
      heatOut: this.heatOut,
      soil: this.pools.soil,
      plants: this.pools.plants,
      seeds: this.pools.seeds,
      creatures: this.pools.creatures,
      corpses: this.pools.corpses,
    };
  }

  /** Sum of the five stored pools. */
  total(): number {
    const p = this.pools;
    return p.soil + p.plants + p.seeds + p.creatures + p.corpses;
  }

  /**
   * |Δstored − (influx − outflux)|. Zero up to float rounding for any
   * sequence of mover calls after setInitial().
   */
  conservationError(): number {
    return Math.abs(this.total() - this.initialTotal - (this.sunlightIn - this.heatOut));
  }

  /**
   * Initializes the soil pool and records the baseline for conservation.
   * Must be called exactly once, before any mover (a second call rebases).
   */
  setInitial(soil: number): void {
    this.pools.soil = Math.max(0, soil);
    this.initialTotal = this.total();
  }

  /** Clamped pool-to-pool transfer; returns the amount actually moved. */
  private move(from: Pool, to: Pool, e: number): number {
    const moved = Math.min(Math.max(0, e), this.pools[from]);
    this.pools[from] -= moved;
    this.pools[to] += moved;
    return moved;
  }

  /** Pool-to-heat sink; returns the amount actually burned. */
  private burn(from: Pool, e: number): number {
    const moved = Math.min(Math.max(0, e), this.pools[from]);
    this.pools[from] -= moved;
    this.heatOut += moved;
    return moved;
  }

  /**
   * Ingestion with digestion loss: `from` −= gross (clamped), creatures +=
   * gross*eff, heat += the exact remainder. Returns net absorbed.
   */
  private digest(from: Pool, gross: number, eff: number): number {
    const g = Math.min(Math.max(0, gross), this.pools[from]);
    const f = Math.min(1, Math.max(0, eff));
    const net = g * f;
    this.pools[from] -= g;
    this.pools.creatures += net;
    this.heatOut += g - net; // g - net, not g*(1-f): keeps the books float-exact
    return net;
  }

  /** Photosynthesis influx: the only way energy enters the system. */
  sunToPlants(e: number): void {
    const moved = Math.max(0, e);
    this.pools.plants += moved;
    this.sunlightIn += moved;
  }

  /**
   * Nutrient uptake into plant biomass. Clamps to available soil; returns
   * the amount actually moved so callers can mirror it on their soil grid.
   */
  soilToPlants(e: number): number {
    return this.move('soil', 'plants', e);
  }

  /** Plant death residue back to soil. */
  plantsToSoil(e: number): void {
    this.move('plants', 'soil', e);
  }

  /** Seed emission: plant biomass into a dispersed seed energy packet. */
  plantsToSeeds(e: number): void {
    this.move('plants', 'seeds', e);
  }

  /** Germination: seed packet becomes new plant biomass. */
  seedsToPlants(e: number): void {
    this.move('seeds', 'plants', e);
  }

  /** Failed seed decays into soil (no loss). */
  seedsToSoil(e: number): void {
    this.move('seeds', 'soil', e);
  }

  /** Grazing. plants −= gross, creatures += gross*eff, rest to heat. Returns net absorbed. */
  eatPlant(gross: number, eff: number): number {
    return this.digest('plants', gross, eff);
  }

  /** Scavenging. corpses −= gross, creatures += gross*eff, rest to heat. Returns net absorbed. */
  eatCorpse(gross: number, eff: number): number {
    return this.digest('corpses', gross, eff);
  }

  /**
   * Predation bite: creature-to-creature transfer inside the creatures pool;
   * only the digestion loss gross*(1−eff) leaves to heat (the caller debits
   * the victim's store and credits the biter's). Returns net absorbed.
   */
  biteCreature(gross: number, eff: number): number {
    const g = Math.min(Math.max(0, gross), this.pools.creatures);
    const f = Math.min(1, Math.max(0, eff));
    const net = g * f;
    this.pools.creatures -= g - net;
    this.heatOut += g - net;
    return net;
  }

  /** Metabolism (basal + brain + muscle + thermoregulation): creatures → heat. */
  creatureHeat(e: number): void {
    this.burn('creatures', e);
  }

  /** Gestation overhead lost while endowing an offspring: creatures → heat. */
  birthOverhead(e: number): void {
    this.burn('creatures', e);
  }

  /** Death: store + body biomass of the deceased become a corpse. */
  creaturesToCorpse(e: number): void {
    this.move('creatures', 'corpses', e);
  }

  /**
   * Decomposition step: corpses −= gross (clamped), soil += gross*(1−lossFrac),
   * heat += gross*lossFrac — computed as (g − loss) so both sides are exact.
   */
  corpseToSoil(gross: number, lossFrac: number): void {
    const g = Math.min(Math.max(0, gross), this.pools.corpses);
    const frac = Math.min(1, Math.max(0, lossFrac));
    const loss = g * frac;
    this.pools.corpses -= g;
    this.pools.soil += g - loss;
    this.heatOut += loss;
  }

  /** Droppings / excretion: creatures → soil, no loss. */
  creaturesToSoil(e: number): void {
    this.move('creatures', 'soil', e);
  }

  /**
   * Founder/rescue spawns condense out of the substrate: soil → creatures,
   * no loss (used by world.ts so seeded founders don't invent energy).
   * Not in the original module contract; added because the world integration
   * requires it. Returns the amount actually moved.
   */
  soilToCreatures(e: number): number {
    return this.move('soil', 'creatures', e);
  }
}
