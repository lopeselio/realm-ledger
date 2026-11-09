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
  bundle: { options: { seed: 's', realms: 3, human: 0, maxSeasons: 12 } },
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

  it('stamps a campaign from before rules versions with version 1, in memory and on disk', async () => {
    const { readFileSync } = await import('node:fs');
    expect(host.proof(3).options.rulesVersion).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, 'campaign-3.json'), 'utf8')).bundle.options.rulesVersion).toBe(1);
  });

  it('reports progress and the ruling account', () => {
    expect(host.list({ ids: [2] })[0]).toMatchObject({ season: 2, maxSeasons: 12, phase: 'planning', player: 'alice.testnet', yourSeal: null, winner: null });
  });
});

describe('access-key failures, as near-api-js reports them', () => {
  it('recognises an exhausted or missing key, and a method the key may not call', async () => {
    const host = await import('./host.ts');
    const errors = (await import('near-api-js/rpc-errors')) as unknown as Record<string, new (...a: unknown[]) => Error>;
    const allowance = new errors.AccessKeyNotEnoughAllowanceActionError!('ruler1.realm-ledger.testnet', '0', '1', 'ed25519:abc', 0, 'tx', 'block');
    const gone = new errors.AccessKeyNotFoundActionError!('ruler1.realm-ledger.testnet', 'ed25519:abc', 0, 'tx', 'block');
    const method = new errors.AccessKeyMethodNameMismatchActionError!('reveal', 0, 'tx', 'block');
    expect(host.isKeyFailure(allowance)).toBe(true);
    expect(host.isKeyFailure(gone)).toBe(true);
    expect(host.isKeyFailure(method)).toBe(false);
    expect(host.isMethodNotAllowed(method)).toBe(true);
    // a seat too poor to pay can't sign either, but that's not a lasting key failure
    const poor = new errors.NotEnoughBalanceError!('100', '200', 'ruler1.realm-ledger.testnet', 'tx', 'block');
    expect(host.cantPay(poor)).toBe(true);
    expect(host.isKeyFailure(poor)).toBe(false);
    expect(host.isKeyFailure(new Error('Contract panicked: orders do not match the seal'))).toBe(false);
    // a lagging RPC's view of a key added a moment ago is not a key failure
    expect(host.isKeyFailure(new Error('Access key ed25519:abc does not exist at block height 7'))).toBe(false);
  });
});
