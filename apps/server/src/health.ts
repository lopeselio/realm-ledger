// What /api/health reports: whether the things that quietly run out will last through judging.
//  - the contract's free balance: it pays for its own storage (callers aren't charged), so once the
//    balance no longer covers storage every write fails (create, seal, reveal, settle);
//  - the referee's NEAR (it signs the contract's housekeeping);
//  - every seat account's NEAR and its signing key's remaining gas allowance (a seat stops when either
//    runs out).
// Read with plain view RPCs (no signing) across the same RPC list the game fails over between, cached
// and refreshed in the background, and judged by a pure function so it's tested offline.
import { KeyPair, type KeyPairString } from 'near-api-js';
import { allSeatAccounts, config, privateKey } from './config.ts';

export type Level = 'ok' | 'warn' | 'alert';
export interface Check { level: Level; subject: string; text: string }
export interface AccountRead { account: string; balance: number; storageBytes: number; allowance: number | null }
export interface Health { ok: boolean; level: Level | 'checking'; at: number; version: string; contract: string; contractFree: number | null; checks: Check[] }

/** NEAR per byte of contract storage (10^19 yocto). */
export const STORAGE_PRICE = 1e-5;
export const CONTRACT_FREE_WARN = 1;
export const CONTRACT_FREE_ALERT = 0.3;
export const REFEREE_WARN = 1;
export const SEAT_WARN = 0.05;
export const SEAT_ALERT = 0.01;

const version = () => process.env.APP_VERSION ?? 'dev';

/** Pure: what's wrong, given what was read. A null read means it couldn't be read. */
export function assessHealth(now: number, contract: AccountRead | null, referee: AccountRead | null, seats: (AccountRead | null)[], seatIds: string[]): Health {
  const checks: Check[] = [];
  let contractFree: number | null = null;
  // The contract running out of storage stake stops every write, so not being able to tell is an alert.
  if (!contract) checks.push({ level: 'alert', subject: 'contract', text: 'could not read the contract account from any RPC' });
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
    if (!s) { checks.push({ level: 'warn', subject: id, text: 'could not read this seat account' }); return; }
    // A seat signs until EITHER its NEAR or its key's allowance runs out.
    const left = s.allowance === null ? s.balance : Math.min(s.balance, s.allowance);
    if (left < SEAT_WARN) checks.push({ level: left < SEAT_ALERT ? 'alert' : 'warn', subject: id, text: `${left.toFixed(3)} NEAR left to pay gas (balance ${s.balance.toFixed(3)}, allowance ${s.allowance === null ? 'unlimited' : s.allowance.toFixed(3)})` });
  });
  const level: Level = checks.some((c) => c.level === 'alert') ? 'alert' : checks.length ? 'warn' : 'ok';
  return { ok: level !== 'alert', level, at: now, version: version(), contract: contract?.account ?? config.contract, contractFree, checks };
}

type Fetch = typeof fetch;

/** A view RPC, trying each URL in turn (the same failover list the game uses). */
async function rpc(f: Fetch, urls: string[], params: object): Promise<any> {
  let last: unknown;
  for (const url of urls) {
    try {
      const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'health', method: 'query', params }), signal: AbortSignal.timeout(5000) });
      const body = (await r.json()) as any;
      if (body.error || body.result?.error) throw new Error(JSON.stringify(body.error ?? body.result.error).slice(0, 200));
      return body.result;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error('no RPC answered');
}

const nearOf = (yocto: string) => Number(BigInt(yocto) / 10n ** 18n) / 1e6;

/** The public key the server signs as `account` with, if it has that key here. */
function signingKey(account: string): string | null {
  try { return KeyPair.fromString(privateKey(account) as KeyPairString).getPublicKey().toString(); }
  catch { return null; }
}

/**
 * One account's NEAR and storage, plus (when `withKey`) the allowance of the key the server signs with.
 * If that key isn't known here, the largest function-call allowance is used.
 */
export async function readAccount(account: string, opts: { withKey?: boolean; urls?: string[]; fetch?: Fetch; signer?: (id: string) => string | null } = {}): Promise<AccountRead | null> {
  const f = opts.fetch ?? fetch;
  const urls = opts.urls ?? [config.rpcUrl];
  try {
    const [a, keys] = await Promise.all([
      rpc(f, urls, { request_type: 'view_account', finality: 'final', account_id: account }),
      opts.withKey ? rpc(f, urls, { request_type: 'view_access_key_list', finality: 'final', account_id: account }) : Promise.resolve(null),
    ]);
    let allowance: number | null = null;
    if (keys) {
      const fc = (keys.keys as any[]).filter((k) => k.access_key.permission !== 'FullAccess' && k.access_key.permission?.FunctionCall);
      const mine = (opts.signer ?? signingKey)(account);
      const big = (k: any) => BigInt(k.access_key.permission.FunctionCall.allowance ?? 0);
      const pick = fc.find((k) => k.public_key === mine) ?? [...fc].sort((x, y) => (big(y) > big(x) ? 1 : big(y) < big(x) ? -1 : 0))[0];
      const raw = pick?.access_key.permission.FunctionCall.allowance;
      allowance = raw ? nearOf(raw) : null;
    }
    return { account, balance: nearOf(a.amount), storageBytes: a.storage_usage, allowance };
  } catch {
    return null;
  }
}

/**
 * Read everything and judge it. Answers from cache at once; when the cache is stale it refreshes in
 * the background, so a health request never waits on a sweep of RPCs (only the very first one does,
 * for at most `firstWaitMs`, after which it says it's still checking).
 */
export function healthMonitor(opts: { ttlMs?: number; firstWaitMs?: number; urls?: string[]; fetch?: Fetch; now?: () => number; signer?: (id: string) => string | null } = {}) {
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  let cached: Health | null = null;
  let pending: Promise<Health> | null = null;
  const refresh = (): Promise<Health> => {
    pending ??= (async () => {
      const ids = allSeatAccounts();
      const read = (id: string, withKey: boolean) => readAccount(id, { withKey, urls: opts.urls, fetch: opts.fetch, signer: opts.signer });
      const [contract, referee, ...seats] = await Promise.all([read(config.contract, false), read(config.referee, false), ...ids.map((id) => read(id, true))]);
      cached = assessHealth(now(), contract ?? null, referee ?? null, seats, ids);
      return cached;
    })().finally(() => { pending = null; });
    return pending;
  };
  return async (): Promise<Health> => {
    if (cached) {
      if (now() - cached.at >= ttlMs) void refresh().catch(() => {});
      return cached;
    }
    const waited = await Promise.race([refresh(), new Promise<null>((r) => setTimeout(() => r(null), opts.firstWaitMs ?? 4000))]);
    return waited ?? { ok: true, level: 'checking', at: now(), version: version(), contract: config.contract, contractFree: null, checks: [] };
  };
}
