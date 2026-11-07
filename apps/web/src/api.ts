// The game server's HTTP API (apps/server) and the campaign view it returns.
import type { Deal, GameEvent, GameState, Plan, SpyReport, Treaty } from '@realm-ledger/rules';

// Same origin by default: Vercel proxies /api/* to the server (vercel.json) and so does the
// Vite dev server (vite.config.ts), so no build needs the API on its CORS list.
// VITE_API_URL points a build at another server directly.
export const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
/** The server's public address, for commands you paste into a terminal (previews are login-protected). */
export const PUBLIC_API = API || 'https://realm-ledger-api.azurewebsites.net';

export interface Envoy {
  season: number;
  to: number;
  message: string;
  proposal?: { kind: Treaty['kind']; amount?: number };
  accepted?: boolean;
  reply: string;
  signed?: number;
  verified?: boolean;
}

export interface Company {
  id: number;
  name: string;
  kind: 'mercs' | 'spy';
  greed: number;
  base: number;
  size: number;
}

export interface ChancellorTask {
  season: number;
  text: string;
  plan: Plan;
  jobs: number[];
}

export interface Receipt {
  job: number;
  season: number;
  deal: Extract<Deal, { kind: 'mercs' | 'spy' }>;
  buyer: string;
  worker: string;
  passed: boolean;
}

export interface View {
  id: number;
  contract: string;
  phase: 'planning' | 'sealed' | 'over';
  season: number;
  human: number;
  state: GameState;
  lastEvents: GameEvent[];
  envoys: Envoy[];
  envoysLeft: number;
  attested: { model: string; nonce: string } | null;
  winner: number | null;
  scores: number[];
  companies: Company[];
  plans: ChancellorTask[];
  reports: { season: number; job: number; report: SpyReport; passed: boolean }[];
  receipts: Receipt[];
  openJobs: number[];
  tasksLeft: number;
  yourSeal: string | null;
  /** your own NEAR account, if you rule this campaign from a wallet */
  player: string | null;
  chancellor: string;
  proposeTreaty: { from: number; to: number; kind: Treaty['kind']; amount: number } | null;
}

export async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${API}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
