// What /api/health reports: whether the things that quietly run out will last through judging.
//  - the contract's free balance: it pays for its own storage (callers aren't charged), so once the
//    balance no longer covers storage every write fails (create, seal, reveal, settle);
//  - the referee's NEAR (it signs the contract's housekeeping);
//  - every seat account's NEAR and its key's remaining gas allowance (a seat stops when either runs out).
// Read with plain view RPCs (no keys), cached, and judged by a pure function so it's tested offline.
import { config, COMPANY_ACCOUNTS } from './config.ts';

export type Level = 'ok' | 'warn' | 'alert';
export interface Check { level: Level; subject: string; text: string }
export interface AccountRead { account: string; balance: number; storageBytes: number; allowance: number | null }
export interface Health { ok: boolean; level: Level; at: number; version: string; contract: string; contractFree: number | null; checks: Check[] }

/** NEAR per byte of contract storage (10^19 yocto). */
export const STORAGE_PRICE = 1e-5;
export const CONTRACT_FREE_WARN = 1;
export const CONTRACT_FREE_ALERT = 0.3;
export const REFEREE_WARN = 1;
export const SEAT_WARN = 0.05;
export const SEAT_ALERT = 0.01;

export const seatAccounts = (contract: string): string[] => [
  ...Array.from({ length: 8 }, (_, i) => `ruler${i}.${contract}`),
  `player.${contract}`,
  `chancellor.${contract}`,
  ...COMPANY_ACCOUNTS.map((c) => `${c}.${contract}`),
];

/** Pure: what's wrong, given what was read. A null read means it couldn't be read. */
export function assessHealth(now: number, contract: AccountRead | null, referee: AccountRead | null, seats: (AccountRead | null)[], seatIds: string[]): Health {
  const checks: Check[] = [];
  let contractFree: number | null = null;
  if (!contract) checks.push({ level: 'warn', subject: 'contract', text: 'could not read the contract account' });
  else {
    contractFree = contract.balance - contract.storageBytes * STORAGE_PRICE;
    if (contractFree < CONTRACT_FREE_WARN) {
      checks.push({
        level: contractFree < CONTRACT_FREE_ALERT ? 'alert' : 'warn',
        subject: 'contract',
        text: `only ${contractFree.toFixed(3)} NEAR free for storage (~${Math.max(0, Math.round(contractFree / STORAGE_PRICE / 1000))} KB, a campaign takes ~2 KB): send NEAR to ${contract.account}`,
      });
    }
  }
  if (!referee) checks.push({ level: 'warn', subject: 'referee', text: 'could not read the referee account' });
  else if (referee.balance < REFEREE_WARN) checks.push({ level: 'warn', subject: 'referee', text: `referee down to ${referee.balance.toFixed(3)} NEAR` });
  seats.forEach((s, i) => {
    const id = seatIds[i] ?? `seat ${i}`;
    if (!s) return; // a seat that doesn't exist yet (or a failed read) isn't an emergency on its own
    // A seat signs until EITHER its NEAR or its key's allowance runs out.
    const left = s.allowance === null ? s.balance : Math.min(s.balance, s.allowance);
    if (left < SEAT_WARN) checks.push({ level: left < SEAT_ALERT ? 'alert' : 'warn', subject: id, text: `${left.toFixed(3)} NEAR left to pay gas (balance ${s.balance.toFixed(3)}, allowance ${s.allowance === null ? 'unlimited' : s.allowance.toFixed(3)})` });
  });
  const level: Level = checks.some((c) => c.level === 'alert') ? 'alert' : checks.length ? 'warn' : 'ok';
  return { ok: level !== 'alert', level, at: now, version: process.env.APP_VERSION ?? 'dev', contract: contract?.account ?? config.contract, contractFree, checks };
}

type Fetch = typeof fetch;
async function rpc(f: Fetch, method: string, params: object): Promise<any> {
  const r = await f(config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'health', method, params }), signal: AbortSignal.timeout(8000) });
  const body = (await r.json()) as any;
  if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error).slice(0, 200));
  return body.result;
}

/** One account's NEAR, storage, and its first function-call key's allowance (null if none/unlimited). */
export async function readAccount(account: string, f: Fetch = fetch): Promise<AccountRead | null> {
  try {
    const a = await rpc(f, 'query', { request_type: 'view_account', finality: 'final', account_id: account });
    const keys = await rpc(f, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: account });
    const fc = (keys.keys as any[]).map((k) => k.access_key.permission).find((p) => p !== 'FullAccess' && p?.FunctionCall);
    const allowance = fc?.FunctionCall?.allowance ? Number(BigInt(fc.FunctionCall.allowance) / 10n ** 18n) / 1e6 : null;
    return { account, balance: Number(BigInt(a.amount) / 10n ** 18n) / 1e6, storageBytes: a.storage_usage, allowance };
  } catch {
    return null;
  }
}

/** Read everything and judge it; cached so health checks never hammer the RPC. */
export function healthMonitor(ttlMs = 5 * 60_000, f: Fetch = fetch, now: () => number = Date.now) {
  let cached: Health | null = null;
  let pending: Promise<Health> | null = null;
  const refresh = async (): Promise<Health> => {
    const ids = seatAccounts(config.contract);
    const [contract, referee, ...seats] = await Promise.all([readAccount(config.contract, f), readAccount(config.referee, f), ...ids.map((id) => readAccount(id, f))]);
    cached = assessHealth(now(), contract, referee, seats, ids);
    return cached;
  };
  return async (): Promise<Health> => {
    if (cached && now() - cached.at < ttlMs) return cached;
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  };
}
