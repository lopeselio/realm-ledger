import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, teraToGas, type KeyPairString } from 'near-api-js';
import { config, privateKey } from './config.ts';

// Signs and sends calls to the realm contract. Calls from one account are queued so
// their nonces never collide; different accounts run in parallel.

// several public testnet RPCs (docs.near.org/api/rpc/providers); on a failure the next one is used
const RPCS = [config.rpcUrl, 'https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs'].filter((u, i, a) => a.indexOf(u) === i);
const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));
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

const isNetworkError = (e: unknown): boolean => /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|503|502|timeout/i.test(String((e as Error)?.message ?? e) + String((e as { cause?: unknown })?.cause ?? ''));
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
      if (opts.done && (await opts.done())) return undefined as T;
      try {
        return await once();
      } catch (e) {
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
