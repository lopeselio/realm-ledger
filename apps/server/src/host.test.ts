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
    expect(host.list({ ids: [2] })[0]).toMatchObject({ season: 2, maxSeasons: 12, phase: 'planning', player: 'alice.testnet', winner: null });
  });
});
