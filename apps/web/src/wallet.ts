// Signing in with a NEAR wallet (testnet), via NEAR Connect. At sign-in the wallet adds a
// function-call key limited to the realm contract and the five moves a ruler makes; the
// key stays in this browser, so every later seal, reveal, forfeit, treaty proposal and
// Chancellor cap is signed here without a wallet popup. Gas comes from your own testnet account.
import { CONTRACT } from './chain.ts';

/** The ruler's moves this browser may sign without asking the wallet again. */
export const RULER_METHODS = ['seal', 'reveal', 'forfeit', 'propose_treaty', 'set_policy'];

export interface Signer {
  accountId: string;
  /** Calls a contract method as the signed-in account and returns its result. */
  call<T = unknown>(method: string, args: object): Promise<T>;
  signOut(): Promise<void>;
}

type Outcome = { status?: { SuccessValue?: string; Failure?: unknown } | string };

function resultOf<T>(o: Outcome): T {
  const status = o.status;
  if (status && typeof status === 'object' && 'Failure' in status && status.Failure) {
    const msg = JSON.stringify(status.Failure);
    const panic = /panicked: ([^"\\]+)/.exec(msg)?.[1];
    throw new Error(panic ?? `the transaction failed: ${msg.slice(0, 200)}`);
  }
  const value = status && typeof status === 'object' ? status.SuccessValue : undefined;
  if (!value) return undefined as T;
  const text = atob(value);
  return (text ? JSON.parse(text) : undefined) as T;
}

let connectorPromise: Promise<import('@hot-labs/near-connect').NearConnector> | null = null;

async function connector(): Promise<import('@hot-labs/near-connect').NearConnector> {
  connectorPromise ??= (async () => {
    const [{ NearConnector }, { createAccessKeyPlugin }] = await Promise.all([import('@hot-labs/near-connect'), import('function-call-key-plugin')]);
    const c = new NearConnector({ network: 'testnet' });
    await c.use(
      createAccessKeyPlugin({
        network: 'testnet',
        signIn: { contractId: CONTRACT, methodNames: RULER_METHODS, allowance: '250000000000000000000000' },
      }),
    );
    return c;
  })();
  return connectorPromise;
}

function walletSigner(c: import('@hot-labs/near-connect').NearConnector, accountId: string): Signer {
  return {
    accountId,
    async call<T>(method: string, args: object): Promise<T> {
      const w = await c.wallet();
      const outcome = await w.signAndSendTransaction({
        receiverId: CONTRACT,
        actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: '30000000000000', deposit: '0' } }],
      });
      return resultOf<T>(outcome as unknown as Outcome);
    },
    async signOut() {
      const w = await c.wallet();
      await c.disconnect(w);
    },
  };
}

/**
 * Development only (VITE_DEV_SIGNER=1 builds): a test account's function-call key stored in
 * localStorage stands in for a wallet session, so the signed-in flow can be tested end to
 * end. Production builds drop this code.
 */
async function devSigner(): Promise<Signer | null> {
  if (import.meta.env.VITE_DEV_SIGNER !== '1') return null;
  let stored: { accountId: string; privateKey: string } | null = null;
  try {
    stored = JSON.parse(localStorage.getItem('realm-ledger:devkey') ?? 'null');
  } catch {
    stored = null;
  }
  if (!stored) return null;
  const { Account, JsonRpcProvider, KeyPairSigner } = await import('near-api-js');
  const account = new Account(stored.accountId, new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' }), KeyPairSigner.fromSecretKey(stored.privateKey as `ed25519:${string}`));
  return {
    accountId: stored.accountId,
    async call<T>(method: string, args: object): Promise<T> {
      return (await account.callFunction({ contractId: CONTRACT, methodName: method, args: args as Record<string, unknown>, gas: 30_000_000_000_000n })) as T;
    },
    async signOut() {
      localStorage.removeItem('realm-ledger:devkey');
    },
  };
}

/** The signed-in account from an earlier visit, if any. */
export async function restoreSigner(): Promise<Signer | null> {
  const dev = await devSigner();
  if (dev) return dev;
  try {
    const c = await connector();
    const { accounts } = await c.getConnectedWallet();
    const id = accounts[0]?.accountId;
    return id ? walletSigner(c, id) : null;
  } catch {
    return null;
  }
}

/** Opens the wallet picker; the wallet asks you to approve the function-call key. */
export async function signIn(): Promise<Signer> {
  const c = await connector();
  const wallet = await c.connect();
  const accounts = await wallet.getAccounts({ network: 'testnet' });
  const id = accounts[0]?.accountId;
  if (!id) throw new Error('the wallet returned no account');
  return walletSigner(c, id);
}
