import { describe, expect, it } from 'vitest';
import { revealable } from '../src/index.ts';

describe('revealable: what the contract accepts as a reveal', () => {
  const set = (orders: unknown[]) => ({ realm: 0, season: 1, orders }) as never;

  it('accepts ordinary orders', () => {
    expect(revealable(set([{ kind: 'march', from: 3, to: 4 }, { kind: 'trade', good: 'iron', side: 'buy', qty: 2 }]))).toBe(true);
  });

  it('refuses numbers JavaScript and the contract would write differently', () => {
    expect(revealable(set([{ kind: 'recruit', province: 1, count: 2 ** 53 + 2 }]))).toBe(false);
    expect(revealable(set([{ kind: 'recruit', province: 1, count: 1.5 }]))).toBe(false);
  });

  it('counts the size limit in UTF-8 bytes', () => {
    // 3,000 characters, but 9,000 bytes
    expect(revealable(set([{ kind: 'note', text: '城'.repeat(3_000) }]))).toBe(false);
  });

  it('refuses lone surrogates and non-ASCII keys', () => {
    expect(revealable(set([{ kind: 'note', text: '\ud800' }]))).toBe(false);
    expect(revealable(set([{ kind: 'march', 'é': 1 }]))).toBe(false);
  });

  it('refuses an array hole canonical JSON could not write, but not an unset field', () => {
    expect(revealable(set([{ kind: 'march', from: 1, to: 2 }, undefined]))).toBe(false);
    expect(revealable(set([{ kind: 'march', from: 1, to: 2, via: undefined }]))).toBe(true);
  });

  it('limits the salt in UTF-8 bytes, like the contract', () => {
    const ok = set([{ kind: 'march', from: 1, to: 2 }]);
    expect(revealable(ok, 'a'.repeat(128))).toBe(true);
    expect(revealable(ok, 'é'.repeat(100))).toBe(false); // 100 characters, 200 bytes
  });
});
