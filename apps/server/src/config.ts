import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

export const config = {
  port: Number(env('PORT', '8787')),
  corsOrigin: env('CORS_ORIGIN', '*'),
  dataDir: env('DATA_DIR', join(process.cwd(), 'data')),
  network: env('NEAR_NETWORK', 'testnet'),
  rpcUrl: env('NEAR_RPC_URL', 'https://test.rpc.fastnear.com'),
  contract: env('CONTRACT_ID', 'realm-ledger.testnet'),
  owner: env('OWNER_ID', 'realm-ledger.testnet'),
  referee: env('REFEREE_ID', 'realm-ledger-ops.testnet'),
  nearAi: {
    baseUrl: env('NEARAI_BASE_URL', 'https://cloud-api.near.ai/v1'),
    apiKey: process.env.NEARAI_API_KEY ?? '',
    // a model NEAR AI Cloud runs in a TEE, with attestation and per-reply signatures
    model: env('NEARAI_MODEL', 'Qwen/Qwen3.6-35B-A3B-FP8'),
  },
  /** how long rulers have to seal before the contract closes the season anyway */
  seasonMs: Number(env('SEASON_MS', String(6 * 3600_000))),
  /** envoys a player may send per season, to keep model calls bounded */
  envoysPerSeason: Number(env('ENVOYS_PER_SEASON', '4')),
};

/** Seat accounts: AI rulers sit in ruler0..ruler7; human players sign through `player`. */
export const rulerAccount = (seat: number): string => `ruler${seat}.${config.contract}`;
export const playerAccount = (): string => `player.${config.contract}`;

/**
 * Private keys. Hosted: AGENT_KEYS is a JSON map of account to "ed25519:..." key.
 * Locally: ~/.near-credentials/<network>/<account>.json (near CLI's legacy keychain).
 */
const hosted: Record<string, string> = process.env.AGENT_KEYS ? JSON.parse(process.env.AGENT_KEYS) : {};
export function privateKey(account: string): string {
  if (hosted[account]) return hosted[account]!;
  const file = join(homedir(), '.near-credentials', config.network, `${account}.json`);
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { private_key: string }).private_key;
  } catch {
    throw new Error(`no key for ${account} (set AGENT_KEYS or add ${file})`);
  }
}
