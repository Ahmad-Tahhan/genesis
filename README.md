# Genesis

A scientifically grounded 3D evolution simulator that runs in the browser.
Creatures are not designed: their bodies, brains, behaviour, diets and species
all emerge from a genome under mutation, crossover and natural selection, in a
closed-energy ecosystem with real physics.

**Stack:** Vite · TypeScript (strict) · Three.js (rendering) · Rapier physics
(`@dimforge/rapier3d-compat`). The simulation runs in a Web Worker; the main
thread only renders and handles UI. Every texture, mesh and sound is generated
in code — the repository contains no binary assets.

## Running it

```bash
npm install
npm run dev        # local dev server
npm test           # unit + science-validation tests
npm run build      # typecheck + production build
```

Deployed automatically to GitHub Pages from `main` (see
`.github/workflows/deploy.yml`). Add `?seed=12345` to the URL to replay a
specific world.

## The science model

### Energy: one ledger, closed books
All energy in the world is tracked in a single ledger with five stores — soil
nutrients, plant biomass, seeds, creatures (store + structural biomass), and
corpses. **Sunlight is the only income; heat is the only expense.** Every
transfer (photosynthesis, grazing, predation, digestion loss, gestation
overhead, decomposition) moves energy between stores or out to heat. A test
asserts `sunlight_in − heat_out = Δ(stored)` to floating-point tolerance over
a long simulation run with births, kills and decomposition happening. Founding
creatures aren't free either: they condense out of the soil pool.

What is *not* conserved is mechanical energy — no game physics engine conserves
it. Muscle work is expensed *metabolically* at the moment of actuation
(commanded torque × joint speed), which is the quantity that matters for
selection.

### Metabolism: Kleiber's law
Basal metabolic rate scales with body mass as `mass^0.75` (Kleiber's law), so
big bodies pay sublinearly — size is an investment with returns. On top of
basal cost: each brain node and synapse costs energy per second (big brains
must earn their keep), muscles bill for mechanical work plus activation
overhead, and cold seasons add a thermoregulation cost that also scales with
`mass^0.75`.

### Genetics: developmental body encoding + NEAT brains
A genome has three chromosomes:

- **Body genes** — a small directed graph (Karl Sims-style). Each gene encodes
  a part (box/capsule, size, density), its attachment to the parent part,
  a motorized revolute joint (axis, limits, muscle strength), repetition
  (`recursion` grows chains of segments), bilateral `mirror` flags, and organs:
  vision rays, smell, a mouth, pigment and skin-pattern parameters.
  Development expands the graph deterministically into a body plan (≤ 12
  parts). Gene duplication and deletion are first-class mutations, so body
  complexity can grow and shrink.
- **Organism genes** — gut herbivory↔carnivory spectrum (a digestion-efficiency
  trade-off: nobody digests everything well), sexual-reproduction preference,
  offspring energy endowment, global size scale.
- **Brain genes** — a NEAT-style network: node and connection genes with global
  innovation numbers. Mutations jitter weights, add connections, split
  connections into new hidden nodes (with evolvable activation functions:
  tanh/sin/relu/gauss), and toggle genes. Crossover aligns on innovation
  numbers. When a body mutation changes the sensor/joint count, the brain
  genome is repaired to the new IO layout.

Senses: vision rays (distance + colour of the first thing hit — creature
pigment, plant green, terrain), smell gradients for plants and carrion, touch
per body part, plus internal hunger, energy, health, speed, uprightness and a
clock oscillator. Outputs drive joint motors. **There is no scripted walking,
no steering code, no behaviour tree** — every motion is an evolved neural
policy driving muscles.

### Diet and trophic levels are emergent
Eating happens when a mouth part touches something edible. Whether a creature
*profits* from plants or meat is set by its gut gene, and whether it can catch
prey is set by its evolved body and brain — so herbivores, predators and
scavengers are ecological outcomes, not assigned roles. The UI's diet bar
(plant vs meat intake over a lifetime) makes the emergence visible. The first
live-prey bite in a world's history is logged as the "first predation" event.

### The nutrient cycle is closed
Plants photosynthesize (sunlight income gated by local light, soil nutrients
and moisture), draw soil nutrients into biomass, and spend energy to scatter
seeds. Creatures eat plants, each other, and corpses. Dead creatures and failed
seeds decompose back into soil nutrients (minus heat loss). Soil fertility
follows the geology: the erosion simulation deposits sediment where water
flowed.

### Terrain, seasons, climate
The terrain is an fBm heightfield sculpted by ~30k droplets of hydraulic
erosion, with a river carved along the flow field into a lake. Moisture and
fertility fields fall out of the hydrology and drive the plant distribution.
A day/night cycle drives photosynthesis and the sky; a 16-day year drives
seasons (light amplitude + winter thermoregulation stress); on top, a slow
climate drift (long sine + random walk) shifts the selective landscape over
evolutionary time.

### Species and phylogeny
Newborns are assigned to species by genetic compatibility distance (brain
excess/disjoint/weight terms + body-graph distance + diet distance), founding
a new species when no representative is close enough — the same distance also
gates mate compatibility, so species ≈ breeding pools. Every species gets a
procedurally generated binomial name, and the full phylogenetic tree (birth,
parent, extinction, peak population) is recorded and drawn live.

## Controls

| Input | Action |
|---|---|
| Drag / wheel | Orbit & zoom (manual camera pauses the documentary camera) |
| Click a creature | Inspect: genome, live brain graph, energy, diet, lineage |
| `Space` | Pause / resume |
| `1` / `2` / `3` | 1× / 10× / max speed (max runs the sim without rendering) |
| `Esc` | Deselect |
| 🎥 | Toggle the documentary camera (auto-follows hunts, births, migrations) |
| 🔊 | Toggle the procedural soundscape |

Panels: **Inspector** (selected creature), **Species** (population history per
species + plant biomass), **Phylogeny** (live tree over time), **Events**
(timeline of key moments — click to fly the camera there).

## Validation

`npm test` runs, among unit tests for every module:

- **Energy conservation** — 3000-tick full-ecosystem run; ledger error < 1e-6
  relative.
- **Kleiber scaling** — measured basal spend of two creatures matches the
  `mass^0.75` ratio within 5%.
- **Selection response** — truncation selection for carnivory shifts the mean
  gut gene by > 0.2 in 30 generations while an unselected control drifts
  < 0.15; NEAT brains evolve a stimulus→response behaviour from scratch.
- **Determinism** — two worlds with the same seed produce bit-identical
  snapshots after 400 ticks.

## What I would add next

- **Juvenile growth** — bodies that grow from a gene-set starting scale,
  making offspring cheaper and life histories (r/K strategies) evolvable.
- **True gene-regulatory development** — replace the direct body graph with a
  regulatory network so heterochrony and modularity can evolve.
- **Evolvable lungs/gills & thermoregulation genes** — open the water and the
  climate extremes as niches instead of hazards.
- **Spatial soil/water diffusion** — nutrients flowing downhill and through
  the river, making geography matter even more.
- **Replay & lineage scrubbing** — record genome + event streams so any
  moment in a world's history can be revisited deterministically.
- **GPU neural batching** — evaluate all brains in one WebGPU pass to raise
  the population cap by an order of magnitude.
