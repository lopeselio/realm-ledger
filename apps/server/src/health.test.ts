import { describe, expect, it } from 'vitest';
import { assessHealth, healthMonitor, readAccount, seatAccounts, type AccountRead } from './health.ts';

const acct = (over: Partial<AccountRead> = {}): AccountRead => ({ account: 'x.testnet', balance: 1, storageBytes: 0, allowance: 0.5, ...over });
const ids = seatAccounts('realm-ledger.testnet');
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
  it('reads balances and allowances from plain view RPCs, and caches', async () => {
    let calls = 0;
    const f = (async (_u: string, init: any) => {
      calls++;
      const p = JSON.parse(init.body).params;
      const result = p.request_type === 'view_account'
        ? { amount: '6220800000000000000000000', storage_usage: 374675 }
        : { keys: [{ access_key: { permission: { FunctionCall: { allowance: '500000000000000000000000', receiver_id: 'realm-ledger.testnet', method_names: [] } } } }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'health', result }));
    }) as typeof fetch;
    expect(await readAccount('a.testnet', f)).toEqual({ account: 'a.testnet', balance: 6.2208, storageBytes: 374675, allowance: 0.5 });
    let t = 0;
    const h = healthMonitor(60_000, f, () => t);
    await h();
    const n = calls;
    t = 30_000;
    await h();
    expect(calls).toBe(n); // served from cache
  });
});
