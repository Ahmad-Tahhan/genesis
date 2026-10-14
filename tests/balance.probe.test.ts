/** Temporary balance probe (not shipped): watch ecosystem dynamics headlessly. */
import { it } from 'vitest';
import { World } from '../src/sim/world';

it('balance probe', async () => {
  const w = new World();
  await w.init(2026);
  const dump = () => {
    const l = w.ledger.state();
    const herb = [...w.creatures.values()].map((c) => c.genome.organism.gutHerbivory);
    const meanH = herb.length ? herb.reduce((a, b) => a + b, 0) / herb.length : 0;
    const bred = [...w.creatures.values()].filter((c) => c.parents.length > 0).length;
    const eFrac = [...w.creatures.values()].map((c) => c.energy / c.capacity);
    const meanE = eFrac.length ? eFrac.reduce((a, b) => a + b, 0) / eFrac.length : 0;
    // eslint-disable-next-line no-console
    console.log(
      `t=${w.time.toFixed(0)}s pop=${w.creatures.size} births=${w.birthsTotal} deaths=${w.deathsTotal}`,
      `plants=${w.eco.plantCount()} soil=${l.soil.toFixed(0)} plantE=${l.plants.toFixed(0)}`,
      `creatE=${l.creatures.toFixed(0)} corpseE=${l.corpses.toFixed(0)} seedE=${l.seeds.toFixed(0)}`,
      `species=${w.species.living().length} meanHerb=${meanH.toFixed(2)} bred=${bred} meanEfrac=${meanE.toFixed(2)}`,
    );
  };
  dump();
  for (let i = 0; i < 60000; i++) {
    w.step();
    if (i % 6000 === 5999) dump();
  }
}, 240_000);
