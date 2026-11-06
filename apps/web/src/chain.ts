// Read-only view of the realm contract on testnet, straight from public RPC.

export const CONTRACT = 'realm-ledger.testnet';
const RPC = 'https://test.rpc.fastnear.com';

export interface ChainCampaign {
  id: number;
  referee: string;
  map_seed: string;
  phase: string;
  season: number;
  max_seasons: number;
  realms: { ruler: string; treasury: number; alive: boolean }[];
  state_hashes: string[];
  roll_commit: string;
  winner: number | null;
  treaties: unknown[];
}

async function view<T>(method: string, args: object): Promise<T | null> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'realm-ledger-web',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: CONTRACT,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(body.error?.cause?.name ?? body.result?.error ?? 'RPC error');
  const bytes = new Uint8Array(body.result.result as number[]);
  return JSON.parse(new TextDecoder().decode(bytes)) as T | null;
}

/** All campaigns, newest first. Campaign ids are sequential from 0. */
export async function campaigns(max = 64): Promise<ChainCampaign[]> {
  const out: ChainCampaign[] = [];
  for (let start = 0; start < max; start += 8) {
    const batch = await Promise.all(
      Array.from({ length: 8 }, (_, i) => view<ChainCampaign>('get_campaign', { campaign: start + i })),
    );
    for (const c of batch) if (c) out.push(c);
    if (batch.some((c) => c === null)) break;
  }
  return out.reverse();
}
