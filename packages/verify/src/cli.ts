#!/usr/bin/env -S npx tsx
// pnpm verify:campaign <bundle.json | https://.../proof> [--no-chain]
// Checks a campaign's proof bundle and, unless --no-chain, compares it with the contract.

import { readFile } from 'node:fs/promises';
import { checkAgainstChain, verifyBundle, type Check, type ProofBundle } from './index.ts';

// testnet RPCs, tried in turn: a public one may rate-limit (HTTP or JSON-RPC 429) or be down.
// NEAR_RPC_URL names one to use instead (rpc.testnet.near.org now answers -429, deprecated)
const RPCS = process.env.NEAR_RPC_URL
  ? [process.env.NEAR_RPC_URL]
  : ['https://test.rpc.fastnear.com', 'https://testnet-rpc.intea.rs', 'https://near-testnet.drpc.org'];

async function load(src: string): Promise<ProofBundle> {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
    return (await res.json()) as ProofBundle;
  }
  return JSON.parse(await readFile(src, 'utf8')) as ProofBundle;
}

/** The contract answered with an error of its own: no use asking another provider. */
class ContractError extends Error {}

function viewer(contract: string) {
  return async (method: string, args: object): Promise<unknown> => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'realm-verify',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      },
    });
    const failures: string[] = [];
    // round-robin: each provider once, then a pause and a second round; a slow one is given up after 10 s
    const tries = [...RPCS, ...RPCS];
    for (const [i, rpc] of tries.entries()) {
      if (i === RPCS.length) await new Promise((r) => setTimeout(r, 1000));
      let out: { result?: { result?: number[]; error?: string }; error?: { name?: string; cause?: { name?: string } } };
      let status = 0;
      try {
        const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
        status = res.status;
        out = (await res.json()) as typeof out;
      } catch (e) {
        failures.push(`${rpc}: ${(e as Error).message}`);
        continue;
      }
      if (out.result?.result) {
        // the contract's answer: bytes that aren't JSON are its fault, not the provider's
        try {
          return JSON.parse(Buffer.from(out.result.result).toString('utf8'));
        } catch {
          throw new ContractError(`${method}: the contract returned something that isn't JSON`);
        }
      }
      // the contract itself refused (a panic, no such account, method or code): another provider would say
      // the same. A node's own fault (unknown block, unavailable shard, rate limit) moves on to the next
      const said = JSON.stringify(out.error ?? out.result ?? out);
      if (out.result?.error || /CONTRACT_EXECUTION_ERROR|UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|MethodNotFound|CodeDoesNotExist|panicked/.test(said)) throw new ContractError(`${method}: ${said.slice(0, 300)}`);
      failures.push(`${rpc}: ${status} ${said.slice(0, 160)}`);
    }
    throw new Error(`RPC ${method} failed on every provider (set NEAR_RPC_URL to use another):\n  ${failures.join('\n  ')}`);
  };
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const src = args.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('usage: pnpm verify:campaign <bundle.json | url> [--no-chain]');
  process.exit(2);
}
const bundle = await load(src);
const checks: Check[] = verifyBundle(bundle);
if (!args.includes('--no-chain')) checks.push(...(await checkAgainstChain(bundle, viewer(bundle.contract))));

for (const c of checks) console.log(`${c.ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
const failed = checks.filter((c) => !c.ok);
console.log(
  failed.length === 0
    ? `\nall ${checks.length} checks passed: campaign ${bundle.campaign} on ${bundle.contract}`
    : `\n${failed.length} of ${checks.length} checks failed`,
);
console.log('Not checked here: the Intel TDX and NVIDIA quotes inside the attestation report (needs DCAP collateral).');
process.exit(failed.length === 0 ? 0 : 1);
