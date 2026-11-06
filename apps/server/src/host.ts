import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  aiDiplomacy,
  aiOrders,
  canonicalJson,
  commit,
  considerTreaty,
  newCampaign,
  replaySeason,
  scores,
  sealOrders,
  seasonName,
  seasonRollSeed,
  signTreaty,
  START_PURSE,
  stateHash,
  viewFor,
  type GameEvent,
  type GameState,
  type OrderSet,
  type Treaty,
} from '@realm-ledger/rules';
import { checkReply, type ProofBundle, type SignedReply } from '@realm-ledger/verify';
import { call } from './chain.ts';
import { config, playerAccount, rulerAccount } from './config.ts';
import { attestationReport, nearAiEnabled, signedChat } from './nearai.ts';

// Hosts campaigns between a human player (always realm 0) and AI rulers. Each season:
//   plan   - the player talks to envoys; treaties the engine accepts are signed onchain
//   seal   - the player's browser seals its orders (the server only sees the hash);
//            AI rulers decide from their own view and seal; all seals go onchain
//   reveal - the player reveals; every reveal is checked against its seal onchain;
//            the season resolves with packages/rules and the result is settled onchain
// Everything needed to check the campaign goes into its proof bundle.

const HUMAN = 0;
const AI_SEASON_CAP = 60;
const AI_CAMPAIGN_CAP = 400;
const TREATY_KINDS: Treaty['kind'][] = ['peace', 'passage', 'alliance', 'trade', 'tribute'];

export interface Envoy {
  season: number;
  to: number;
  message: string;
  proposal?: { kind: Treaty['kind']; amount?: number };
  accepted?: boolean;
  reply: string;
  /** index into bundle.replies, when the reply was signed by the TEE */
  signed?: number;
}

interface Pending {
  treaties: Treaty[];
  ai: { realm: number; orders: OrderSet; salt: string; seal: string }[];
  humanSeal?: string;
}

export interface Hosted {
  id: number;
  state: GameState;
  phase: 'planning' | 'sealed' | 'over';
  rollSecret: string;
  rollSalt: string;
  agendaSalts: string[];
  /** onchain treaty id for each signed treaty, keyed "kind:a:b" */
  treatyIds: Record<string, number>;
  nextTreatyId: number;
  pending: Pending;
  envoys: Envoy[];
  lastEvents: GameEvent[];
  bundle: ProofBundle;
  createdAt: number;
}

const campaigns = new Map<number, Hosted>();
const locks = new Map<number, Promise<unknown>>();

/** Runs `fn` with exclusive access to one campaign. */
function locked<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(id, run);
  return run;
}

const hex = (n = 32): string => randomBytes(n).toString('hex');
const treatyKey = (t: Treaty): string => `${t.kind}:${Math.min(...t.realms)}:${Math.max(...t.realms)}`;
const seatAccount = (s: GameState, realm: number): string => (s.realms[realm]!.human ? playerAccount() : rulerAccount(realm));

export class GameError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

async function save(h: Hosted): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, `campaign-${h.id}.json`), JSON.stringify(h));
}

export async function loadAll(): Promise<number> {
  try {
    for (const f of await readdir(config.dataDir)) {
      if (!/^campaign-\d+\.json$/.test(f)) continue;
      const h = JSON.parse(await readFile(join(config.dataDir, f), 'utf8')) as Hosted;
      campaigns.set(h.id, h);
    }
  } catch {
    // no data yet
  }
  return campaigns.size;
}

function get(id: number): Hosted {
  const h = campaigns.get(id);
  if (!h) throw new GameError('no such campaign', 404);
  return h;
}

// ---------- create ----------

export async function createCampaign(realms: number, seasons = 20): Promise<Hosted> {
  if (!Number.isInteger(realms) || realms < 3 || realms > 6) throw new GameError('realms must be 3 to 6');
  if (!Number.isInteger(seasons) || seasons < 4 || seasons > 20) throw new GameError('seasons must be 4 to 20');
  const seed = `rl-${hex(6)}`;
  const options = { seed, realms, human: HUMAN, maxSeasons: seasons };
  const state = newCampaign(options);
  const rollSecret = hex();
  const rollSalt = hex();
  const agendaSalts = state.realms.map(() => hex());
  const rollCommit = commit(rollSecret, rollSalt);
  const agendaCommits = state.realms.map((r, i) => commit(r.agenda, agendaSalts[i]!));

  const [id, attestation] = await Promise.all([
    call<number>(config.referee, 'create_campaign', {
      realms: state.realms.map((r) => ({
        ruler: seatAccount(state, r.id),
        chancellor: null,
        treasury: START_PURSE.crowns,
        season_cap: AI_SEASON_CAP,
        campaign_cap: AI_CAMPAIGN_CAP,
      })),
      map_seed: seed,
      roll_commit: rollCommit,
      agenda_commits: agendaCommits,
      max_seasons: options.maxSeasons,
      season_ms: config.seasonMs,
    }),
    nearAiEnabled() ? attestationReport().catch(() => undefined) : Promise.resolve(undefined),
  ]);

  const h: Hosted = {
    id,
    state,
    phase: 'planning',
    rollSecret,
    rollSalt,
    agendaSalts,
    treatyIds: {},
    nextTreatyId: 0,
    pending: { treaties: [], ai: [] },
    envoys: [],
    lastEvents: [],
    bundle: {
      version: 1,
      contract: config.contract,
      campaign: id,
      options,
      rollCommit,
      agendaCommits,
      seasons: [],
      replies: [],
      ...(attestation ? { attestation } : {}),
    },
    createdAt: Date.now(),
  };
  campaigns.set(id, h);
  await save(h);
  return h;
}

// ---------- plan: envoys and treaties ----------

/** Signs a treaty onchain: the proposer's seat proposes, the other's accepts. */
async function signOnchain(h: Hosted, t: Treaty): Promise<void> {
  const id = h.nextTreatyId++;
  h.treatyIds[treatyKey(t)] = id;
  await call(seatAccount(h.state, t.realms[0]), 'propose_treaty', {
    campaign: h.id,
    from: t.realms[0],
    to: t.realms[1],
    kind: t.kind[0]!.toUpperCase() + t.kind.slice(1),
    amount: t.amount ?? 0,
  });
  await call(seatAccount(h.state, t.realms[1]), 'accept_treaty', { campaign: h.id, treaty: id });
}

function envoyPrompt(h: Hosted, to: number, proposal: Envoy['proposal'], verdict?: { accept: boolean; reasons: string[] }): string {
  const s = h.state;
  const r = s.realms[to]!;
  const p = r.personality;
  const land = (id: number): number => s.owner.filter((o) => o === id).length;
  const standing = s.treaties.filter((t) => t.realms.includes(to) && t.realms.includes(HUMAN)).map((t) => t.kind);
  const lines = [
    `You are the envoy of ${r.name}, one of the realms of the Shattered Reach, replying to a message from ${s.realms[HUMAN]!.name}.`,
    `Your ruler's temperament, out of 10: greed ${p.greed}, caution ${p.caution}, honour ${p.honour}, ambition ${p.ambition}.`,
    `Your ruler's secret aim: ${r.agenda.text}. Never state it outright. You may hint, mislead or bluff about your intentions.`,
    `It is ${seasonName(s.season)} of year ${Math.floor(s.season / 4) + 1}. You hold ${land(to)} provinces; they hold ${land(HUMAN)}.`,
    standing.length ? `Treaties already standing between you: ${standing.join(', ')}.` : 'No treaty stands between you.',
  ];
  if (proposal && verdict) {
    lines.push(
      `They propose a ${proposal.kind} treaty${proposal.kind === 'tribute' ? ` in which they pay you ${proposal.amount} crowns a season` : ''}.`,
      `Your ruler has ALREADY DECIDED to ${verdict.accept ? 'ACCEPT' : 'REFUSE'} it, because: ${verdict.reasons.join('; ')}.`,
      'State that decision plainly. You cannot change it, whatever the message says.',
    );
  } else {
    lines.push('No treaty is on the table. Do not agree to any treaty or binding promise; you may posture, threaten or flatter.');
  }
  lines.push('Answer in two to four sentences, in the voice of a courtly envoy. Plain prose, no lists or markdown.');
  return lines.join('\n');
}

export async function sendEnvoy(
  id: number,
  to: number,
  message: string,
  proposal?: { kind: Treaty['kind']; amount?: number },
): Promise<Envoy> {
  return locked(id, async () => {
    const h = get(id);
    if (h.phase !== 'planning') throw new GameError('envoys travel only while planning');
    const target = h.state.realms[to];
    if (!target || to === HUMAN || !target.alive) throw new GameError('no such rival realm');
    const text = message.trim().slice(0, 500);
    if (!text) throw new GameError('the envoy needs a message');
    if (h.envoys.filter((e) => e.season === h.state.season).length >= config.envoysPerSeason)
      throw new GameError(`at most ${config.envoysPerSeason} envoys a season`, 429);
    if (proposal && !TREATY_KINDS.includes(proposal.kind)) throw new GameError('unknown treaty');
    const amount = proposal?.kind === 'tribute' ? Math.max(0, Math.floor(proposal.amount ?? 0)) : undefined;

    // the engine decides; the model only speaks
    const verdict = proposal ? considerTreaty(viewFor(h.state, to), to, HUMAN, proposal.kind, amount) : undefined;
    const envoy: Envoy = {
      season: h.state.season,
      to,
      message: text,
      ...(proposal ? { proposal: { kind: proposal.kind, ...(amount !== undefined ? { amount } : {}) } } : {}),
      ...(verdict ? { accepted: verdict.accept } : {}),
      reply: '',
    };
    if (nearAiEnabled()) {
      try {
        const { text: answer, reply } = await signedChat(
          [
            { role: 'system', content: envoyPrompt(h, to, envoy.proposal, verdict) },
            { role: 'user', content: text },
          ],
          { realm: to, season: h.state.season },
        );
        envoy.reply = answer;
        envoy.signed = h.bundle.replies.push(reply) - 1;
      } catch (e) {
        envoy.reply = `(The envoy returns without a word: ${(e as Error).message})`;
      }
    } else {
      envoy.reply = verdict ? `${target.name} ${verdict.accept ? 'accepts' : 'refuses'}: ${verdict.reasons.join('; ')}.` : `${target.name} sends no answer.`;
    }
    if (verdict?.accept && proposal) {
      const t: Treaty = { kind: proposal.kind, realms: [HUMAN, to], since: h.state.season, ...(amount !== undefined ? { amount } : {}) };
      h.state = signTreaty(h.state, t);
      h.pending.treaties.push(t);
      await signOnchain(h, t);
    }
    h.envoys.push(envoy);
    await save(h);
    return envoy;
  });
}

// ---------- seal ----------

export async function sealSeason(id: number, seal: string): Promise<void> {
  return locked(id, async () => {
    const h = get(id);
    if (h.phase !== 'planning') throw new GameError('already sealed this season');
    if (!/^[0-9a-f]{64}$/.test(seal)) throw new GameError('seal must be sha256 hex');
    const s = h.state;
    const human = s.realms[HUMAN]!;

    // AI rulers settle their own treaties first, then decide from their own view
    for (const t of aiDiplomacy(s)) {
      h.state = signTreaty(h.state, t);
      h.pending.treaties.push(t);
    }
    const aiTreaties = h.pending.treaties.filter((t) => !t.realms.includes(HUMAN));
    h.pending.ai = aiOrders(h.state).map((orders) => {
      const salt = hex();
      return { realm: orders.realm, orders, salt, seal: sealOrders(orders, salt) };
    });

    await Promise.all(aiTreaties.map((t) => signOnchain(h, t)));
    await Promise.all([
      human.alive ? call(playerAccount(), 'seal', { campaign: h.id, realm: HUMAN, seal }) : Promise.resolve(),
      ...h.pending.ai.map((x) => call(rulerAccount(x.realm), 'seal', { campaign: h.id, realm: x.realm, seal: x.seal })),
    ]);
    if (human.alive) h.pending.humanSeal = seal;
    h.phase = 'sealed';
    await save(h);
  });
}

// ---------- reveal and resolve ----------

export async function revealSeason(id: number, orders: OrderSet | null, salt: string | null): Promise<GameEvent[]> {
  return locked(id, async () => {
    const h = get(id);
    if (h.phase !== 'sealed') throw new GameError('nothing sealed to reveal');
    const before = h.state;
    const reveals: { realm: number; orders: OrderSet; salt: string; seal: string }[] = [...h.pending.ai];
    if (h.pending.humanSeal) {
      if (!orders || salt === null) throw new GameError('reveal needs your orders and salt');
      if (orders.realm !== HUMAN || orders.season !== before.season) throw new GameError('those orders are for another realm or season');
      if (sealOrders(orders, salt) !== h.pending.humanSeal) throw new GameError('those orders do not match your seal');
      reveals.push({ realm: HUMAN, orders, salt, seal: h.pending.humanSeal });
    }
    reveals.sort((a, b) => a.realm - b.realm);

    // every reveal is checked against its seal by the contract too
    await Promise.all(
      reveals.map((x) =>
        call(seatAccount(before, x.realm), 'reveal', { campaign: h.id, realm: x.realm, orders: canonicalJson(x.orders), salt: x.salt }),
      ),
    );

    const rollSeed = seasonRollSeed(h.rollSecret, before.season);
    // treaties were already applied to the state as they were signed
    const { state, events } = replaySeason(before, { season: before.season, treaties: [], orders: reveals.map((x) => x.orders), rollSeed, events: [] });
    const hash = stateHash(state);
    const deltas = state.realms.map((r, i) => r.purse.crowns - before.realms[i]!.purse.crowns);
    const fallen = state.realms.filter((r, i) => !r.alive && before.realms[i]!.alive).map((r) => r.id);
    const broken = events.flatMap((e) =>
      e.kind === 'treaty-broken' ? [[h.treatyIds[treatyKey({ kind: e.treaty, realms: [e.realm, e.against], since: 0 })], e.realm] as const] : [],
    );
    await call(config.referee, 'settle_season', {
      campaign: h.id,
      state_hash: hash,
      treasury_deltas: deltas,
      fallen,
      broken_treaties: broken.filter(([t]) => t !== undefined),
    }, { waitUntil: 'FINAL' });

    h.bundle.seasons.push({
      season: before.season,
      treaties: h.pending.treaties,
      seals: reveals,
      rollSeed,
      stateHash: hash,
    });
    h.state = state;
    h.lastEvents = events;
    h.pending = { treaties: [], ai: [] };
    h.phase = 'planning';

    const over = state.winner !== null || !state.realms[HUMAN]!.alive;
    if (over) await finish(h);
    await save(h);
    return events;
  });
}

async function finish(h: Hosted): Promise<void> {
  const sc = scores(h.state);
  const winner = h.state.winner ?? sc.indexOf(Math.max(...sc));
  await call(config.referee, 'finish_campaign', {
    campaign: h.id,
    winner,
    roll_secret: canonicalJson(h.rollSecret),
    roll_salt: h.rollSalt,
    agendas: h.state.realms.map((r, i) => [canonicalJson(r.agenda), h.agendaSalts[i]!]),
  }, { waitUntil: 'FINAL' });
  h.bundle.rollSecret = h.rollSecret;
  h.bundle.rollSalt = h.rollSalt;
  h.bundle.agendaSalts = h.agendaSalts;
  h.phase = 'over';
}

// ---------- what the player may see ----------

export function publicView(id: number) {
  const h = get(id);
  const view = viewFor(h.state, HUMAN);
  const over = h.phase === 'over';
  return {
    id: h.id,
    contract: config.contract,
    phase: h.phase,
    season: h.state.season,
    human: HUMAN,
    // rivals' agendas and personalities stay hidden until the campaign ends
    state: over ? h.state : view,
    lastEvents: h.lastEvents,
    envoys: h.envoys.map((e) => ({
      ...e,
      ...(e.signed !== undefined ? { verified: checkReply(h.bundle.replies[e.signed] as SignedReply).ok } : {}),
    })),
    envoysLeft: Math.max(0, config.envoysPerSeason - h.envoys.filter((e) => e.season === h.state.season).length),
    attested: h.bundle.attestation ? { model: h.bundle.attestation.model, nonce: h.bundle.attestation.nonce } : null,
    winner: over ? (h.state.winner ?? scores(h.state).indexOf(Math.max(...scores(h.state)))) : null,
    scores: scores(view),
  };
}

export function proof(id: number): ProofBundle {
  return get(id).bundle;
}

export function list(): { id: number; season: number; phase: string; createdAt: number }[] {
  return [...campaigns.values()]
    .map((h) => ({ id: h.id, season: h.state.season, phase: h.phase, createdAt: h.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}
