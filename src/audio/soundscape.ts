/**
 * Procedural WebAudio soundscape for Genesis. No audio files: wind and water
 * are filtered looping noise buffers, night is a soft drone plus synthesized
 * cricket blips, day has sparse two-glide "bird" chirps, and sim events play
 * short oscillator motifs. Everything routes through one master GainNode and
 * a gentle lowpass. Chirp/motif scheduling is driven from `update(dt)` with
 * countdown accumulators — no setTimeout/setInterval, so muting can never
 * leave runaway timers behind.
 */
import type { SimEventKind } from '../shared/types';

/** Target master level when audible (kept low; this is ambience). */
const MASTER_LEVEL = 0.25;
/** Gentle master lowpass cutoff (Hz) — rounds off synthesized edges. */
const MASTER_LOWPASS_HZ = 6500;
/** Minimum spacing between event motifs (seconds). */
const EVENT_MIN_INTERVAL = 1.5;
/** Smoothing time constant for ambience gain/cutoff ramps (seconds). */
const RAMP_TC = 0.3;

/** All persistent nodes created by start(), grouped so fields stay non-null together. */
interface Graph {
  ctx: AudioContext;
  master: GainNode;
  masterFilter: BiquadFilterNode;
  // wind: noise -> lowpass -> gain -> master, with slow LFO wobble on both
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  windFreqDepth: GainNode;
  windGainDepth: GainNode;
  // water: noise -> bandpass -> gain (amplitude ripple LFO) -> master
  waterGain: GainNode;
  waterRippleDepth: GainNode;
  // night: two detuned low oscillators -> lowpass -> gain -> master
  droneGain: GainNode;
}

/**
 * Procedural ambient soundscape + event motifs.
 *
 * Usage: construct once, call {@link start} from a user gesture (click/key),
 * then call {@link update} every rendered frame with the current ambience
 * parameters and {@link event} when notable sim events arrive. {@link toggle}
 * mutes/unmutes the master bus.
 */
export class Soundscape {
  private graph: Graph | null = null;
  private startedFlag = false;
  private audible = true;
  /** AudioContext time of the last motif actually played (rate limiting). */
  private lastEventAt = -Infinity;
  /** Countdown (sim/wall seconds) until the next cricket blip window. */
  private cricketTimer = 2;
  /** Countdown until the next bird chirp window. */
  private birdTimer = 8;
  /** Tiny LCG state (deterministic, keeps Math.random out of the module). */
  private rngState = 0x9e3779b9;

  /** True once start() has successfully created the AudioContext. */
  get started(): boolean {
    return this.startedFlag;
  }

  /**
   * Create the AudioContext and the persistent node graph. Must be called
   * from a user gesture (browsers block audio otherwise). Idempotent: calling
   * again only resumes a suspended context.
   */
  start(): void {
    if (this.startedFlag) {
      const g = this.graph;
      if (g && g.ctx.state === 'suspended') void g.ctx.resume();
      return;
    }
    const Ctor =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      console.warn('Soundscape: WebAudio is not available in this browser');
      return;
    }
    const ctx = new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();

    // ---- master bus: everything -> master gain -> gentle lowpass -> out ----
    const master = ctx.createGain();
    master.gain.value = this.audible ? MASTER_LEVEL : 0;
    const masterFilter = ctx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = MASTER_LOWPASS_HZ;
    masterFilter.Q.value = 0.4;
    master.connect(masterFilter);
    masterFilter.connect(ctx.destination);

    const noise = this.makeNoiseBuffer(ctx, 2.0);

    // ---- wind: looping white noise through a lowpass; cutoff + gain follow
    // p.wind with a slow LFO wobble added on both params ----
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noise;
    windSrc.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 320;
    windFilter.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);

    const windLfo = ctx.createOscillator();
    windLfo.type = 'sine';
    windLfo.frequency.value = 0.07; // slow wobble
    const windFreqDepth = ctx.createGain();
    windFreqDepth.gain.value = 0;
    const windGainDepth = ctx.createGain();
    windGainDepth.gain.value = 0;
    windLfo.connect(windFreqDepth);
    windFreqDepth.connect(windFilter.frequency);
    windLfo.connect(windGainDepth);
    windGainDepth.connect(windGain.gain);

    // ---- water: quieter band-passed noise with an amplitude ripple ----
    const waterSrc = ctx.createBufferSource();
    waterSrc.buffer = noise;
    waterSrc.loop = true;
    waterSrc.playbackRate.value = 0.82; // decorrelate from the wind loop
    const waterFilter = ctx.createBiquadFilter();
    waterFilter.type = 'bandpass';
    waterFilter.frequency.value = 760;
    waterFilter.Q.value = 0.8;
    const waterGain = ctx.createGain();
    waterGain.gain.value = 0;
    waterSrc.connect(waterFilter);
    waterFilter.connect(waterGain);
    waterGain.connect(master);

    const waterLfo = ctx.createOscillator();
    waterLfo.type = 'sine';
    waterLfo.frequency.value = 0.55; // lapping ripple
    const waterRippleDepth = ctx.createGain();
    waterRippleDepth.gain.value = 0;
    waterLfo.connect(waterRippleDepth);
    waterRippleDepth.connect(waterGain.gain);

    // ---- night: very soft low drone (two detuned lows into a lowpass) ----
    const droneA = ctx.createOscillator();
    droneA.type = 'sine';
    droneA.frequency.value = 55;
    const droneB = ctx.createOscillator();
    droneB.type = 'triangle';
    droneB.frequency.value = 55 * 1.012; // slight beat
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 240;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    droneA.connect(droneFilter);
    droneB.connect(droneFilter);
    droneFilter.connect(droneGain);
    droneGain.connect(master);

    const t = ctx.currentTime;
    windSrc.start(t);
    waterSrc.start(t);
    windLfo.start(t);
    waterLfo.start(t);
    droneA.start(t);
    droneB.start(t);

    this.graph = {
      ctx,
      master,
      masterFilter,
      windFilter,
      windGain,
      windFreqDepth,
      windGainDepth,
      waterGain,
      waterRippleDepth,
      droneGain,
    };
    this.startedFlag = true;
  }

  /**
   * Smooth-ramp the ambience to the given parameters and advance the chirp
   * schedulers. Call once per rendered frame. Safe no-op before start().
   * @param dt seconds since the previous call (clamped internally)
   * @param p wind 0..1, nearWater 0..1 (proximity/loudness), dayness 0..1
   */
  update(dt: number, p: { wind: number; nearWater: number; dayness: number }): void {
    const g = this.graph;
    if (!g) return;
    const step = Math.min(Math.max(dt, 0), 0.25);
    const now = g.ctx.currentTime;
    const wind = clamp01(p.wind);
    const water = clamp01(p.nearWater);
    const dayness = clamp01(p.dayness);

    // Wind: cutoff 320..1700 Hz and gain 0..~0.55 follow wind; the LFO depths
    // scale with wind so calm air barely wobbles.
    g.windFilter.frequency.setTargetAtTime(320 + wind * 1380, now, RAMP_TC);
    g.windGain.gain.setTargetAtTime(0.06 + wind * 0.5, now, RAMP_TC);
    g.windFreqDepth.gain.setTargetAtTime(wind * 260, now, RAMP_TC);
    g.windGainDepth.gain.setTargetAtTime((0.06 + wind * 0.5) * 0.3, now, RAMP_TC);

    // Water: quieter than wind; ripple depth tracks the base gain.
    const waterBase = water * 0.3;
    g.waterGain.gain.setTargetAtTime(waterBase, now, RAMP_TC);
    g.waterRippleDepth.gain.setTargetAtTime(waterBase * 0.45, now, RAMP_TC);

    // Night drone fades in below dayness 0.3.
    const nightness = clamp01((0.3 - dayness) / 0.3);
    g.droneGain.gain.setTargetAtTime(nightness * 0.055, now, RAMP_TC);

    // ---- dt-driven chirp scheduling (no timers; muted => no node churn) ----
    this.cricketTimer -= step;
    this.birdTimer -= step;
    if (this.cricketTimer <= 0) {
      this.cricketTimer = 0.9 + this.rand() * 3.5;
      if (this.audible && dayness < 0.3) this.playCricket();
    }
    if (this.birdTimer <= 0) {
      this.birdTimer = 6 + this.rand() * 14; // sparse: every 6-20 s
      if (this.audible && dayness > 0.45) this.playBird();
    }
  }

  /**
   * Play a short synthesized motif for a sim event. Only notable kinds sound
   * (speciesBorn, kill/firstPredation, massExtinction, seasonChange); motifs
   * are rate-limited to at most one per 1.5 s.
   */
  event(kind: SimEventKind): void {
    const g = this.graph;
    if (!g || !this.audible) return;
    let motif: (() => void) | null = null;
    switch (kind) {
      case 'speciesBorn':
        motif = () => this.motifRise();
        break;
      case 'kill':
      case 'firstPredation':
        motif = () => this.motifThud();
        break;
      case 'massExtinction':
        motif = () => this.motifDarkSwell();
        break;
      case 'seasonChange':
        motif = () => this.motifChime();
        break;
      default:
        return; // silent kinds don't consume the rate limit
    }
    const now = g.ctx.currentTime;
    if (now - this.lastEventAt < EVENT_MIN_INTERVAL) return;
    this.lastEventAt = now;
    motif();
  }

  /** Mute/unmute the master bus. Returns the new audible state. */
  toggle(): boolean {
    this.audible = !this.audible;
    const g = this.graph;
    if (g) {
      if (this.audible && g.ctx.state === 'suspended') void g.ctx.resume();
      g.master.gain.setTargetAtTime(this.audible ? MASTER_LEVEL : 0, g.ctx.currentTime, 0.05);
    }
    return this.audible;
  }

  // ========================== synthesis helpers ===========================

  /** Deterministic 0..1 LCG (Numerical Recipes constants). */
  private rand(): number {
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
    return this.rngState / 4294967296;
  }

  /** Mono white-noise loop buffer filled from the internal LCG. */
  private makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = this.rand() * 2 - 1;
    return buf;
  }

  /**
   * One enveloped oscillator note into the master bus.
   * @param type waveform
   * @param f0 start frequency (Hz), @param f1 end frequency (glide target)
   * @param at start time (ctx time), @param dur seconds
   * @param peak envelope peak gain, @param filterHz optional lowpass cutoff
   */
  private note(
    type: OscillatorType,
    f0: number,
    f1: number,
    at: number,
    dur: number,
    peak: number,
    filterHz?: number,
  ): void {
    const g = this.graph;
    if (!g) return;
    const osc = g.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) osc.frequency.linearRampToValueAtTime(f1, at + dur);
    const env = g.ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + Math.min(0.02, dur * 0.25));
    env.gain.linearRampToValueAtTime(0, at + dur);
    if (filterHz !== undefined) {
      const f = g.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filterHz;
      osc.connect(f);
      f.connect(env);
    } else {
      osc.connect(env);
    }
    env.connect(g.master);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /** Occasional procedural cricket: a burst of short filtered square blips. */
  private playCricket(): void {
    const g = this.graph;
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.01;
    const f = 3800 + this.rand() * 900;
    const blips = 3 + Math.floor(this.rand() * 3);
    for (let i = 0; i < blips; i++) {
      this.note('square', f, f, t0 + i * 0.065, 0.03, 0.022, 5200);
    }
  }

  /** Soft bird-ish chirp: two quick sine glides. */
  private playBird(): void {
    const g = this.graph;
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.01;
    const base = 1600 + this.rand() * 700;
    this.note('sine', base, base * 1.5, t0, 0.12, 0.05);
    this.note('sine', base * 1.35, base * 0.85, t0 + 0.16, 0.14, 0.045);
  }

  /** speciesBorn: gentle rising 3-note motif. */
  private motifRise(): void {
    const g = this.graph;
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.01;
    this.note('triangle', 440, 440, t0, 0.22, 0.09, 3200);
    this.note('triangle', 554.4, 554.4, t0 + 0.18, 0.22, 0.09, 3200);
    this.note('triangle', 659.3, 659.3, t0 + 0.36, 0.3, 0.1, 3200);
  }

  /** kill / firstPredation: a low pitch-dropping thud. */
  private motifThud(): void {
    const g = this.graph;
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.01;
    this.note('sine', 95, 38, t0, 0.3, 0.22);
    this.note('triangle', 150, 60, t0, 0.12, 0.08, 400);
  }

  /** massExtinction: a slow dark low swell. */
  private motifDarkSwell(): void {
    const g = this.graph;
    if (!g) return;
    const ctx = g.ctx;
    const t0 = ctx.currentTime + 0.01;
    const dur = 2.8;
    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = 52;
    const oscB = ctx.createOscillator();
    oscB.type = 'sawtooth';
    oscB.frequency.value = 52 * 1.02;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(120, t0);
    f.frequency.linearRampToValueAtTime(420, t0 + dur * 0.45);
    f.frequency.linearRampToValueAtTime(90, t0 + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.16, t0 + dur * 0.45);
    env.gain.linearRampToValueAtTime(0, t0 + dur);
    oscA.connect(f);
    oscB.connect(f);
    f.connect(env);
    env.connect(g.master);
    oscA.start(t0);
    oscB.start(t0);
    oscA.stop(t0 + dur + 0.05);
    oscB.stop(t0 + dur + 0.05);
  }

  /** seasonChange: a soft two-partial chime. */
  private motifChime(): void {
    const g = this.graph;
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.01;
    this.note('sine', 1318.5, 1318.5, t0, 1.1, 0.055);
    this.note('sine', 1979, 1979, t0 + 0.02, 0.9, 0.028);
  }
}

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
