// Kills the server in the middle of each onchain step that used to be able to leave its
// saved state behind the chain, restarts it, finishes the campaign, and runs every proof
// check, including that each onchain treasury equals the replayed crowns.
//   pnpm --filter @realm-ledger/server crashtest [point ...]
// Points: after-hire, after-treaty, after-seals, after-settle. Uses real testnet.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideOrders, newSalt, sealOrders, type GameState, type OrderSet } from '@realm-ledger/rules';
import { checkAgainstChain, verifyBundle, type ProofBundle } from '@realm-ledger/verify';

const PORT = 8788;
const base = `http://localhost:${PORT}`;
const dataDir = process.env.CRASHTEST_DATA ?? mkdtempSync(join(tmpdir(), 'realm-crash-'));
const points = process.argv.slice(2).filter((a) => a !== '--');
const all = points.length ? points : ['after-hire', 'after-treaty', 'after-seals', 'after-settle'];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type View = { id: number; season: number; phase: string; state: GameState; yourSeal: string | null };

function start(crashAt?: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--env-file-if-exists=../../.env', 'src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...(crashAt ? { REALM_CRASH_AT: crashAt } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => process.stdout.write(`    [server] ${d}`));
  child.stderr!.on('data', (d) => process.stdout.write(`    [server] ${d}`));
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      try {
        if ((await fetch(`${base}/api/health`)).ok) {
          clearInterval(t);
          resolve(child);
        }
      } catch {
        // not up yet
      }
    }, 300);
    child.on('exit', (code) => {
      clearInterval(t);
      reject(new Error(`server exited (${code}) before it was ready`));
    });
  });
}
const exited = (c: ChildProcess): Promise<number | null> => new Promise((r) => (c.exitCode !== null ? r(c.exitCode) : c.on('exit', r)));

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

const secrets: { orders: OrderSet; salt: string }[] = [];
async function seal(v: View): Promise<void> {
  const orders: OrderSet = { realm: 0, season: v.season, orders: decideOrders(v.state, 0) };
  const salt = newSalt();
  secrets.push({ orders, salt });
  await api(`/campaigns/${v.id}/seal`, { seal: sealOrders(orders, salt) });
}
async function reveal(v: View): Promise<View> {
  const secret = secrets.find((x) => sealOrders(x.orders, x.salt) === v.yourSeal);
  if (!secret) throw new Error('no secret matches the seal the server reports');
  return (await api<{ view: View }>(`/campaigns/${v.id}/reveal`, secret)).view;
}

/** Plays to the end from wherever the campaign stands. */
async function finish(id: number): Promise<View> {
  let v = await api<View>(`/campaigns/${id}`);
  while (v.phase !== 'over') {
    if (v.phase === 'planning') {
      await seal(v);
      v = await api<View>(`/campaigns/${id}`);
    }
    v = await reveal(v);
  }
  return v;
}

const rpcView = (contract: string) => async (method: string, args: object): Promise<unknown> => {
  const res = await fetch('https://test.rpc.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
  });
  const b = (await res.json()) as { result: { result: number[] } };
  return JSON.parse(Buffer.from(b.result.result).toString('utf8'));
};

let failures = 0;
for (const point of all) {
  console.log(`\n=== crash ${point} ===`);
  let server = await start();
  let v = await api<View>('/campaigns', { realms: 4, seasons: 4 });
  const id = v.id;
  console.log(`  campaign ${id}`);
  if (point === 'after-settle') {
    await seal(v);
    v = await api<View>(`/campaigns/${id}`);
  }
  server.kill();
  await exited(server);

  server = await start(point);
  const trigger =
    point === 'after-hire'
      ? api(`/campaigns/${id}/chancellor`, { goal: 'scout', province: v.state.realms[1]!.capital, budget: v.state.realms[0]!.purse.crowns })
      : point === 'after-treaty'
        ? api(`/campaigns/${id}/envoy`, { to: 1, message: 'Take our gold and leave our borders be.', proposal: { kind: 'tribute', amount: 6 } })
        : point === 'after-seals'
          ? seal(v)
          : reveal(v);
  const outcome = await Promise.race([trigger.then(() => 'completed', (e: Error) => `request failed: ${e.message}`), exited(server).then((c) => `server exited ${c}`)]);
  // the client sees the dropped connection a moment before the exit is reported
  const code = await Promise.race([exited(server), sleep(8000).then(() => 'still running')]);
  console.log(`  ${outcome}; server ${code === 'still running' ? 'still running' : `exited ${code}`}`);
  if (code === 'still running') {
    console.log(`  ✗ crash point ${point} was never reached (nothing to recover); stopping`);
    failures++;
    server.kill();
    await exited(server);
  }

  server = await start();
  await sleep(1500);
  const end = await finish(id);
  const bundle = await api<ProofBundle>(`/campaigns/${id}/proof`);
  server.kill();
  await exited(server);

  const checks = [...verifyBundle(bundle), ...(await checkAgainstChain(bundle, rpcView(bundle.contract)))];
  const bad = checks.filter((c) => !c.ok);
  const treasury = checks.find((c) => c.name.startsWith('every onchain treasury'));
  console.log(`  finished (phase ${end.phase}); ${checks.length} checks, ${bad.length} failed; ${treasury?.ok ? 'treasuries match ✓' : `treasuries ✗ ${treasury?.detail ?? ''}`}`);
  console.log(`  hires ${bundle.jobs?.length ?? 0}, treaties ${bundle.seasons.reduce((n, s) => n + s.treaties.length, 0)}`);
  for (const c of bad) console.log(`  ✗ ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  failures += bad.length;
}
console.log(failures ? `\n${failures} checks FAILED` : '\nall crash points recovered: every proof check passes');
process.exit(failures ? 1 : 0);
