import { describe, expect, it } from 'vitest';
import { allSeatAccounts } from './config.ts';
import { assessHealth, healthMonitor, readAccount, type AccountRead } from './health.ts';

const acct = (over: Partial<AccountRead> = {}): AccountRead => ({ account: 'x.testnet', balance: 1, storageBytes: 0, allowance: 0.5, ...over });
const ids = allSeatAccounts();
const seats = ids.map((account) => acct({ account, balance: 0.25, allowance: 0.5 }));

describe('health', () => {
  it('is ok when the contract has room and every account can pay gas', () => {
    const h = assessHealth(1, acct({ account: 'realm-ledger.testnet', balance: 6.22, storageBytes: 374_675 }), acct({ balance: 3.6 }), seats, ids);
    expect(h.level).toBe('ok');
    expect(h.contractFree).toBeCloseTo(2.4733, 3);
  });
  it('warns, then alerts, as the contract runs out of storage stake', () => {
    // The state found in the audit: 0.47 NEAR free.
    const warn = assessHealth(1, acct({ balance: 4.2208, storageBytes: 374_675 }), acct({ balance: 3.6 }), seats, ids);
    expect(warn.level).toBe('warn');
    expect(warn.checks[0]!.text).toMatch(/0\.474 NEAR free .*~47 KB/);
    expect(assessHealth(1, acct({ balance: 3.9, storageBytes: 374_675 }), acct({ balance: 3.6 }), seats, ids).level).toBe('alert');
  });
  it('a seat stops when either its NEAR or its allowance runs out', () => {
    const low = [...seats];
    low[2] = acct({ account: ids[2], balance: 0.25, allowance: 0.004 });
    const h = assessHealth(1, acct({ balance: 9 }), acct({ balance: 3.6 }), low, ids);
    expect(h.level).toBe('alert');
    expect(h.checks[0]!.subject).toBe(ids[2]);
  });
  it('review: an unreadable contract is an alert, an unreadable seat a warning', () => {
    expect(assessHealth(1, null, acct({ balance: 3.6 }), seats, ids).level).toBe('alert');
    const missing: (AccountRead | null)[] = [...seats];
    missing[3] = null;
    const h = assessHealth(1, acct({ balance: 9 }), acct({ balance: 3.6 }), missing, ids);
    expect(h.level).toBe('warn');
    expect(h.checks[0]!.subject).toBe(ids[3]);
  });

  const rpcFake = (keys: object[]) => {
    const calls: string[] = [];
    const f = (async (url: string, init: any) => {
      calls.push(url);
      if (url === 'https://down.example') throw new Error('ECONNREFUSED');
      const p = JSON.parse(init.body).params;
      const result = p.request_type === 'view_account' ? { amount: '6220800000000000000000000', storage_usage: 374675 } : { keys };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'health', result }));
    }) as typeof fetch;
    return { f, calls };
  };
  const fcKey = (pk: string, allowance: string) => ({ public_key: pk, access_key: { permission: { FunctionCall: { allowance, receiver_id: 'realm-ledger.testnet', method_names: [] } } } });

  it('review: fails over to the next RPC, and reads the allowance of the key the server signs with', async () => {
    const { f, calls } = rpcFake([fcKey('ed25519:old', '1000000000000000000000'), fcKey('ed25519:mine', '500000000000000000000000')]);
    const r = await readAccount('a.testnet', { withKey: true, urls: ['https://down.example', 'https://up.example'], fetch: f, signer: () => 'ed25519:mine' });
    expect(r).toEqual({ account: 'a.testnet', balance: 6.2208, storageBytes: 374675, allowance: 0.5 });
    expect(calls).toContain('https://down.example');
    // Without a known signing key, the largest allowance stands in.
    const r2 = await readAccount('a.testnet', { withKey: true, urls: ['https://up.example'], fetch: f, signer: () => null });
    expect(r2!.allowance).toBe(0.5);
  });

  it('review: answers from cache at once and refreshes in the background', async () => {
    const { f, calls } = rpcFake([fcKey('ed25519:mine', '500000000000000000000000')]);
    let t = 0;
    const h = healthMonitor({ ttlMs: 60_000, urls: ['https://up.example'], fetch: f, now: () => t, signer: () => 'ed25519:mine' });
    expect((await h()).level).toBe('ok');
    const n = calls.length;
    t = 30_000;
    await h();
    expect(calls.length).toBe(n); // fresh: served from cache
    t = 120_000;
    const stale = await h(); // stale: served at once, refresh starts behind it
    expect(stale.at).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBeGreaterThan(n);
  });

  it('review: the first request waits only so long, then says it is still checking', async () => {
    const slow = (() => new Promise(() => {})) as unknown as typeof fetch;
    const h = healthMonitor({ urls: ['https://slow.example'], fetch: slow, firstWaitMs: 20 });
    expect((await h()).level).toBe('checking');
  });
});
