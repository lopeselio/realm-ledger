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
  // the first provider that answers for the contract (a result, or the contract's own error);
  // rate limits, outages, odd pages and a node's own faults move on to the next
  type RpcBody = { result?: { result?: number[]; error?: string }; error?: { name?: string; cause?: { name?: string } } };
  let body: RpcBody | null = null;
  let lastError: unknown = null;
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request, signal: AbortSignal.timeout(4_000) });
      const b = (await r.json()) as RpcBody;
      const said = JSON.stringify(b.error ?? '');
      if (b.result?.result || b.result?.error || /CONTRACT_EXECUTION_ERROR|UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|MethodNotFound|CodeDoesNotExist|panicked/.test(said)) {
        body = b;
        break;
      }
      lastError = new Error(`${rpc}: ${said.slice(0, 120) || `HTTP ${r.status}`}`);
    } catch (e) {
      lastError = e;
    }
  }
  if (!body) throw lastError instanceof Error ? lastError : new Error('RPC unreachable');
  if (body.error || body.result?.error) throw new Error(body.error?.cause?.name ?? body.result?.error ?? 'RPC error');
  const bytes = new Uint8Array(body.result?.result ?? []);
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
