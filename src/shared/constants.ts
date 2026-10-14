/**
 * All simulation tunables in one place. Units:
 *  - length: meters, time: seconds (sim time), mass: kg
 *  - energy: joule-like abstract units "E" (consistent across the ledger)
 */

// ---------- time ----------
export const DT = 1 / 60; // fixed physics/sim tick
export const DAY_LENGTH = 120; // sim-seconds per day
export const YEAR_LENGTH = DAY_LENGTH * 16; // 16 days per year (4 per season)

// ---------- terrain ----------
export const TERRAIN_SIZE = 240; // world is TERRAIN_SIZE x TERRAIN_SIZE meters
export const TERRAIN_RES = 128; // heightfield resolution (cells per side + 1 vertices)
export const TERRAIN_HEIGHT = 26; // max elevation above base
export const WATER_LEVEL_FRAC = 0.3; // fraction of height range that is water
export const EROSION_DROPLETS = 30000;

// ---------- population ----------
export const MAX_CREATURES = 140;
export const MIN_POPULATION = 18; // below this, respawn mutated founders (rescue)
export const INITIAL_POPULATION = 48;
export const MAX_PLANTS = 2600;

// ---------- body plan ----------
export const MAX_PARTS = 12;
export const MAX_BODY_GENES = 8;
export const MAX_RECURSION = 3;
export const MAX_EYES_PER_PART = 3;
export const MAX_EYE_RAYS = 6; // whole-body cap
export const MIN_PART_DIM = 0.09;
export const MAX_PART_DIM = 0.75;
export const EYE_RANGE = 26; // meters
export const EYE_FOV_SPREAD = 0.45; // radians between fanned rays
export const TISSUE_DENSITY = 420; // kg/m^3 baseline; gene multiplies 0.6..1.6

// ---------- energy / metabolism ----------
export const TISSUE_ENERGY_DENSITY = 9; // E per kg of body mass (build/corpse value)
export const KLEIBER_COEFF = 0.011; // E/s per kg^0.75 basal
export const NEURON_COST = 0.00022; // E/s per brain node
export const SYNAPSE_COST = 0.00006; // E/s per enabled connection
export const MUSCLE_WORK_COST = 0.055; // E per (N*m * rad) of commanded work
export const MUSCLE_ACTIVATION_COST = 0.004; // E/s per (activation * maxTorque/100)
export const MUSCLE_TORQUE_PER_VOLUME = 2400; // N*m per m^3 of part volume at muscle=1
export const STORE_PER_MASS = 7.5; // energy store capacity: E per kg
export const EAT_RATE = 10; // E/s transferable while biting
export const BITE_RANGE = 0.55; // m from mouth part tip
export const DIGEST_LOSS = 0.25; // fraction of ingested energy lost as heat at best
export const THERMO_COST_COEFF = 0.004; // extra E/s per kg^0.75 per unit cold stress

// diet: efficiency of digesting plant vs meat given gutHerbivory g in [0,1]
// plantEff = (0.3 + 0.7*g) * (1-DIGEST_LOSS);  meatEff = (0.3 + 0.7*(1-g)) * (1-DIGEST_LOSS)
export const DIET_BASE_EFF = 0.3;

// combat: biting a creature does damage and converts victim biomass to wound
export const BITE_DAMAGE = 11; // health damage per second of biting
export const CREATURE_MAX_HEALTH = 100;
export const HEALTH_REGEN = 0.6; // health/s when energy above half
export const HEALTH_REGEN_COST = 0.06; // E per health point

// ---------- reproduction ----------
export const REPRO_ENERGY_FRAC = 0.75; // store fraction (of capacity) needed to reproduce
export const REPRO_COOLDOWN = 18; // seconds
export const MATE_RANGE = 6; // m for sexual reproduction
export const GESTATION_OVERHEAD = 0.12; // fraction of endowment lost as heat
export const MATURITY_AGE = 14; // seconds before able to reproduce

// ---------- mutation rates ----------
export const MUT_WEIGHT_P = 0.8; // per-genome chance to jitter weights
export const MUT_WEIGHT_SD = 0.35;
export const MUT_ADD_CONN_P = 0.22;
export const MUT_ADD_NODE_P = 0.09;
export const MUT_TOGGLE_CONN_P = 0.05;
export const MUT_BODY_POINT_P = 0.5; // chance of one body-gene point mutation
export const MUT_BODY_DUP_P = 0.08; // gene duplication
export const MUT_BODY_DEL_P = 0.05; // gene deletion
export const MUT_ORGANISM_P = 0.45; // organism-gene jitter
export const MUT_ORGANISM_SD = 0.08;

// ---------- species ----------
export const SPECIES_THRESHOLD = 2.6; // compatibility distance for same species
export const COMPAT_C_EXCESS = 1.0;
export const COMPAT_C_DISJOINT = 1.0;
export const COMPAT_C_WEIGHT = 0.5;
export const COMPAT_C_BODY = 1.6;

// ---------- plants ----------
export const PLANT_MAX_BIOMASS = 16; // E
export const PLANT_GROWTH_RATE = 0.42; // E/s at full light, nutrients, moisture
export const PLANT_NUTRIENT_STOICH = 0.35; // soil E consumed per E of growth
export const PLANT_SEED_COST = 2.4; // E per seed (packet carried by seed)
export const PLANT_SEED_THRESHOLD = 0.72; // biomass fraction to start seeding
export const PLANT_SEED_INTERVAL = 22; // seconds between seeding attempts
export const SEED_DISPERSAL = 14; // meters (scaled by wind)
export const GERMINATION_MOISTURE = 0.18;
export const SOIL_GRID_RES = 64;
export const SOIL_INITIAL_NUTRIENTS = 11000; // total E spread over fertile cells
export const DECOMPOSE_RATE = 0.06; // fraction of corpse biomass per second
export const DECOMPOSE_LOSS = 0.2; // fraction of decomposed energy lost as heat
export const CARRION_SMELL_GAIN = 1.0;

// ---------- climate ----------
export const SEASON_LIGHT_AMPLITUDE = 0.38; // +- growth light over the year
export const CLIMATE_DRIFT_PERIOD = YEAR_LENGTH * 9; // slow climate sine
export const CLIMATE_DRIFT_AMPLITUDE = 0.25;
export const COLD_SEASON_STRESS = 1.0; // thermoregulation stress at winter peak

// ---------- snapshots ----------
export const SNAPSHOT_HZ = 60;
export const STATS_INTERVAL_TICKS = 30; // stats every 0.5 s
export const INSPECT_INTERVAL_TICKS = 6; // selected-creature detail at 10 Hz
export const PLANTS_SNAPSHOT_INTERVAL = 12; // plant instance refresh every 12 ticks
export const HISTORY_SAMPLE_TICKS = 180; // population history point every 3 s

// ---------- physics ----------
export const GRAVITY = -9.81;
export const GROUND_FRICTION = 1.0;
export const JOINT_MAX_SPEED = 5.5; // rad/s motor target cap
export const JOINT_STIFFNESS_FACTOR = 18; // motor position servo stiffness scale

// ---------- documentary camera ----------
export const HUNT_TRACK_SECONDS = 2.5; // sustained pursuit before "hunt" event
export const MIGRATION_DISTANCE = 30; // species centroid displacement (m / 30 s)

export const PROTOCOL_VERSION = 1;
