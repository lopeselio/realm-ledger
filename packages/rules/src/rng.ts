// Seeded, platform-independent randomness. Only integer ops and Math.imul, so the
// same seed gives the same numbers in every JS engine (server, browser, verifier).

/** 32-bit hash of any mix of strings and numbers. Not cryptographic. */
export function hash32(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join('\u001f');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // murmur3 finaliser for avalanche
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface Rng {
  /** uint32 */
  next(): number;
  /** integer in [0, n) */
  int(n: number): number;
  /** integer in [lo, hi] inclusive */
  range(lo: number, hi: number): number;
  /** float in [0, 1) */
  float(): number;
  pick<T>(xs: readonly T[]): T;
  shuffle<T>(xs: T[]): T[];
}

/** sfc32 seeded from hash32 of the given parts. */
export function rng(...seed: (string | number)[]): Rng {
  let a = hash32(...seed, 'a');
  let b = hash32(...seed, 'b');
  let c = hash32(...seed, 'c');
  let d = 1;
  const next = (): number => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return r >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  const int = (n: number): number => {
    if (n <= 0) throw new Error(`rng.int(${n})`);
    return next() % n;
  };
  return {
    next,
    int,
    range: (lo, hi) => lo + int(hi - lo + 1),
    float: () => next() / 4294967296,
    pick: (xs) => {
      if (xs.length === 0) throw new Error('rng.pick on empty list');
      return xs[int(xs.length)]!;
    },
    shuffle: (xs) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [xs[i], xs[j]] = [xs[j]!, xs[i]!];
      }
      return xs;
    },
  };
}
