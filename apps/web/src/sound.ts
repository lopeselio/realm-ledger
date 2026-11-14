// The war table's sounds, synthesised with Web Audio: no sound files, nothing to license.
// Off until the player has touched the page (browsers block audio before that), and mutable.

const PREF = 'realm-ledger:sound';

let ctx: AudioContext | null = null;
// everything plays through this, so muting silences sounds already scheduled too
let master: GainNode | null = null;
let muted = readMuted();
const listeners = new Set<(muted: boolean) => void>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(PREF) === 'off';
  } catch {
    return false;
  }
}

/** Creates or wakes the audio context; call from a click or tap. */
export function unlockSound(): void {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export const isMuted = (): boolean => muted;

export function setMuted(m: boolean): void {
  muted = m;
  if (ctx && master) master.gain.setValueAtTime(m ? 0 : 1, ctx.currentTime);
  try {
    localStorage.setItem(PREF, m ? 'off' : 'on');
  } catch {
    // remembered for this page only
  }
  for (const l of listeners) l(m);
}

export function onMutedChange(l: (muted: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * Plays on the audio context once it runs: a context just unlocked may still be waking (Safari,
 * or a first tap outside the board), and a sound sent before then would be lost. Nothing plays
 * when muted, never unlocked, or closed.
 */
function live(play: (c: AudioContext) => void): void {
  const c = ctx;
  if (muted || !c || c.state === 'closed') return;
  if (c.state === 'running') return play(c);
  // wait a moment for it to wake, no longer: a sound that would land long after its moment
  // (the next tap minutes later) is dropped
  const asked = performance.now();
  c.resume()
    .then(() => {
      if (!muted && performance.now() - asked < 300) play(c);
    })
    .catch(() => undefined);
}

function envelope(c: AudioContext, at: number, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  g.connect(master ?? c.destination);
  return g;
}

// one buffer of white noise, made once and replayed for every clash
let noiseBuf: AudioBuffer | null = null;
function noise(c: AudioContext, seconds: number): AudioBufferSourceNode {
  if (!noiseBuf || noiseBuf.sampleRate !== c.sampleRate) {
    noiseBuf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

function tone(c: AudioContext, at: number, freq: number, type: OscillatorType, peak: number, decay: number, glideTo?: number): void {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + decay);
  o.connect(envelope(c, at, peak, 0.005, decay));
  o.start(at);
  o.stop(at + decay + 0.05);
}

/** A wax seal pressed: a soft low thud. */
export function sealSound(): void {
  live((c) => tone(c, c.currentTime, 140, 'sine', 0.35, 0.25, 60));
}

/** Marching: a few muffled drum beats. */
export function marchSound(delay = 0): void {
  live((c) => {
    for (let i = 0; i < 4; i++) tone(c, c.currentTime + delay + i * 0.2, 95, 'triangle', 0.22, 0.12, 55);
  });
}

/** A clash of arms: a burst of filtered noise over a thump. */
export function clashSound(delay = 0): void {
  live((c) => clash(c, c.currentTime + delay));
}

function clash(c: AudioContext, at: number): void {
  const n = noise(c, 0.35);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2400;
  band.Q.value = 0.8;
  n.connect(band).connect(envelope(c, at, 0.3, 0.004, 0.3));
  n.start(at);
  tone(c, at, 70, 'sine', 0.4, 0.3, 40);
  tone(c, at + 0.06, 1800, 'square', 0.04, 0.08);
}

/** A province changes hands: two bright bell notes. */
export function captureSound(delay = 0): void {
  live((c) => {
    const at = c.currentTime + delay;
    tone(c, at, 660, 'sine', 0.18, 0.9);
    tone(c, at + 0.12, 990, 'sine', 0.12, 0.9);
  });
}

// ---- feedback cues: short, quiet, synthesised like the rest ----

/** Filtered noise: a rustle, a scratch, a crack. */
function hiss(c: AudioContext, at: number, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number, sweepTo?: number): void {
  const n = noise(c, 0.35);
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, at);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + decay);
  f.Q.value = q;
  n.connect(f).connect(envelope(c, at, peak, 0.01, decay));
  n.start(at);
  n.stop(at + decay + 0.05);
}

/** A build ordered: two hammer knocks on wood. */
export function hammerSound(): void {
  live((c) => {
    for (let i = 0; i < 2; i++) {
      const at = c.currentTime + i * 0.14;
      tone(c, at, 220, 'square', 0.06, 0.05, 120);
      hiss(c, at, 'bandpass', 1800, 2, 0.12, 0.05);
    }
  });
}

/** Troops ordered: a short double drum beat. */
export function drumSound(): void {
  live((c) => {
    tone(c, c.currentTime, 110, 'triangle', 0.28, 0.14, 55);
    tone(c, c.currentTime + 0.13, 110, 'triangle', 0.2, 0.14, 55);
  });
}

/** A trade ordered: a quill scratching across paper. */
export function quillSound(): void {
  live((c) => {
    hiss(c, c.currentTime, 'highpass', 3500, 1, 0.07, 0.12, 6000);
    hiss(c, c.currentTime + 0.14, 'highpass', 4200, 1, 0.05, 0.1, 7000);
  });
}

/** An envoy rides out: a sheet of parchment folded. */
export function parchmentSound(): void {
  live((c) => {
    hiss(c, c.currentTime, 'bandpass', 900, 0.7, 0.14, 0.18, 2400);
    hiss(c, c.currentTime + 0.12, 'bandpass', 1400, 0.7, 0.1, 0.22, 600);
  });
}

/** A letter opened: the wax seal cracks. */
export function sealCrackSound(delay = 0): void {
  live((c) => {
    const at = c.currentTime + delay;
    hiss(c, at, 'highpass', 2500, 0.8, 0.22, 0.06);
    tone(c, at, 320, 'square', 0.05, 0.04, 180);
  });
}

/** Good news: a rising three-note chime. */
export function chimeSound(delay = 0): void {
  live((c) => {
    const at = c.currentTime + delay;
    [784, 988, 1319].forEach((f, i) => tone(c, at + i * 0.09, f, 'sine', 0.12, 0.7));
  });
}

/** Bad news: a low horn. */
export function hornSound(delay = 0): void {
  live((c) => {
    const at = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(98, at);
    o.frequency.linearRampToValueAtTime(87, at + 0.9);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 480;
    o.connect(lp).connect(envelope(c, at, 0.16, 0.12, 0.9));
    o.start(at);
    o.stop(at + 1.1);
  });
}

/** Coins: a few bright clinks. */
export function coinSound(delay = 0, count = 3): void {
  live((c) => {
    const at = c.currentTime + delay;
    for (let i = 0; i < count; i++) {
      tone(c, at + i * 0.07, 2100 + (i % 2) * 520, 'triangle', 0.06, 0.12);
      tone(c, at + i * 0.07, 3300 + (i % 2) * 400, 'sine', 0.03, 0.08);
    }
  });
}

/** A stamp thumped on a receipt. */
export function stampSound(delay = 0): void {
  live((c) => {
    const at = c.currentTime + delay;
    tone(c, at, 160, 'sine', 0.3, 0.12, 70);
    hiss(c, at, 'lowpass', 900, 0.7, 0.16, 0.08);
  });
}

/** Stone raised: a low grinding rumble. */
export function stoneSound(delay = 0): void {
  live((c) => {
    const at = c.currentTime + delay;
    hiss(c, at, 'lowpass', 260, 1.2, 0.3, 0.45, 140);
    tone(c, at + 0.3, 82, 'sine', 0.2, 0.25, 55);
  });
}

/** Something grows: a quick high sparkle. */
export function sparkleSound(delay = 0): void {
  live((c) => {
    const at = c.currentTime + delay;
    [1568, 2093, 2637, 3136].forEach((f, i) => tone(c, at + i * 0.05, f, 'sine', 0.05, 0.35));
  });
}

/** A win: a short brass fanfare (`big` for the campaign's end). */
export function fanfareSound(delay = 0, big = false): void {
  live((c) => {
    const notes = big ? [392, 523, 659, 784, 659, 784] : [523, 659, 784];
    const lens = big ? [0.14, 0.14, 0.14, 0.4, 0.14, 0.8] : [0.12, 0.12, 0.5];
    let t = c.currentTime + delay;
    notes.forEach((f, i) => {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      o.connect(lp).connect(envelope(c, t, 0.1, 0.02, lens[i]!));
      o.start(t);
      o.stop(t + lens[i]! + 0.05);
      t += lens[i]! * 0.9;
    });
  });
}

/** A defeat: a slow falling minor line. */
export function somberSound(delay = 0): void {
  live((c) => {
    const at = c.currentTime + delay;
    [392, 349, 311, 262].forEach((f, i) => tone(c, at + i * 0.45, f, 'triangle', 0.14, 0.9));
  });
}
