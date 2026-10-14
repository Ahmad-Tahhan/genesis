/**
 * Genome-level composition: ties body genes, organism genes and the NEAT
 * brain together, keeping brain IO consistent with the developed body
 * (DECISIONS.md D17).
 */
import type { BodyPlan, Genome } from '../../shared/types';
import { COMPAT_C_BODY } from '../../shared/constants';
import { RNG } from '../../shared/rng';
import {
  bodyDistance,
  crossoverBody,
  mutateBody,
  mutateOrganism,
  randomBodyGenes,
  randomOrganism,
} from './body';
import {
  InnovationTracker,
  brainDistance,
  createBrain,
  crossoverBrain,
  mutateBrain,
  repairBrainIO,
} from './brain';
import { develop } from './development';

export interface Born {
  genome: Genome;
  plan: BodyPlan;
}

/** Create a random viable founder genome (retries until development succeeds). */
export function randomGenome(rng: RNG, tracker: InnovationTracker, nextGeneId: () => number): Born {
  for (let attempt = 0; attempt < 50; attempt++) {
    const body = randomBodyGenes(rng, nextGeneId);
    const organism = randomOrganism(rng);
    const plan = develop(body, organism);
    if (!plan.viable) continue;
    const brain = createBrain(plan.numInputs, plan.numOutputs, rng, tracker);
    return { genome: { body, organism, brain, generation: 0 }, plan };
  }
  // Last-resort: accept a non-viable plan; the world culls it immediately.
  const body = randomBodyGenes(rng, nextGeneId);
  const organism = randomOrganism(rng);
  const plan = develop(body, organism);
  const brain = createBrain(Math.max(1, plan.numInputs), Math.max(1, plan.numOutputs), rng, tracker);
  return { genome: { body, organism, brain, generation: 0 }, plan };
}

/** Mutate a genome (asexual reproduction). Brain IO is repaired to the new plan. */
export function mutateGenome(g: Genome, rng: RNG, tracker: InnovationTracker, nextGeneId: () => number): Born {
  for (let attempt = 0; attempt < 12; attempt++) {
    const body = mutateBody(g.body, rng, nextGeneId);
    const organism = mutateOrganism(g.organism, rng);
    const plan = develop(body, organism);
    if (!plan.viable) continue;
    let brain = mutateBrain(g.brain, rng, tracker);
    brain = repairBrainIO(brain, plan.numInputs, plan.numOutputs, rng, tracker);
    return { genome: { body, organism, brain, generation: g.generation + 1 }, plan };
  }
  // Mutation kept breaking the body: inherit parent body unchanged, mutate brain only.
  const plan = develop(g.body, g.organism);
  let brain = mutateBrain(g.brain, rng, tracker);
  brain = repairBrainIO(brain, plan.numInputs, plan.numOutputs, rng, tracker);
  return {
    genome: { body: g.body.map((b) => ({ ...b })), organism: { ...g.organism }, brain, generation: g.generation + 1 },
    plan,
  };
}

/** Sexual reproduction: crossover both body and brain, then mutate. `a` is the fitter parent. */
export function crossoverGenomes(
  a: Genome,
  b: Genome,
  rng: RNG,
  tracker: InnovationTracker,
  nextGeneId: () => number,
): Born {
  for (let attempt = 0; attempt < 12; attempt++) {
    const body = mutateBody(crossoverBody(a.body, b.body, rng), rng, nextGeneId);
    const organism = mutateOrganism(mixOrganism(a, b, rng), rng);
    const plan = develop(body, organism);
    if (!plan.viable) continue;
    let brain = mutateBrain(crossoverBrain(a.brain, b.brain, rng), rng, tracker);
    brain = repairBrainIO(brain, plan.numInputs, plan.numOutputs, rng, tracker);
    return {
      genome: { body, organism, brain, generation: Math.max(a.generation, b.generation) + 1 },
      plan,
    };
  }
  return mutateGenome(a, rng, tracker, nextGeneId);
}

function mixOrganism(a: Genome, b: Genome, rng: RNG) {
  return {
    gutHerbivory: rng.chance(0.5) ? a.organism.gutHerbivory : b.organism.gutHerbivory,
    sexual: rng.chance(0.5) ? a.organism.sexual : b.organism.sexual,
    offspringEnergyFrac: rng.chance(0.5) ? a.organism.offspringEnergyFrac : b.organism.offspringEnergyFrac,
    sizeScale: rng.chance(0.5) ? a.organism.sizeScale : b.organism.sizeScale,
  };
}

/** Compatibility distance used for speciation: brain + weighted body distance. */
export function genomeDistance(a: Genome, b: Genome): number {
  const brainD = brainDistance(a.brain, b.brain);
  const bodyD = bodyDistance(a.body, b.body);
  const dietD = Math.abs(a.organism.gutHerbivory - b.organism.gutHerbivory);
  return brainD + COMPAT_C_BODY * bodyD + dietD * 0.8;
}
