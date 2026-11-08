import { FailoverRpcProvider, JsonRpcProvider } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { withRealErrors } from './chain.ts';

// The server relies on near-api-js's FailoverRpcProvider routing every call through
// `withBackoff`, which chain.ts replaces so refused transactions keep their real error.
describe('RPC failover', () => {
  const failing = (e: Error) => Object.assign(new JsonRpcProvider({ url: 'http://unused.invalid' }), { viewAccessKey: async () => Promise.reject(e) });

  it('returns a refusal unchanged instead of "Exceeded 3 providers"', async () => {
    const refusal = new Error('Access key does not allow method reveal');
    const p = withRealErrors(new FailoverRpcProvider([failing(refusal), failing(new Error('fetch failed'))]));
    await expect(p.viewAccessKey({ accountId: 'a.testnet', publicKey: 'ed25519:x' } as never)).rejects.toBe(refusal);
  });

  it('moves on to the next RPC after an RPC-side error', async () => {
    const ok = Object.assign(new JsonRpcProvider({ url: 'http://unused.invalid' }), { viewAccessKey: async () => ({ nonce: 2 }) });
    const lagging = new Error('[-32000] Server error: UNKNOWN_BLOCK');
    const p = withRealErrors(new FailoverRpcProvider([failing(lagging), ok]));
    await expect(p.viewAccessKey({ accountId: 'a.testnet', publicKey: 'ed25519:x' } as never)).resolves.toEqual({ nonce: 2 });
  });

  it('asks the next RPC when one says a key does not exist (it may be a block behind)', async () => {
    const ok = Object.assign(new JsonRpcProvider({ url: 'http://unused.invalid' }), { viewAccessKey: async () => ({ nonce: 3 }) });
    const behind = Object.assign(new Error('Access key ed25519:x does not exist at block height 1'), { name: 'AccessKeyDoesNotExistError' });
    const p = withRealErrors(new FailoverRpcProvider([failing(behind), ok]));
    await expect(p.viewAccessKey({ accountId: 'a.testnet', publicKey: 'ed25519:x' } as never)).resolves.toEqual({ nonce: 3 });
  });

  it('reports a partial outage as an outage, so it is retried', async () => {
    const missing = Object.assign(new Error('Access key ed25519:x does not exist at block height 1'), { name: 'AccessKeyDoesNotExistError' });
    const outage = new Error('fetch failed');
    const p = withRealErrors(new FailoverRpcProvider([failing(missing), failing(outage)]));
    await expect(p.viewAccessKey({ accountId: 'a.testnet', publicKey: 'ed25519:x' } as never)).rejects.toBe(outage);
  });

  it('reports "does not exist" when every RPC that answered said it', async () => {
    const missing = Object.assign(new Error('Access key ed25519:x does not exist at block height 1'), { name: 'AccessKeyDoesNotExistError' });
    const p = withRealErrors(new FailoverRpcProvider([failing(missing), failing(missing)]));
    await expect(p.viewAccessKey({ accountId: 'a.testnet', publicKey: 'ed25519:x' } as never)).rejects.toBe(missing);
  });

  it('moves on to the next RPC after a network failure', async () => {
    const ok = Object.assign(new JsonRpcProvider({ url: 'http://unused.invalid' }), { viewAccessKey: async () => ({ nonce: 1 }) });
    const p = withRealErrors(new FailoverRpcProvider([failing(new Error('fetch failed')), ok]));
    await expect(p.viewAccessKey({ accountId: 'a.testnet', publicKey: 'ed25519:x' } as never)).resolves.toEqual({ nonce: 1 });
  });
});
