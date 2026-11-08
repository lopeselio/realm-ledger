import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'realm-ledger-'));
process.env.DATA_DIR = dir;

// just enough of a saved campaign for loadAll and list
const saved = (id: number, player?: string, phase = 'planning') => ({
  id,
  phase,
  state: { season: 2, maxSeasons: 12, winner: null, realms: [] },
  pending: { ai: [] },
  bundle: {},
  createdAt: id,
  ...(player ? { player } : {}),
});

describe('campaign list', () => {
  let host: typeof import('./host.ts');
  beforeAll(async () => {
    writeFileSync(join(dir, 'campaign-1.json'), JSON.stringify(saved(1, undefined, 'over')));
    writeFileSync(join(dir, 'campaign-2.json'), JSON.stringify(saved(2, 'alice.testnet')));
    writeFileSync(join(dir, 'campaign-3.json'), JSON.stringify(saved(3)));
    // a write that died before its rename, long ago: deleted
    writeFileSync(join(dir, 'campaign-4.json.old.tmp'), '{"id":4,');
    utimesSync(join(dir, 'campaign-4.json.old.tmp'), new Date(0), new Date(0));
    // another container's save in progress: left alone
    writeFileSync(join(dir, 'campaign-5.json.new.tmp'), '{"id":5,');
    // an unreadable file doesn't stop the ones after it from loading
    writeFileSync(join(dir, 'campaign-0.json'), '{"id":0,');
    // nor does one that parses but has the wrong shape, or claims another file's id
    writeFileSync(join(dir, 'campaign-8.json'), '{"id":8,"pending":{},"bundle":{}}');
    writeFileSync(join(dir, 'campaign-9.json'), JSON.stringify(saved(2)));
    host = await import('./host.ts');
    expect(await host.loadAll()).toBe(3);
    expect(existsSync(join(dir, 'campaign-4.json.old.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'campaign-5.json.new.tmp'))).toBe(true);
  });

  it('lists everything, newest first, without a filter', () => {
    expect(host.list().map((c) => c.id)).toEqual([3, 2, 1]);
  });

  it('narrows to the ids a browser played or the campaigns a wallet rules', () => {
    expect(host.list({ ids: [1] }).map((c) => c.id)).toEqual([1]);
    expect(host.list({ player: 'alice.testnet' }).map((c) => c.id)).toEqual([2]);
    expect(host.list({ ids: [3], player: 'alice.testnet' }).map((c) => c.id)).toEqual([3, 2]);
    // unfinished campaigns first, so the newest finished ones can't push them off the list
    expect(host.list({ ids: [1, 3], player: 'alice.testnet' }).map((c) => c.id)).toEqual([3, 2, 1]);
    expect(host.list({ ids: [1, 2] }).map((c) => c.id)).toEqual([2, 1]);
    expect(host.list({ ids: [] })).toEqual([]);
  });

  it('reports progress and the ruling account', () => {
    expect(host.list({ ids: [2] })[0]).toMatchObject({ season: 2, maxSeasons: 12, phase: 'planning', player: 'alice.testnet', yourSeal: null, winner: null });
  });
});

describe('revealable: what the contract accepts as a reveal', () => {
  let host: typeof import('./host.ts');
  beforeAll(async () => {
    host = await import('./host.ts');
  });
  const set = (orders: unknown[]) => ({ realm: 0, season: 1, orders }) as never;

  it('accepts ordinary orders', () => {
    expect(host.revealable(set([{ kind: 'march', from: 3, to: 4 }, { kind: 'trade', good: 'iron', side: 'buy', qty: 2 }]))).toBe(true);
  });

  it('refuses numbers JavaScript and the contract would write differently', () => {
    expect(host.revealable(set([{ kind: 'recruit', province: 1, count: 2 ** 53 + 2 }]))).toBe(false);
    expect(host.revealable(set([{ kind: 'recruit', province: 1, count: 1.5 }]))).toBe(false);
  });

  it('counts the size limit in UTF-8 bytes', () => {
    // 3,000 characters, but 9,000 bytes
    expect(host.revealable(set([{ kind: 'note', text: '城'.repeat(3_000) }]))).toBe(false);
  });

  it('refuses lone surrogates and non-ASCII keys', () => {
    expect(host.revealable(set([{ kind: 'note', text: '\ud800' }]))).toBe(false);
    expect(host.revealable(set([{ kind: 'march', 'é': 1 }]))).toBe(false);
  });

  it('refuses an array hole canonical JSON could not write', () => {
    expect(host.revealable(set([{ kind: 'march', from: 1, to: 2 }, undefined]))).toBe(false);
  });
});
