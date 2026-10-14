# DECISIONS

Running log of design decisions made autonomously during the build.

## D1 — Worker protocol: transferable buffers, no SharedArrayBuffer
GitHub Pages cannot send COOP/COEP headers, so `SharedArrayBuffer` is
unavailable there. Snapshots are `Float32Array`s posted with transfer
semantics (ping-pong), control/events are structured-clone JSON.

## D2 — Genome encoding: directed-graph developmental encoding (Sims-style)
Body genome is a small directed graph of part genes (shape, size, joint,
muscle, sensors, mouth) with recursion limits and bilateral-mirror flags,
"grown" by a deterministic development pass capped at `MAX_PARTS`. This gives
gene duplication and structural mutation a natural meaning (copy a subtree
gene, grow repeated segments) while staying cheap enough for real-time
physics. A full gene-regulatory network was considered and rejected for
performance and debuggability at this scope.

## D3 — Brains: NEAT with iterative (recurrent-capable) activation
Node/connection genes with global innovation numbers; crossover aligns on
innovation; compatibility distance includes body distance so speciation sees
morphology too. Networks are evaluated by one propagation sweep per sim tick
(standard real-time NEAT), which permits recurrence without cycle handling.

## D4 — Energy ledger semantics
The conserved quantity is **metabolic** energy, not mechanical energy; a game
physics engine cannot conserve mechanical energy. Muscle work is expensed from
the creature's store at the moment of actuation (torque × joint speed + an
activation overhead) and booked as heat. Every transfer (photosynthesis,
eating, digestion loss, reproduction, decomposition) goes through
`ledger.ts`, so `sunlight_in − heat_out = Δ(total stored)` is testable to
float tolerance.

## D5 — Mass-energy coupling via biomass
Creature mass comes from developed body volume × density; building a body at
birth debits the parent's store by `biomass = mass × TISSUE_ENERGY_DENSITY`.
On death the corpse keeps that biomass plus leftover store, which decomposers
return to soil nutrients (minus a heat loss fraction). Eating a corpse/creature
transfers from that pool. This closes the cycle without inventing energy.

## D6 — Terrain: fBm heightfield + droplet hydraulic erosion
Simplex-noise fBm base, ~35k droplet erosion passes, then river carving from a
high point along the flow field into a basin filled as a lake at a fixed water
level. Soil fertility and moisture fields are by-products of erosion
(sediment deposition) and water proximity, so plant distribution follows the
geology, not hand-painting.

## D7 — Water rendering without assets
Three.js `Reflector`-style planar reflection with a custom shader (procedural
normal perturbation; no normal-map texture), because the stock
`examples/jsm/objects/Water.js` needs an external normals texture and the
project bans external assets.

## D8 — Vite base path
`base` comes from the `VITE_BASE` env var (set to `/<repo>/` by the Pages
workflow), defaulting to `/` for local dev.

## D9 — Max-speed mode
"Max" runs the worker loop free (budgeted ~12 ms chunks via setTimeout(0) to
keep the worker responsive to commands), suppresses snapshots, and sends
stats/events at ~4 Hz. The renderer keeps drawing the last snapshot.

## D10 — UI conventions (greenfield)
This is a fresh repo with no existing UI patterns to mine, so the conventions
are established here and all panels must follow them: dark translucent panels
(`--panel` token), one accent per species-stable hue, system font stack, all
colors/spacing as CSS custom properties in `src/ui/style.css`, HTML overlay UI
(no in-canvas text), canvas-based charts with shared axis/palette helpers from
`charts.ts`. Panels: top HUD bar (time controls + clock + stats), right tabbed
panel (Inspector / Species / Phylogeny / Timeline), bottom caption strip for
the documentary camera.

## D11 — Species tracking
Representative-based online clustering: a creature joins the first species
whose representative is within `SPECIES_THRESHOLD` compatibility distance,
else founds a new species (parent = its ancestor's species) — recorded in the
phylogenetic tree with birth/extinction ticks and population history.

## D12 — Reproduction
Both modes exist from the start; genes choose. A creature above an energy
threshold with `sexual` gene expression seeks mates (sexual: NEAT crossover +
body-gene crossover), otherwise buds asexually (clone + mutation). Offspring
energy endowment is itself a gene. Mutation: weight jitter, add/remove
connection, add node, body-gene point mutations, gene duplication, gene
deletion.

## D13 — Determinism
All sim randomness flows from one seeded `mulberry32` PRNG forked per
subsystem. `Math.random` is banned in `src/sim` and `src/shared` (lint grep in
CI). Rapier is deterministic for a fixed build/wasm, same-machine replays.

## D14 — Vision
Vision = N evolved eye rays (direction genes) cast in Rapier against creatures
and plants, returning distance + target color (creature pigment / plant green).
Smell = bilinear sample of plant-biomass and carrion gradient fields. Touch =
per-part contact flags from Rapier contact events.

## D15 — Time step & speed
Fixed sim tick `DT = 1/60 s`. Speeds: pause, 1x (1 tick/frame), 10x (10
ticks/frame budget-capped), max (D9). Season length and day length are sim
constants; climate drifts with a slow sine + random walk, changing plant
growth rates and ambient temperature (thermoregulation cost).

## D16 — Module responsibility boundaries (for parallel implementation)
`src/shared/*` is the frozen contract; implementation agents may not edit it
— they report needed changes instead, and integration applies them centrally.
Pure modules (terrain, genome ops, development, NEAT, ecology math, species)
import only from `shared` and are unit-tested headlessly in vitest.

## D17 — Body plan ↔ brain IO stability
Brain inputs/outputs are laid out in a canonical order derived from the
developed body plan (parts in development order: joints→outputs,
sensors→inputs, then fixed internal senses). When a body mutation changes the
sensor/joint count, the brain genome is repaired by adding fresh IO nodes
(connected with small random weights) or dropping orphaned ones — recorded as
part of mutation, so development never produces a brain/body mismatch.

## D18 — Plant model
Plants are point entities on the soil grid with biomass (energy units).
Photosynthesis adds energy (sun influx) gated by local light (season/day),
soil nutrients (drawn into biomass at a fixed stoichiometry) and moisture.
Above a biomass threshold they spend energy to emit seeds with an energy
packet, dispersed by wind + noise; seeds germinate where cell occupancy and
moisture allow. Grazing removes biomass; a plant dies when biomass hits ~0,
returning residue to soil.

## D19 — Documentary camera
Event detectors in the worker score "interest" (hunt = sustained closing
pursuit between carnivore-leaning and prey; birth clusters; first-of-kind
events; migrations = species centroid displacement). The main thread keeps a
priority queue, tweens the camera to frame the actors, and shows a generated
caption. Manual input (orbit) always overrides; doc-cam resumes after idle.

## D20 — No ESLint; typecheck + grep bans + tests as gates
To keep the toolchain lean: `tsc --noEmit` (strict), vitest, and a CI grep
that bans `Math.random(` in sim/shared and `console.log` outside dev guards.

## D21 — three.js version pinned
Pinned exact minor (`three@0.169.x`, `@types/three@0.169.x`) to keep
examples-jsm import paths stable with the types package.

## D22 — Smell/carrion fields double as event hints
The same gradient fields creatures smell are cheap to maintain and reused by
the documentary system (carrion spikes ⇒ possible kill site) — one source of
truth, no duplicated bookkeeping.
