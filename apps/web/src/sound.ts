// The war table's sounds, synthesised with Web Audio: no sound files, nothing to license.
// Off until the player has touched the page (browsers block audio before that), and mutable.

const PREF = 'realm-ledger:sound';

let ctx: AudioContext | null = null;
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
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export const isMuted = (): boolean => muted;

export function setMuted(m: boolean): void {
  muted = m;
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

/** The context to play on now, or null when muted, locked or unavailable. */
function live(): AudioContext | null {
  if (muted || !ctx || ctx.state !== 'running') return null;
  return ctx;
}

function envelope(c: AudioContext, at: number, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  g.connect(c.destination);
  return g;
}

function noise(c: AudioContext, seconds: number): AudioBufferSourceNode {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
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
  const c = live();
  if (!c) return;
  tone(c, c.currentTime, 140, 'sine', 0.35, 0.25, 60);
}

/** Marching: a few muffled drum beats. */
export function marchSound(delay = 0): void {
  const c = live();
  if (!c) return;
  for (let i = 0; i < 4; i++) {
    const at = c.currentTime + delay + i * 0.2;
    tone(c, at, 95, 'triangle', 0.22, 0.12, 55);
  }
}

/** A clash of arms: a burst of filtered noise over a thump. */
export function clashSound(delay = 0): void {
  const c = live();
  if (!c) return;
  const at = c.currentTime + delay;
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
  const c = live();
  if (!c) return;
  const at = c.currentTime + delay;
  tone(c, at, 660, 'sine', 0.18, 0.9);
  tone(c, at + 0.12, 990, 'sine', 0.12, 0.9);
}
