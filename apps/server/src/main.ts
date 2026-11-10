import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { challengeSeed, dailySeed, isChallengeCode, isUtcDay, utcDay, type OrderSet, type Treaty } from '@realm-ledger/rules';
import { config } from './config.ts';
import type { Goal } from '@realm-ledger/rules';
import { challengeBoard, challengeExists, confirmTreaty, createCampaign, dailyBoard, GameError, list, loadAll, proof, publicView, reconcileAll, revealSeason, runChancellor, sealSeason, sendEnvoy, sweepAbandoned } from './host.ts';
import { nearAiEnabled } from './nearai.ts';
import { healthMonitor } from './health.ts';
import { RPCS } from './chain.ts';

const health = healthMonitor({ urls: RPCS });

// Small JSON API for the game. No framework: a handful of routes.
//   GET  /api/health
//   GET  /api/campaigns?ids=&player=         recent campaigns, or just these ids / this ruler's
//   GET  /api/daily?date=      the daily challenge's board (today, UTC, by default)
//   GET  /api/challenge/:code  a challenge between friends: its board
//                              (POST /api/campaigns {challenge: true} starts one, {challenge: code} joins it)
//   POST /api/campaigns        {realms, seasons, player?, quick?, daily?, challenge?}  start a campaign (you play realm 0;
//                              `challenge`: true starts a challenge between friends, a code joins one; not with `daily`;
//                              `daily`: today's challenge, a quick match on the day's map;
//                              `quick`: a smaller map, for a short match;
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

  // Always 200 while the server answers (so a probe never restarts it over a balance); `level` says
  // whether the chain side will last: the contract's free storage NEAR, the referee, every seat's gas.
  if (parts[1] === 'health') return send(res, 200, { ...(await health()), model: config.nearAi.model, nearAi: nearAiEnabled() });

  // the daily challenge's board, for today unless ?date=YYYY-MM-DD
  if (parts[1] === 'daily' && parts.length === 2 && req.method === 'GET') {
    const asked = url.searchParams.get('date');
    // a real calendar day within the last month (dailies older than that aren't kept on boards), else today
    const now = Date.now();
    const today = utcDay(now);
    const recent = (d: string): boolean => d <= today && now - Date.parse(`${d}T00:00:00Z`) < 31 * 86_400_000;
    const date = asked && isUtcDay(asked) && recent(asked) ? asked : today;
    // `today` by the server's clock, so the page and the board agree about which day it is
    return send(res, 200, { date, today: date === today, seed: dailySeed(date), entries: dailyBoard(date, now) });
  }
  // a challenge's board: everyone who played the map its code names
  if (parts[1] === 'challenge' && parts.length === 3 && req.method === 'GET') {
    const code = parts[2]!;
    if (!isChallengeCode(code) || !challengeExists(code)) return send(res, 404, { error: 'no such challenge' });
    return send(res, 200, { code, seed: challengeSeed(code), entries: challengeBoard(code) });
  }
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
      const h = await createCampaign(Number(b.realms ?? 4), Number(b.seasons ?? 20), typeof b.player === 'string' && b.player ? b.player : undefined, b.quick === true, b.daily === true, b.challenge === true || typeof b.challenge === 'string' ? (b.challenge as true | string) : undefined);
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
    await revealSeason(id, (b.orders as OrderSet | undefined) ?? null, typeof b.salt === 'string' ? b.salt : null, b.forfeit === true);
    // the season's events, as the player may see them, are in the view's lastEvents
    return send(res, 200, { view: publicView(id) });
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
// every 10 minutes, and once a minute after starting (so a host that restarts often still
// sweeps); overlapping sweeps skip themselves
const sweep = (): void => void sweepAbandoned().catch((e: unknown) => console.error(`sweep: ${(e as Error).message}`));
setInterval(sweep, 10 * 60_000).unref();
setTimeout(sweep, 60_000).unref();
server.listen(config.port, () => {
  console.log(`realm-ledger server on :${config.port} (${n} campaigns loaded, contract ${config.contract}, NEAR AI ${nearAiEnabled() ? config.nearAi.model : 'off'})`);
});
