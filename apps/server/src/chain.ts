import { Account, JsonRpcProvider, KeyPairSigner, teraToGas, type KeyPairString } from 'near-api-js';
import { config, privateKey } from './config.ts';

// Signs and sends calls to the realm contract. Calls from one account are queued so
// their nonces never collide; different accounts run in parallel.

const provider = new JsonRpcProvider({ url: config.rpcUrl });
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
}

/** Calls a contract method as `signer`, after any earlier calls from the same signer. */
export function call<T = unknown>(signer: string, method: string, args: object, opts: CallOptions = {}): Promise<T> {
  const prev = queues.get(signer) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(() =>
      account(signer).callFunction<T & object>({
        contractId: config.contract,
        methodName: method,
        args: args as Record<string, unknown>,
        gas: teraToGas(opts.gasTera ?? 30),
        deposit: opts.depositYocto ?? 0n,
        waitUntil: opts.waitUntil ?? 'EXECUTED_OPTIMISTIC',
      }),
    ) as Promise<T>;
  queues.set(signer, run);
  return run;
}

/** Read-only contract call. */
export async function view<T>(method: string, args: object): Promise<T | undefined> {
  return provider.callFunction<T & object>({ contractId: config.contract, method, args: args as Record<string, unknown> }) as Promise<T | undefined>;
}

export async function accountExists(id: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId: id, blockQuery: { finality: 'final' } });
    return true;
  } catch {
    return false;
  }
}
