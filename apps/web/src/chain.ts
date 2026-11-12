// Read-only view of the realm contract on testnet, straight from public RPC.

export const CONTRACT = 'realm-ledger.testnet';
// public testnet RPCs, tried in turn: one may rate-limit or be down
const RPCS = ['https://test.rpc.fastnear.com', 'https://testnet-rpc.intea.rs', 'https://near-testnet.drpc.org'];

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

export async function view<T>(method: string, args: object): Promise<T | null> {
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 'realm-ledger-web',
    method: 'query',
    params: {
      request_type: 'call_function',
      // optimistic: our own writes show up as soon as they execute
      finality: 'optimistic',
      account_id: CONTRACT,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  });
  // the first provider that answers at all (a contract error is an answer too); rate limits and
  // outages move on to the next
  let res: Response | null = null;
  let lastError: unknown = null;
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request, signal: AbortSignal.timeout(10_000) });
      if (r.status === 429 || r.status >= 500) {
        lastError = new Error(`${rpc}: HTTP ${r.status}`);
        continue;
      }
      res = r;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!res) throw lastError instanceof Error ? lastError : new Error('RPC unreachable');
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
