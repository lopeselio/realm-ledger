import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, teraToGas, type KeyPairString } from 'near-api-js';
import { config, privateKey } from './config.ts';

// Signs and sends calls to the realm contract. Calls from one account are queued so
// their nonces never collide; different accounts run in parallel.

// several public testnet RPCs (docs.near.org/api/rpc/providers); on a failure the next one is used
const RPCS = [config.rpcUrl, 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'].filter((u, i, a) => a.indexOf(u) === i);
const provider = withRealErrors(new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url }))));

// near-api-js's failover tries the next RPC on any error and, once all have failed, throws
// "Exceeded 3 providers" in place of what went wrong, so a refused transaction (a key out of
// allowance, a method its key may not call) became indistinguishable from an outage. Here a
// definite refusal from the chain is returned unchanged; anything else tries the next RPC.
// (chain.test.ts checks this still holds for the installed near-api-js)
type Failover = { providers: unknown[]; currentProviderIndex: number };
export function withRealErrors<P extends FailoverRpcProvider>(failover: P): P {
  (failover as unknown as { withBackoff: (get: (p: unknown) => Promise<unknown>) => Promise<unknown> }).withBackoff = async function (
    this: Failover,
    get: (p: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    // if every RPC fails, the most telling error wins: one about the request (a key that
    // doesn't exist yet on a lagging node, say) over "fetch failed"
    // ranked: something about this key or account (2) over an RPC's own error (1) over the network (0)
    const rank = (e: unknown): number =>
      /AccessKey|AccountDoesNotExist|does not exist|Not enough allowance/.test(`${(e as Error)?.name ?? ''}: ${String((e as Error)?.message ?? e)}`) ? 2 : isNetworkError(e) ? 0 : 1;
    let telling: unknown;
    let empty = false;
    // each request walks the list from the current RPC on its own, so parallel requests don't
    // move each other past a healthy one; the shared index only moves to one that answered
    const start = this.currentProviderIndex;
    const n = this.providers.length;
    for (let i = 0; i < n; i++) {
      const at = (start + i) % n;
      try {
        const result = await get(this.providers[at]);
        this.currentProviderIndex = at;
        if (result !== undefined) return result;
        // an empty answer may be a lagging RPC's: ask the next, but it stands if none says more
        empty = true;
      } catch (e) {
        if (isRefusal(e)) throw e;
        if (telling === undefined || rank(e) > rank(telling)) telling = e;
      }
    }
    if (empty) return undefined;
    throw telling ?? new Error(`no answer from ${this.providers.length} RPC providers`);
  };
  return failover;
}
const accounts = new Map<string, Account>();
const queues = new Map<string, Promise<unknown>>();

function account(id: string): Account {
  let a = accounts.get(id);
  if (!a) {
    a = new Account(id, provider, KeyPairSigner.fromSecretKey(privateKey(id) as KeyPairString));
    accounts.set(id, a);
  }
  return a;
}

export interface CallOptions {
  gasTera?: number;
  depositYocto?: bigint;
  /** FINAL for writes that readers must see at once (season settlements) */
  waitUntil?: 'EXECUTED_OPTIMISTIC' | 'FINAL';
  /**
   * Checked before every attempt; when it says the effect is already onchain the call
   * is skipped. Calls with a guard are retried on network errors, since a retry can't
   * apply them twice.
   */
  done?: () => Promise<boolean>;
}

/** A failure of the RPC or the network, worth trying again (on another RPC). */
export function isNetworkError(e: unknown): boolean {
  // a contract's own panic is never the network, whatever numbers or words it contains
  if (/panicked/.test(String((e as Error)?.message ?? e))) return false;
  const cause = (e as { cause?: unknown })?.cause;
  // near-api-js puts the HTTP status in `cause` (e.g. "… Bad Gateway" with cause 502)
  if (typeof cause === 'number' && [408, 429, 500, 502, 503, 504].includes(cause)) return true;
  if (cause instanceof Error && isNetworkError(cause)) return true;
  // (status codes come in `cause`, checked above: a bare number in a message is too often a
  // nonce, block height or amount)
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|Bad Gateway|unavailable|Internal server error|Too Many Requests|timeout|Exceeded \d+ attempts|RetriesExceeded|ShardCongested|ShardStuck|Expired/i.test(
    String((e as Error)?.message ?? e),
  );
}

/**
 * The chain's definite answer to a request, which another RPC would only repeat: the contract
 * panicked, the transaction or one of its actions was refused (a key's allowance or methods,
 * a stale nonce). Anything else is worth asking the next RPC, including "does not exist" for
 * a key or account (as a view or a transaction), which an RPC a block behind says about one
 * added a moment ago; if every RPC says so, that error is the one returned.
 */
function isRefusal(e: unknown): boolean {
  const text = `${(e as Error)?.name ?? ''}: ${String((e as Error)?.message ?? e)}`;
  if (/panicked/.test(text)) return true;
  // the chain is busy, not saying no: another RPC, or a moment later, may get through
  if (/ShardCongested|ShardStuck|Expired/.test(text)) return false;
  if (/AccessKeyDoesNotExist|AccessKeyNotFound|AccountDoesNotExist|does not exist/.test(text)) return false;
  return /ActionError|ActionExecutionError|ContractExecutionError|InvalidNonce|InvalidTx|does not allow method|Not enough allowance/.test(text);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Calls a contract method as `signer`, after any earlier calls from the same signer. */
export function call<T = unknown>(signer: string, method: string, args: object, opts: CallOptions = {}): Promise<T> {
  const prev = queues.get(signer) ?? Promise.resolve();
  const once = (): Promise<T> =>
    account(signer).callFunction<T & object>({
      contractId: config.contract,
      methodName: method,
      args: args as Record<string, unknown>,
      gas: teraToGas(opts.gasTera ?? 30),
      deposit: opts.depositYocto ?? 0n,
      waitUntil: opts.waitUntil ?? 'EXECUTED_OPTIMISTIC',
    }) as Promise<T>;
  const guarded = async (): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      // before every attempt: an earlier one may have landed late
      if (opts.done && (await opts.done())) return undefined as T;
      try {
        return await once();
      } catch (e) {
        // a definite failure may still hide a landed call (a resend after a timeout comes back
        // with a stale nonce, say): if its effect is onchain, it worked
        if (!isNetworkError(e) && opts.done && (await opts.done().catch(() => false))) return undefined as T;
        if (!opts.done || attempt >= 3 || !isNetworkError(e)) throw e;
        console.warn(`${signer} ${method}: ${(e as Error).message}; retrying`);
        await sleep(800 * (attempt + 1));
      }
    }
  };
  const run = prev.catch(() => undefined).then(guarded);
  queues.set(signer, run);
  return run;
}

/** Read-only contract call. */
export async function view<T>(method: string, args: object): Promise<T | undefined> {
  // optimistic: see a write as soon as it executes (a player's seal posted a moment ago),
  // rather than a block or two later at finality
  return provider.callFunction<T & object>({
    contractId: config.contract,
    method,
    args: args as Record<string, unknown>,
    blockQuery: { finality: 'optimistic' },
  }) as Promise<T | undefined>;
}

export async function accountExists(id: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId: id, blockQuery: { finality: 'final' } });
    return true;
  } catch {
    return false;
  }
}
