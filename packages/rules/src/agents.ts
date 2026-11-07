import { defenceBonus } from './battle.ts';
import { NEUTRAL, UPKEEP } from './constants.ts';
import { rng } from './rng.ts';
import { canonicalJson } from './seal.ts';
import { friendly, normaliseArmies, strength, troopCount, visibleProvinces } from './state.ts';
import type { Company, Deal, GameState, Order, SpyReport } from './types.ts';

// The agent market: mercenary companies and spy rings that sell to realms, and the
// Chancellor that buys from them for the player. Every price, haggle, report and check
// is decided here, deterministically, so a campaign replays exactly. Language models
// may phrase things; they never set a price or pass a check.

const MERC_NAMES = ['The Grey Lances', 'Company of the Broken Oath', 'The Saltwind Free Swords'];
const SPY_NAMES = ['The Quiet Ledger', 'Lantern Street Ring'];
/** what the Chancellor considers a fair peacetime price per sword, and per report */
export const FAIR_SWORD = 7;
export const FAIR_REPORT = 14;
/** the Chancellor pays at most this much over fair after a refused counter-offer */
const OVER_FAIR_PCT = 125;
/** an AI ruler fields at most this many hired swords */
const MAX_AI_MERCS = 8;

export function makeCompanies(seed: string): Company[] {
  const r = rng(seed, 'companies');
  const mercs = MERC_NAMES.slice(0, 2).map((name, i) => ({
    id: i,
    name,
    kind: 'mercs' as const,
    greed: r.range(2, 8),
    honesty: r.range(6, 9),
    base: 6 + r.int(3),
    size: 6 + r.int(5),
  }));
  const spies = SPY_NAMES.map((name, i) => ({
    id: mercs.length + i,
    name,
    kind: 'spy' as const,
    greed: r.range(2, 8),
    // one ring is reliable, the other is a coin toss
    honesty: i === 0 ? r.range(8, 9) : r.range(4, 6),
    base: 8 + r.int(5),
    size: 0,
  }));
  return [...mercs, ...spies];
}

/** Extra crowns per sword while wars rage. */
export const warPremium = (s: GameState): number => Math.min(6, s.lastBattles);

export function quoteMercs(s: GameState, c: Company, count: number): number {
  // a greed of 2 asks the base price; each point of greed adds a twelfth
  return Math.round((count * (c.base + warPremium(s)) * (10 + c.greed)) / 12);
}
export const fairMercs = (s: GameState, count: number): number => count * (FAIR_SWORD + warPremium(s));

export function quoteSpy(s: GameState, c: Company, province: number): number {
  return Math.round(((c.base + (s.towns[province] ? 2 : 0) + s.forts[province]!) * (10 + c.greed)) / 12);
}

/** A company takes a counter-offer if it is close enough to its quote; greedy ones concede less. */
export function acceptsCounter(c: Company, quote: number, offer: number): boolean {
  return offer >= Math.ceil((quote * (100 - (10 - c.greed) * 3)) / 100);
}

/** Applies a deal to the state (new state; input untouched). Throws if the deal is invalid. */
export function applyDeal(s: GameState, d: Deal): GameState {
  const next = structuredClone(s);
  const realm = next.realms[d.realm];
  if (!realm || !realm.alive) throw new Error(`deal for fallen or unknown realm ${d.realm}`);
  if (d.kind === 'refund') {
    realm.purse.crowns += d.amount;
    return next;
  }
  const c = next.companies[d.company];
  if (!c || c.kind !== d.kind) throw new Error(`no ${d.kind} company ${d.company}`);
  if (d.price <= 0 || realm.purse.crowns < d.price) throw new Error(`realm ${d.realm} cannot pay ${d.price}`);
  realm.purse.crowns -= d.price;
  if (d.kind === 'mercs') {
    if (next.owner[d.province] !== d.realm) throw new Error('mercenaries muster only in your own province');
    if (d.count < 1 || d.count > c.size) throw new Error(`${c.name} fields 1 to ${c.size} swords`);
    next.armies.push({ realm: d.realm, province: d.province, levies: 0, regulars: 0, mercs: d.count });
    normaliseArmies(next);
  }
  return next;
}

/** The truth about a province: each realm's troops there. */
function truth(s: GameState, province: number): SpyReport['armies'] {
  return s.armies
    .filter((a) => a.province === province)
    .map((a) => ({ realm: a.realm, troops: troopCount(a) }))
    .sort((a, b) => a.realm - b.realm);
}

/**
 * The spy's report on a province after the season resolved. Honest spies report the
 * truth; a dishonest one, as often as its honesty allows, sells a convenient fiction.
 */
export function spyReport(after: GameState, company: number, province: number, season: number): SpyReport {
  const c = after.companies[company]!;
  const real = truth(after, province);
  const honest = rng(after.seed, 'spy', company, province, season).int(10) < c.honesty;
  if (honest) return { company, province, season, armies: real };
  const lie =
    real.length > 0
      ? real.map((a) => ({ realm: a.realm, troops: Math.max(0, Math.floor(a.troops / 2)) })).filter((a) => a.troops > 0)
      : [{ realm: after.owner[province]! >= 0 ? after.owner[province]! : NEUTRAL, troops: 4 }];
  return { company, province, season, armies: lie };
}

/** Does a report match what really stood in the province? */
export const reportHolds = (after: GameState, r: SpyReport): boolean =>
  canonicalJson(truth(after, r.province)) === canonicalJson([...r.armies].sort((a, b) => a.realm - b.realm));

// ---------- AI rulers in the market ----------

/** AI rulers hire swords when a province of theirs is outmatched and the treasury allows. */
export function aiHires(view: GameState, me: number): Deal[] {
  const realm = view.realms[me]!;
  if (!realm.alive) return [];
  const hostile = (r: number): boolean => r !== me && r !== NEUTRAL && !friendly(view, me, r);
  let worst = -1;
  let gap = 0;
  for (let p = 0; p < view.owner.length; p++) {
    if (view.owner[p] !== me) continue;
    const near = view.map.provinces[p]!.neighbors.reduce(
      (n, q) => n + view.armies.filter((a) => a.province === q && hostile(a.realm)).reduce((m, a) => m + strength(a), 0),
      0,
    );
    const own = view.armies.filter((a) => a.province === p && a.realm === me).reduce((m, a) => m + strength(a), 0);
    if (near - own > gap) {
      gap = near - own;
      worst = p;
    }
  }
  if (worst < 0 || gap < 4) return [];
  const mine = view.armies.filter((a) => a.realm === me);
  const fielded = mine.reduce((n, a) => n + a.mercs, 0);
  if (fielded >= MAX_AI_MERCS) return [];
  const wages = mine.reduce((n, a) => n + a.regulars * UPKEEP.regulars + a.mercs * UPKEEP.mercs, 0);
  const reserve = 20 + realm.personality.caution * 2;
  const companies = view.companies.filter((c) => c.kind === 'mercs');
  let best: Deal | null = null;
  for (const c of companies) {
    let count = Math.min(c.size, Math.ceil(gap / 3), MAX_AI_MERCS - fielded);
    // swords draw pay every season: keep three seasons of all wages, old and new
    const affordable = (n: number): boolean => quoteMercs(view, c, n) + (wages + n * UPKEEP.mercs) * 3 <= realm.purse.crowns - reserve;
    while (count > 0 && !affordable(count)) count--;
    if (count === 0) continue;
    const price = quoteMercs(view, c, count);
    if (!best || price / count < best.price / (best as { count: number }).count)
      best = { kind: 'mercs', realm: me, company: c.id, province: worst, count, price };
  }
  return best ? [best] : [];
}

// ---------- the Chancellor ----------

export type Goal = 'hold' | 'take' | 'scout';

export interface Task {
  goal: Goal;
  province: number;
  budget: number;
}

export interface Step {
  kind: 'spy' | 'mercs';
  company: number;
  province: number;
  count?: number;
  quote: number;
  fair: number;
  /** the one counter-offer, with its reasoning */
  counter?: { offer: number; reason: string; accepted: boolean };
  /** what was paid; undefined if the Chancellor walked away */
  price?: number;
  note: string;
}

export interface Plan {
  task: Task;
  steps: Step[];
  /** orders the Chancellor recommends; the player approves or ignores them */
  advice: Order[];
  spent: number;
  summary: string[];
}

/** Haggle once: counter at the fair price if the quote is over it, then accept or walk away. */
function haggle(c: Company, quote: number, fair: number, budget: number, what: string): Pick<Step, 'counter' | 'price' | 'note'> {
  if (quote <= fair) {
    return quote <= budget ? { price: quote, note: `${quote} crowns is fair for ${what}; accepted` } : { note: `${quote} crowns is over the remaining budget of ${budget}` };
  }
  const offer = Math.min(fair, budget);
  const reason = `${quote} crowns for ${what} is ${Math.round((quote / fair - 1) * 100)}% over the going rate of ${fair}`;
  const accepted = acceptsCounter(c, quote, offer);
  if (accepted) return { counter: { offer, reason, accepted }, price: offer, note: `${c.name} took ${offer}` };
  const ceiling = Math.floor((fair * OVER_FAIR_PCT) / 100);
  if (quote <= ceiling && quote <= budget)
    return { counter: { offer, reason, accepted }, price: quote, note: `${c.name} refused ${offer}; ${quote} is within a quarter of fair, so the Chancellor paid it` };
  return { counter: { offer, reason, accepted }, note: `${c.name} refused ${offer}; ${quote} is too dear, so the Chancellor walked away` };
}

/**
 * Plans and prices a task from the player's own view: what to learn (a spy on hidden
 * ground), what to buy (swords), and what to order (advice the player approves).
 */
export function planTask(view: GameState, me: number, task: Task): Plan {
  const steps: Step[] = [];
  const advice: Order[] = [];
  const summary: string[] = [];
  let budget = Math.max(0, Math.floor(task.budget));
  const p = view.map.provinces[task.province];
  if (!p) return { task, steps, advice, spent: 0, summary: ['There is no such province.'] };
  const hostile = (r: number): boolean => r !== me && !friendly(view, me, r);
  const seen = visibleProvinces(view, me);
  const strengthAt = (q: number, f: (r: number) => boolean): number =>
    view.armies.filter((a) => a.province === q && f(a.realm)).reduce((n, a) => n + strength(a), 0);

  // 1. learn: a spy on the most worrying ground we cannot see
  const ground = task.goal === 'scout' ? [task.province] : [task.province, ...p.neighbors];
  const hidden = ground.filter((q) => !seen.has(q));
  const spyTarget =
    task.goal === 'scout' ? task.province : hidden.sort((a, b) => Number(view.owner[b]! >= 0 && hostile(view.owner[b]!)) - Number(view.owner[a]! >= 0 && hostile(view.owner[a]!)) || a - b)[0];
  if (spyTarget !== undefined) {
    const rings = view.companies.filter((c) => c.kind === 'spy');
    // the cheapest ring; the honest one wins ties
    const ring = [...rings].sort((a, b) => quoteSpy(view, a, spyTarget) - quoteSpy(view, b, spyTarget) || b.honesty - a.honesty)[0];
    if (ring) {
      const quote = quoteSpy(view, ring, spyTarget);
      const h = haggle(ring, quote, FAIR_REPORT, budget, `a report on ${view.map.provinces[spyTarget]!.name}`);
      steps.push({ kind: 'spy', company: ring.id, province: spyTarget, quote, fair: FAIR_REPORT, ...h });
      if (h.price) budget -= h.price;
    }
  } else if (task.goal !== 'scout') summary.push('Every province around it is in sight; no spy needed.');

  // 2. buy: swords to hold or take it
  if (task.goal !== 'scout') {
    let need: number;
    let muster: number | undefined;
    if (task.goal === 'hold') {
      if (view.owner[task.province] !== me) return { task, steps, advice, spent: task.budget - budget, summary: [...summary, `${p.name} is not ours to hold.`] };
      const threat = p.neighbors.reduce((n, q) => n + strengthAt(q, (r) => r !== NEUTRAL && hostile(r)) + (!seen.has(q) && hostile(view.owner[q]!) && view.owner[q]! >= 0 ? 6 : 0), 0);
      need = Math.ceil(threat * 1.2) - strengthAt(task.province, (r) => r === me);
      muster = task.province;
      summary.push(`Threat around ${p.name}: about ${threat} strength; we hold ${strengthAt(task.province, (r) => r === me)} there.`);
      if (view.forts[task.province]! < 3) advice.push({ kind: 'fortify', province: task.province });
    } else {
      const defence = Math.ceil((strengthAt(task.province, (r) => r !== me) * (10 + defenceBonus(view, task.province)) * 13) / 100);
      const from = p.neighbors.filter((q) => view.owner[q] === me).sort((a, b) => strengthAt(b, (r) => r === me) - strengthAt(a, (r) => r === me) || a - b)[0];
      if (from === undefined) return { task, steps, advice, spent: task.budget - budget, summary: [...summary, `We hold no province next to ${p.name} to attack from.`] };
      need = defence - strengthAt(from, (r) => r === me);
      muster = from;
      summary.push(`${p.name} looks defended by about ${defence} strength with its walls; we have ${strengthAt(from, (r) => r === me)} in ${view.map.provinces[from]!.name}.`);
      advice.push({ kind: 'march', from, to: task.province });
    }
    if (need > 0 && muster !== undefined) {
      const companies = view.companies.filter((c) => c.kind === 'mercs');
      const wanted = Math.ceil(need / 3);
      const options = companies
        .map((c) => {
          let count = Math.min(c.size, wanted);
          while (count > 0 && quoteMercs(view, c, count) > Math.floor((budget * OVER_FAIR_PCT) / 100)) count--;
          return { c, count };
        })
        .filter((o) => o.count > 0)
        .sort((a, b) => quoteMercs(view, a.c, a.count) / a.count - quoteMercs(view, b.c, b.count) / b.count || a.c.id - b.c.id);
      const pick = options[0];
      if (pick) {
        const quote = quoteMercs(view, pick.c, pick.count);
        const fair = fairMercs(view, pick.count);
        const h = haggle(pick.c, quote, fair, budget, `${pick.count} swords`);
        steps.push({ kind: 'mercs', company: pick.c.id, province: muster, count: pick.count, quote, fair, ...h });
        if (h.price) budget -= h.price;
        if (pick.count < wanted) summary.push(`We wanted ${wanted} swords; the budget stretched to ${pick.count}.`);
      } else summary.push(`No company would field swords within ${budget} crowns.`);
    } else summary.push('Our own troops suffice; no swords bought.');
  }
  return { task, steps, advice, spent: Math.floor(task.budget) - budget, summary };
}

/** The deals a plan commits to. */
export function planDeals(plan: Plan, me: number): Deal[] {
  return plan.steps.flatMap((s): Deal[] =>
    s.price === undefined
      ? []
      : s.kind === 'mercs'
        ? [{ kind: 'mercs', realm: me, company: s.company, province: s.province, count: s.count!, price: s.price }]
        : [{ kind: 'spy', realm: me, company: s.company, province: s.province, price: s.price }],
  );
}
