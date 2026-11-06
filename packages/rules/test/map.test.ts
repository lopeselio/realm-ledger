import { describe, expect, it } from 'vitest';
import { distancesFrom, generateMap, hash32, newCampaign, rng, stateHash } from '../src/index.ts';

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = rng('x', 1);
    const b = rng('x', 1);
    const c = rng('x', 2);
    const sa = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 20 }, () => c.next())).not.toEqual(sa);
  });

  it('keeps range() inside its bounds', () => {
    const r = rng('bounds');
    for (let i = 0; i < 5000; i++) {
      const v = r.range(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it('has a fixed hash for a known input (cross-platform anchor)', () => {
    // If this changes, every committed campaign seed changes meaning.
    expect(hash32('realm-ledger', 7)).toBe(3786648187);
    expect(hash32('a')).not.toBe(hash32('b'));
  });
});

describe('generateMap', () => {
  const seeds = Array.from({ length: 25 }, (_, i) => `map-${i}`);

  it('is deterministic', () => {
    expect(generateMap('same')).toEqual(generateMap('same'));
  });

  it.each(seeds)('%s: has 60-120 provinces, all connected, symmetric neighbours', (seed) => {
    const m = generateMap(seed);
    expect(m.provinces.length).toBeGreaterThanOrEqual(60);
    expect(m.provinces.length).toBeLessThanOrEqual(120);
    const d = distancesFrom(m, 0);
    expect(d.every((x) => Number.isFinite(x))).toBe(true);
    for (const p of m.provinces) {
      for (const n of p.neighbors) expect(m.provinces[n]!.neighbors).toContain(p.id);
      expect(['plains', 'forest', 'hills', 'pass']).toContain(p.terrain);
    }
    for (const t of m.tiles) {
      if (t.kind === 'sea' || t.kind === 'mountains') expect(t.province).toBe(-1);
      else expect(m.provinces[t.province]!.terrain).toBe(t.kind);
    }
  });
});

describe('newCampaign', () => {
  it('is deterministic', () => {
    expect(stateHash(newCampaign({ seed: 's' }))).toBe(stateHash(newCampaign({ seed: 's' })));
  });

  it('gives every realm a distinct capital with a fort, town and army', () => {
    for (const n of [2, 4, 6]) {
      const s = newCampaign({ seed: `setup-${n}`, realms: n, human: 0 });
      const caps = s.realms.map((r) => r.capital);
      expect(new Set(caps).size).toBe(n);
      for (const r of s.realms) {
        expect(s.owner[r.capital]).toBe(r.id);
        expect(s.towns[r.capital]).toBe(true);
        expect(s.forts[r.capital]).toBe(1);
        expect(s.armies.some((a) => a.realm === r.id && a.province === r.capital)).toBe(true);
      }
      expect(s.realms[0]!.human).toBe(true);
    }
  });
});
