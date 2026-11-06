import { hash32 } from './rng.ts';

// Value noise on an integer lattice. Only + - * / and floor, so results are
// identical across JS engines.

const lattice = (seed: string, x: number, y: number): number => hash32(seed, x, y) / 4294967295;

const smooth = (t: number): number => t * t * (3 - 2 * t);

export function valueNoise(seed: string, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = lattice(seed, x0, y0);
  const b = lattice(seed, x0 + 1, y0);
  const c = lattice(seed, x0, y0 + 1);
  const d = lattice(seed, x0 + 1, y0 + 1);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/** Fractal value noise in [0, 1]. */
export function fbm(seed: string, x: number, y: number, octaves = 4, scale = 0.18): number {
  let amp = 1;
  let freq = scale;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(`${seed}:${o}`, x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
