#!/usr/bin/env -S npx tsx
// pnpm verify:campaign <bundle.json | https://.../proof> [--no-chain]
// Checks a campaign's proof bundle and, unless --no-chain, compares it with the contract.

import { readFile } from 'node:fs/promises';
import { checkAgainstChain, verifyBundle, type Check, type ProofBundle } from './index.ts';

const RPC = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';

async function load(src: string): Promise<ProofBundle> {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
    return (await res.json()) as ProofBundle;
  }
  return JSON.parse(await readFile(src, 'utf8')) as ProofBundle;
}

function viewer(contract: string) {
  return async (method: string, args: object): Promise<unknown> => {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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
      }),
    });
    const body = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
    if (!body.result?.result) throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error ?? body)}`);
    return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
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
