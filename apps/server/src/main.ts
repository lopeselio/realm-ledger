import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { OrderSet, Treaty } from '@realm-ledger/rules';
import { config } from './config.ts';
import type { Goal } from '@realm-ledger/rules';
import { confirmTreaty, createCampaign, GameError, list, loadAll, proof, publicView, reconcileAll, revealSeason, runChancellor, sealSeason, sendEnvoy, sweepAbandoned } from './host.ts';
import { nearAiEnabled } from './nearai.ts';

// Small JSON API for the game. No framework: a handful of routes.
//   GET  /api/health
//   GET  /api/campaigns?ids=&player=         recent campaigns, or just these ids / this ruler's
//   POST /api/campaigns        {realms, seasons, player?}  start a campaign (you play realm 0;
//                              with `player`, your own NEAR account rules it and signs its moves)
//   POST /api/campaigns/:id/treaty {treaty}  after proposing an accepted treaty from your wallet
//   GET  /api/campaigns/:id                  your view of it (fog of war applied)
//   POST /api/campaigns/:id/envoy {to, message, proposal?}
//   POST /api/campaigns/:id/chancellor {task, budget} or {goal, province, budget}
//   POST /api/campaigns/:id/seal  {seal}     sha256(canonical orders | salt), computed in your browser
//   POST /api/campaigns/:id/reveal {orders, salt} or {forfeit: true} (a wallet's after its onchain forfeit, a guest's after the reveal window)
//   GET  /api/campaigns/:id/proof            the proof bundle (pnpm verify:campaign <url>)

const MAX_BODY = 32 * 1024;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new GameError('request too large', 413);
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new GameError('body must be JSON');
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': config.corsOrigin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

// a coarse per-IP limit on campaign creation, since each one costs onchain gas
const created = new Map<string, number[]>();
function allowCreate(ip: string): boolean {
  const now = Date.now();
  const recent = (created.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= 6) return false;
  created.set(ip, [...recent, now]);
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'OPTIONS') return send(res, 204, null);
  if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });

  if (parts[1] === 'health') return send(res, 200, { ok: true, contract: config.contract, model: config.nearAi.model, nearAi: nearAiEnabled() });

  if (parts[1] !== 'campaigns') return send(res, 404, { error: 'not found' });
  if (parts.length === 2) {
    if (req.method === 'GET') {
      // ?ids=3,7 and ?player=alice.testnet: the campaigns a browser or a wallet can resume
      const ids = url.searchParams.get('ids');
      const player = url.searchParams.get('player');
      const filter = {
        ...(ids !== null ? { ids: ids.split(',').filter((x) => /^\d+$/.test(x)).slice(0, 50).map(Number) } : {}),
        ...(player ? { player } : {}),
      };
      return send(res, 200, list(filter).slice(0, 20));
    }
    if (req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '?';
      if (!allowCreate(ip)) throw new GameError('too many new campaigns from here; try again later', 429);
      const b = await body(req);
      const h = await createCampaign(Number(b.realms ?? 4), Number(b.seasons ?? 20), typeof b.player === 'string' && b.player ? b.player : undefined);
      return send(res, 201, publicView(h.id));
    }
  }
  const id = Number(parts[2]);
  if (!Number.isInteger(id)) return send(res, 404, { error: 'not found' });
  const action = parts[3];
  if (!action && req.method === 'GET') return send(res, 200, publicView(id));
  if (action === 'proof' && req.method === 'GET') return send(res, 200, proof(id));
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const b = await body(req);
  if (action === 'envoy') {
    const proposal = b.proposal as { kind: Treaty['kind']; amount?: number } | undefined;
    const envoy = await sendEnvoy(id, Number(b.to), String(b.message ?? ''), proposal);
    return send(res, 200, { envoy, view: publicView(id) });
  }
  if (action === 'treaty') {
    await confirmTreaty(id, Number(b.treaty));
    return send(res, 200, publicView(id));
  }
  if (action === 'chancellor') {
    const goal = b.goal as Goal | undefined;
    const explicit = goal && Number.isInteger(b.province) ? { goal, province: Number(b.province) } : undefined;
    const entry = await runChancellor(id, String(b.task ?? ''), Number(b.budget), explicit);
    return send(res, 200, { task: entry, view: publicView(id) });
  }
  if (action === 'seal') {
    await sealSeason(id, String(b.seal ?? ''));
    return send(res, 200, publicView(id));
  }
  if (action === 'reveal') {
    const events = await revealSeason(id, (b.orders as OrderSet | undefined) ?? null, typeof b.salt === 'string' ? b.salt : null, b.forfeit === true);
    return send(res, 200, { events, view: publicView(id) });
  }
  return send(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    if (e instanceof GameError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'the server stumbled; try again' });
  });
});

const n = await loadAll();
reconcileAll();
// every 10 minutes, one sweep at a time
let sweeping = false;
setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  void sweepAbandoned()
    .catch((e: unknown) => console.error(`sweep: ${(e as Error).message}`))
    .finally(() => {
      sweeping = false;
    });
}, 10 * 60_000).unref();
// and once a minute after starting, so a host that restarts often still sweeps
setTimeout(() => void sweepAbandoned().catch((e: unknown) => console.error(`sweep: ${(e as Error).message}`)), 60_000).unref();
server.listen(config.port, () => {
  console.log(`realm-ledger server on :${config.port} (${n} campaigns loaded, contract ${config.contract}, NEAR AI ${nearAiEnabled() ? config.nearAi.model : 'off'})`);
});
