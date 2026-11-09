// Plays a few seasons against a running server the way the browser does: sends an envoy
// with a treaty proposal, seals orders locally (the server only sees the hash), reveals,
// and finally checks the campaign's proof bundle against the chain.
//   pnpm --filter @realm-ledger/server playtest [server-url] [seasons]
import { decideOrders, newSalt, sealOrders, type GameState, type OrderSet } from '@realm-ledger/rules';
import { checkAgainstChain, verifyBundle, type ProofBundle } from '@realm-ledger/verify';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const seasons = Number(process.argv[3] ?? 2);

async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${data.error ?? res.status}`);
  return data;
}

type View = { id: number; season: number; phase: string; state: GameState; envoysLeft: number; winner: number | null; lastEvents: { kind: string }[] };
const t0 = Date.now();
const lap = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

let v = await api<View>('/campaigns', { realms: 4, seasons: Math.max(4, seasons) });
console.log(`campaign ${v.id} created onchain (${lap()})`);

const rival = v.state.realms.find((r) => r.id !== 0)!;
const { envoy } = await api<{ envoy: { reply: string; accepted?: boolean; signed?: number } }>(`/campaigns/${v.id}/envoy`, {
  to: rival.id,
  message: 'Our borders need not run red. Will you swear peace with us?',
  proposal: { kind: 'peace' },
});
console.log(`envoy to ${rival.name}: ${envoy.accepted ? 'ACCEPTED' : 'refused'} (${lap()})\n  "${envoy.reply}"`);

// a Chancellor task in plain words; the model reads it, the rules engine plans and prices it
const target = v.state.map.provinces[rival.capital]!.name;
type TaskReply = { task: { plan: { steps: { kind: string; quote: number; fair: number; price?: number; note: string; counter?: { offer: number; accepted: boolean } }[]; spent: number; summary: string[] }; jobs: number[] } };
const t = await api<TaskReply>(`/campaigns/${v.id}/chancellor`, { task: `Find out what guards ${target}, the capital of ${rival.name}.`, budget: 25 });
console.log(`chancellor: spent ${t.task.plan.spent} of 25 on ${t.task.jobs.length} hires (${lap()})`);
for (const st of t.task.plan.steps) console.log(`  ${st.kind}: quote ${st.quote}, fair ${st.fair}${st.counter ? `, countered ${st.counter.offer} (${st.counter.accepted ? 'taken' : 'refused'})` : ''} — ${st.note}`);
for (const line of t.task.plan.summary) console.log(`  ${line}`);

for (let i = 0; i < seasons; i++) {
  // the "player" here is the AI engine playing realm 0 from its own view
  const orders: OrderSet = { realm: 0, season: v.season, orders: decideOrders(v.state, 0) };
  const salt = newSalt();
  // a dropped connection doesn't mean the server didn't act: re-read the campaign and carry on
  await api(`/campaigns/${v.id}/seal`, { seal: sealOrders(orders, salt) }).catch(async (e: Error) => {
    const now = await api<View>(`/campaigns/${v.id}`);
    if (now.phase !== 'sealed') throw e;
    console.log(`  (connection dropped after sealing; the server had sealed, continuing)`);
  });
  console.log(`season ${v.season}: sealed ${orders.orders.length} orders (${lap()})`);
  const r = await api<{ view: View }>(`/campaigns/${v.id}/reveal`, { orders, salt }).catch(async (e: Error) => {
    const now = await api<View>(`/campaigns/${v.id}`);
    if (now.season === v.season) throw e;
    console.log(`  (connection dropped after revealing; the server had settled, continuing)`);
    return { view: now };
  });
  // the season as the player saw it (the reply carries it in the view)
  const count = (k: string): number => r.view.lastEvents.filter((e) => e.kind === k).length;
  console.log(`season ${v.season}: revealed and settled; ${count('battle')} battles, ${count('captured')} captures (${lap()})`);
  v = r.view;
}

const bundle = await api<ProofBundle>(`/campaigns/${v.id}/proof`);
const checks = [...verifyBundle(bundle)];
const view = async (method: string, args: object): Promise<unknown> => {
  const res = await fetch('https://test.rpc.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: bundle.contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    }),
  });
  const b = (await res.json()) as { result: { result: number[] } };
  return JSON.parse(Buffer.from(b.result.result).toString('utf8'));
};
checks.push(...(await checkAgainstChain(bundle, view)));
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
const finished = v.phase === 'over';
const bad = checks.filter((c) => !c.ok && (finished || c.name !== 'roll secret revealed'));
console.log(bad.length ? `\n${bad.length} checks FAILED` : `\nall proof checks pass${finished ? ', final reveal included' : ' (the roll secret stays hidden until the campaign ends)'} — ${lap()}`);
process.exit(bad.length ? 1 : 0);
