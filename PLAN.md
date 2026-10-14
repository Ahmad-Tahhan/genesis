# Genesis — Build Plan

A scientifically grounded 3D evolution simulator in the browser.
Stack: Vite + TypeScript (strict) + Three.js (rendering) + Rapier (`@dimforge/rapier3d-compat`, physics).
Simulation runs in a Web Worker; the main thread only renders and handles UI.
No external assets — all geometry, textures, and sound are generated in code.

**Core rule:** nothing about the creatures is designed by hand. Bodies, brains,
behaviour, diet and species all emerge from a genome under mutation, crossover
and natural selection.

## Architecture

```
main thread                           web worker
┌─────────────────────────┐          ┌──────────────────────────────┐
│ Three.js renderer       │ snapshot │ Rapier physics world         │
│  sky/sun, water, terrain│◄─────────│ creatures (bodies+joints)    │
│  creatures, plants      │ buffers  │ NEAT brains, senses          │
│ UI panels, charts,      │          │ energy ledger, metabolism    │
│  phylo tree, timeline   │ events   │ plants, soil, decomposition  │
│ documentary camera      │◄─────────│ reproduction, speciation     │
│ WebAudio soundscape     │ commands │ event detection              │
└─────────────────────────┘─────────►└──────────────────────────────┘
```

- Protocol: transferable `ArrayBuffer` snapshots (per-part transforms, plant
  instances) + JSON control/event messages. No SharedArrayBuffer (GitHub Pages
  has no COOP/COEP headers).
- Determinism: one seeded PRNG (`mulberry32`) forked per subsystem; no
  `Math.random` in the simulation.

## Module layout

```
src/shared/     types.ts, protocol.ts, constants.ts, rng.ts   (the contract)
src/sim/        worker.ts, world.ts, physics.ts, creature.ts, senses.ts,
                species.ts, events.ts
src/sim/genome/ body.ts (genome ops), development.ts (genome→body plan),
                brain.ts (NEAT)
src/sim/ecology/ terrain.ts (gen+erosion), plants.ts, ledger.ts
src/render/     renderer.ts, sky.ts, water.ts, terrainMesh.ts, creatures.ts,
                plants.ts, materials.ts, camera.ts
src/ui/         hud.ts, inspector.ts, charts.ts, phylo.ts, timeline.ts,
                captions.ts, style.css
src/audio/      soundscape.ts
tests/          vitest unit + science-validation tests
```

## Science model (summary; details in README)

- **Energy ledger.** Every joule is tracked: sunlight is the only influx;
  heat (metabolic, digestive, decomposition loss) is the only outflux; stores
  are soil nutrients, plant biomass, creature stores/biomass, corpses, seeds.
  Test asserts `influx − outflux = Δstored` to float tolerance.
- **Kleiber's law.** Basal metabolic rate ∝ mass^0.75. Brain cost ∝ network
  size. Muscle cost ∝ commanded torque × joint speed (expensed at actuation).
- **Diet from genes.** A gut gene sets a herbivory↔carnivory digestion
  spectrum (efficiency trade-off); mouth genes set what can be bitten.
  Predation, herbivory and scavenging emerge, not assigned.
- **Closed nutrient cycle.** Plants photosynthesize (sun influx gated by soil
  nutrients + water), creatures eat plants/creatures, corpses decompose back
  into soil nutrients.
- **NEAT brains.** Topology-evolving networks; innovation numbers for
  crossover; speciation by genetic compatibility distance (body + brain).
- **Phylogeny.** Full species tree recorded (birth, parent, extinction,
  population history).

## Milestones

- **M0 — Scaffold.** Vite+TS strict, vitest, this plan, DECISIONS.md, shared
  contracts (types/protocol/constants/rng). Commit.
- **M1 — Core modules (pure logic, unit-tested).** Terrain gen + hydraulic
  erosion + river/lake; body genome ops; development (genome→body plan); NEAT
  brain; ecology (soil/plants/ledger); species/phylogeny. Commit.
- **M2 — Simulation integration.** Rapier world in worker: heightfield,
  creature bodies with motorized joints, senses (vision rays/smell/touch),
  metabolism, eating, reproduction, death, decomposition; snapshot protocol.
  Commit.
- **M3 — Rendering.** PBR terrain with procedural splatting, sky + sun cycle,
  reflective water, fog, soft shadows, creature meshes with gene-derived
  procedural skin textures, instanced plants. Commit.
- **M4 — UI & observation.** Time controls (pause/1x/10x/max), creature
  inspector (genome, live brain graph, energy, lineage), species population
  charts, live phylo tree, event timeline, documentary camera with captions,
  procedural soundscape. Commit.
- **M5 — Science validation & performance.** Energy-conservation test over a
  long run; selection-pressure test (trait mean shifts under directional
  pressure); determinism test; perf pass (60 fps at 1x target). Commit.
- **M6 — Ship.** GitHub Actions deploy to Pages (base = repo name), README
  (science model, controls, future work). Commit, push, PR.

## Performance budget (mid-range laptop, 1x)

- ≤ ~140 creatures × ≤ 12 parts; physics at 60 Hz fixed step in worker.
- Rendering: instanced plants, one merged terrain mesh, per-creature groups of
  shared primitive geometries; PCF soft shadow map (2048); snapshot ≤ 64 KB.
- "Max" mode: worker free-runs, stats-only messages at ~4 Hz, renderer idles.
