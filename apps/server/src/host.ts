import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  aiDiplomacy,
  aiMarket,
  aiOrders,
  applyDeal,
  planDeals,
  planTask,
  reportHolds,
  sha256Hex,
  spyReport,
  type Deal,
  type Goal,
  type Plan,
  type SpyReport,
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
import { checkReply, type MarketJob, type ProofBundle, type SignedReply } from '@realm-ledger/verify';
import { call, view } from './chain.ts';
import { chancellorAccount, companyAccount, config, playerAccount, rulerAccount } from './config.ts';
import { attestationReport, nearAiEnabled, signedChat } from './nearai.ts';

// Hosts campaigns between a human player (always realm 0) and AI rulers. Each season:
//   plan   - the player talks to envoys; treaties the engine accepts are signed onchain
//   seal   - the player's browser seals its orders (the server only sees the hash);
//            AI rulers decide from their own view and seal; all seals go onchain
//   reveal - the player reveals; every reveal is checked against its seal onchain;
//            the season resolves with packages/rules and the result is settled onchain
// Everything needed to check the campaign goes into its proof bundle.

const HUMAN = 0;
/** every ruler's own spending caps, enforced by the contract */
const SEASON_CAP = 150;
const CAMPAIGN_CAP = 1500;
/** Chancellor tasks a player may give per season */
const TASKS_PER_SEASON = 2;
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

/** A hire held in escrow until the season turns and the buyer checks the work. */
interface OpenJob {
  job: number;
  deal: Extract<Deal, { kind: 'mercs' | 'spy' }>;
  buyer: string;
}

interface Pending {
  treaties: Treaty[];
  /** market deals (and refunds) applied this season, in order */
  deals: Deal[];
  jobs: OpenJob[];
  /** AI rulers have done their shopping this season */
  aiHired?: boolean;
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
  /** Chancellor tasks and their plans */
  plans: { season: number; text: string; plan: Plan; jobs: number[] }[];
  /** spy reports delivered to the player, with the Chancellor's verdict */
  reports: { season: number; job: number; report: SpyReport; passed: boolean }[];
  /** total the Chancellor has been allowed to spend, for its onchain campaign cap */
  chancellorBudget: number;
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
      // campaigns from before the agent market
      h.plans ??= [];
      h.reports ??= [];
      h.chancellorBudget ??= 0;
      h.pending.deals ??= [];
      h.pending.jobs ??= [];
      h.state.companies ??= [];
      h.state.lastBattles ??= 0;
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
        chancellor: r.id === HUMAN ? chancellorAccount() : null,
        treasury: START_PURSE.crowns,
        season_cap: SEASON_CAP,
        campaign_cap: CAMPAIGN_CAP,
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
    pending: { treaties: [], deals: [], jobs: [], ai: [] },
    envoys: [],
    lastEvents: [],
    plans: [],
    reports: [],
    chancellorBudget: 0,
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
  // the contract numbers treaties; use the id it returns, since proposals sent in
  // parallel can land in any order
  const id = await call<number>(seatAccount(h.state, t.realms[0]), 'propose_treaty', {
    campaign: h.id,
    from: t.realms[0],
    to: t.realms[1],
    kind: t.kind[0]!.toUpperCase() + t.kind.slice(1),
    amount: t.amount ?? 0,
  });
  await call(seatAccount(h.state, t.realms[1]), 'accept_treaty', { campaign: h.id, treaty: id });
  h.treatyIds[treatyKey(t)] = id;
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
    for (const t of h.pending.aiHired ? [] : aiDiplomacy(s)) {
      h.state = signTreaty(h.state, t);
      h.pending.treaties.push(t);
    }
    const aiTreaties = h.pending.treaties.filter((t) => !t.realms.includes(HUMAN));
    // AI rulers buy swords with their own treasuries, through the contract's escrow;
    // each hire is saved at once, and a retried seal does not hire again
    for (const d of h.pending.aiHired ? [] : aiMarket(h.state)) {
      if (d.kind !== 'mercs' || d.price > SEASON_CAP) continue;
      try {
        const job = await hireOnchain(h, rulerAccount(d.realm), d, `${d.count} swords to ${h.state.map.provinces[d.province]!.name}`);
        h.state = applyDeal(h.state, d);
        h.pending.deals.push(d);
        h.pending.jobs.push({ job, deal: d, buyer: rulerAccount(d.realm) });
        await save(h);
      } catch (e) {
        console.warn(`AI hire skipped: ${(e as Error).message}`);
      }
    }
    h.pending.aiHired = true;
    h.pending.ai = aiOrders(h.state).map((orders) => {
      const salt = hex();
      return { realm: orders.realm, orders, salt, seal: sealOrders(orders, salt) };
    });

    await Promise.all(aiTreaties.filter((t) => h.treatyIds[treatyKey(t)] === undefined).map((t) => signOnchain(h, t)));
    const sealed = (realm: number) => async (): Promise<boolean> => !!(await view('get_seal', { campaign: h.id, season: s.season, realm }));
    await Promise.all([
      human.alive ? call(playerAccount(), 'seal', { campaign: h.id, realm: HUMAN, seal }, { done: sealed(HUMAN) }) : Promise.resolve(),
      ...h.pending.ai.map((x) => call(rulerAccount(x.realm), 'seal', { campaign: h.id, realm: x.realm, seal: x.seal }, { done: sealed(x.realm) })),
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
        call(
          seatAccount(before, x.realm),
          'reveal',
          { campaign: h.id, realm: x.realm, orders: canonicalJson(x.orders), salt: x.salt },
          { done: async () => !!(await view<{ revealed: boolean }>('get_seal', { campaign: h.id, season: before.season, realm: x.realm }))?.revealed },
        ),
      ),
    );

    const rollSeed = seasonRollSeed(h.rollSecret, before.season);
    // treaties and deals were already applied to the state as they were made
    const { state, events } = replaySeason(before, { season: before.season, treaties: [], deals: [], orders: reveals.map((x) => x.orders), rollSeed, events: [] });
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
    }, { waitUntil: 'FINAL', done: async () => ((await view<{ season: number }>('get_campaign', { campaign: h.id }))?.season ?? 0) > before.season });

    h.bundle.seasons.push({
      season: before.season,
      treaties: h.pending.treaties,
      deals: h.pending.deals,
      seals: reveals,
      rollSeed,
      stateHash: hash,
    });
    h.state = state;
    h.lastEvents = events;
    // workers deliver; buyers check the work against the resolved season and pay or refund
    const refunds = await closeJobs(h, state, before.season);
    for (const d of refunds) h.state = applyDeal(h.state, d);
    h.pending = { treaties: [], deals: refunds, jobs: [], ai: [] };
    h.phase = 'planning';

    const over = state.winner !== null || !state.realms[HUMAN]!.alive;
    if (over) await finish(h);
    await save(h);
    return events;
  });
}

// ---------- the agent market ----------

const JOB_KIND = { mercs: 'Mercenary', spy: 'Spy' } as const;

async function hireOnchain(h: Hosted, buyer: string, d: Extract<Deal, { kind: 'mercs' | 'spy' }>, spec: string): Promise<number> {
  const company = h.state.companies[d.company]!;
  return call<number>(buyer, 'hire', {
    campaign: h.id,
    realm: d.realm,
    worker: companyAccount(company),
    kind: JOB_KIND[d.kind],
    price: d.price,
    spec,
  });
}

/** Delivers and settles every open job of the season; returns refunds for failed work. */
async function closeJobs(h: Hosted, after: GameState, season: number): Promise<Deal[]> {
  const refunds: Deal[] = [];
  await Promise.all(
    h.pending.jobs.map(async (j) => {
      const company = after.companies[j.deal.company]!;
      const payload =
        j.deal.kind === 'spy'
          ? spyReport(after, j.deal.company, j.deal.province, season)
          : { province: j.deal.province, count: j.deal.count, season };
      const delivery = sha256Hex(canonicalJson(payload));
      const passed = j.deal.kind === 'spy' ? reportHolds(after, payload as SpyReport) : true;
      const where = after.map.provinces[j.deal.province]!.name;
      const note =
        j.deal.kind === 'spy'
          ? passed
            ? `report on ${where} matched the revealed season`
            : `report on ${where} did not match the revealed season; refunded`
          : `${j.deal.count} swords mustered at ${where}`;
      await call(companyAccount(company), 'deliver', { job: j.job, delivery });
      await call(j.buyer, 'settle_job', { job: j.job, passed, note });
      const record: MarketJob = { job: j.job, season, deal: j.deal, buyer: j.buyer, worker: companyAccount(company), payload, delivery, passed };
      h.bundle.jobs = [...(h.bundle.jobs ?? []), record];
      if (j.deal.realm === HUMAN && j.deal.kind === 'spy') h.reports.push({ season, job: j.job, report: payload as SpyReport, passed });
      if (!passed) refunds.push({ kind: 'refund', realm: j.deal.realm, amount: j.deal.price });
    }),
  );
  return refunds;
}

/** Reads a free-text task with the TEE model: which goal and which province. */
async function parseTask(h: Hosted, text: string): Promise<{ goal: Goal; province: number } | null> {
  if (!nearAiEnabled()) return null;
  const names = h.state.map.provinces.map((p) => p.name);
  const system = [
    'You read orders given to a royal chancellor in a strategy game and extract the task.',
    'Reply with one line of JSON and nothing else: {"goal":"hold"|"take"|"scout","province":"<name>"}.',
    'hold = defend one of our provinces; take = capture a province; scout = learn what stands in a province.',
    `The province must be one of these names, spelled exactly: ${names.join(', ')}.`,
    'If no province is named, use "province":null.',
  ].join('\n');
  const { text: out, reply } = await signedChat([{ role: 'system', content: system }, { role: 'user', content: text }], { realm: HUMAN, season: h.state.season }, 60);
  h.bundle.replies.push(reply);
  try {
    const j = JSON.parse(out.replace(/^[^{]*/, '').replace(/[^}]*$/, '')) as { goal?: string; province?: string | null };
    const goal = (['hold', 'take', 'scout'] as const).find((g) => g === j.goal);
    const province = names.findIndex((n) => n.toLowerCase() === String(j.province ?? '').toLowerCase());
    return goal && province >= 0 ? { goal, province } : null;
  } catch {
    return null;
  }
}

/**
 * The Chancellor: takes a task and a budget, plans with the rules engine, haggles once
 * per purchase, and hires through the contract within the cap the player sets onchain.
 */
export async function runChancellor(
  id: number,
  text: string,
  budget: number,
  explicit?: { goal: Goal; province: number },
): Promise<Hosted['plans'][number]> {
  return locked(id, async () => {
    const h = get(id);
    if (h.phase !== 'planning') throw new GameError('the Chancellor works while you plan');
    if (h.plans.filter((p) => p.season === h.state.season).length >= TASKS_PER_SEASON)
      throw new GameError(`at most ${TASKS_PER_SEASON} tasks a season`, 429);
    const crowns = h.state.realms[HUMAN]!.purse.crowns;
    budget = Math.floor(budget);
    if (!(budget >= 1 && budget <= crowns)) throw new GameError(`budget must be 1 to ${crowns} crowns (your treasury)`);
    const words = text.trim().slice(0, 300);
    const task = explicit && h.state.map.provinces[explicit.province] ? explicit : await parseTask(h, words);
    if (!task) throw new GameError('the Chancellor could not tell which province you mean; name it as it is on the map');

    const plan = planTask(viewFor(h.state, HUMAN), HUMAN, { ...task, budget });
    const deals = planDeals(plan, HUMAN);
    const jobs: number[] = [];
    if (deals.length > 0) {
      // the player raises the Chancellor's onchain cap by this task's budget
      const spentThisSeason = h.pending.jobs.filter((j) => j.buyer === chancellorAccount()).reduce((n, j) => n + j.deal.price, 0);
      h.chancellorBudget += budget;
      await call(playerAccount(), 'set_policy', {
        campaign: h.id,
        realm: HUMAN,
        spender: chancellorAccount(),
        season_cap: spentThisSeason + budget,
        campaign_cap: h.chancellorBudget,
      });
      for (const d of deals) {
        if (d.kind === 'refund') continue;
        const where = h.state.map.provinces[d.province]!.name;
        const spec = d.kind === 'mercs' ? `${d.count} swords to ${where}` : `a report on ${where} after the season turns`;
        const job = await hireOnchain(h, chancellorAccount(), d, spec);
        h.state = applyDeal(h.state, d);
        h.pending.deals.push(d);
        h.pending.jobs.push({ job, deal: d, buyer: chancellorAccount() });
        jobs.push(job);
        await save(h);
      }
    }
    const entry = { season: h.state.season, text: words || `${task.goal} ${h.state.map.provinces[task.province]!.name}`, plan, jobs };
    h.plans.push(entry);
    await save(h);
    return entry;
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
  }, { waitUntil: 'FINAL', done: async () => (await view<{ phase: string }>('get_campaign', { campaign: h.id }))?.phase === 'Finished' });
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
    companies: h.state.companies.map((c) => ({ id: c.id, name: c.name, kind: c.kind, greed: c.greed, base: c.base, size: c.size })),
    plans: h.plans,
    reports: h.reports,
    receipts: (h.bundle.jobs ?? []).filter((j) => j.deal.realm === HUMAN),
    openJobs: h.pending.jobs.filter((j) => j.deal.realm === HUMAN).map((j) => j.job),
    tasksLeft: Math.max(0, TASKS_PER_SEASON - h.plans.filter((p) => p.season === h.state.season).length),
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
