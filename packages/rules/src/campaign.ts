import { decideOrders } from './ai.ts';
import { considerTreaty, proposeTreaties, signTreaty } from './diplomacy.ts';
import { resolveSeason } from './resolve.ts';
import { sha256Hex } from './seal.ts';
import { newCampaign, type CampaignOptions } from './setup.ts';
import { viewFor } from './state.ts';
import { aiHires, applyDeal } from './agents.ts';
import type { Deal, GameEvent, GameState, OrderSet, Treaty } from './types.ts';

export interface SeasonRecord {
  season: number;
  /** treaties signed during this season's planning, applied before it resolves */
  treaties: Treaty[];
  /** purchases from the agent market, applied before the season resolves */
  deals: Deal[];
  orders: OrderSet[];
  rollSeed: string;
  events: GameEvent[];
}

/**
 * Season roll seed, derived one-way from the campaign's roll secret (committed onchain at
 * campaign start, revealed at the end). Publishing one season's seed reveals nothing
 * about the secret or any other season.
 */
export const seasonRollSeed = (rollSecret: string, season: number): string => sha256Hex(`${rollSecret}|season|${season}`);

/** AI rulers propose treaties to each other; each target decides from its own view. */
export function aiDiplomacy(s: GameState): Treaty[] {
  const signed: Treaty[] = [];
  let state = s;
  for (const r of s.realms) {
    if (!r.alive || r.human) continue;
    for (const t of proposeTreaties(viewFor(state, r.id), r.id)) {
      const target = t.realms[1];
      if (s.realms[target]!.human) continue;
      if (considerTreaty(viewFor(state, target), target, r.id, t.kind, t.amount).accept) {
        signed.push(t);
        state = signTreaty(state, t);
      }
    }
  }
  return signed;
}

/** Applies a season record's treaties, then resolves its orders. */
export function replaySeason(s: GameState, h: SeasonRecord): ReturnType<typeof resolveSeason> {
  let state = s;
  for (const t of h.treaties) state = signTreaty(state, t);
  for (const d of h.deals ?? []) state = applyDeal(state, d);
  return resolveSeason(state, h.orders, { rollSeed: h.rollSeed });
}

/** AI rulers buy swords when threatened. */
export function aiMarket(s: GameState): Deal[] {
  return s.realms.filter((r) => r.alive && !r.human).flatMap((r) => aiHires(viewFor(s, r.id), r.id));
}

/** Every AI realm decides from its own view. */
export function aiOrders(s: GameState): OrderSet[] {
  return s.realms
    .filter((r) => r.alive && !r.human)
    .map((r) => ({ realm: r.id, season: s.season, orders: decideOrders(viewFor(s, r.id), r.id) }));
}

/** Plays a whole AI-only campaign. Used by the balance simulation and tests. */
export function runCampaign(opts: CampaignOptions & { rollSecret?: string }): { state: GameState; history: SeasonRecord[] } {
  let state = newCampaign({ ...opts, human: null });
  const rollSecret = opts.rollSecret ?? `${opts.seed}:rolls`;
  const history: SeasonRecord[] = [];
  while (state.winner === null) {
    const treaties = aiDiplomacy(state);
    for (const t of treaties) state = signTreaty(state, t);
    const deals = aiMarket(state);
    for (const d of deals) state = applyDeal(state, d);
    const orders = aiOrders(state);
    const rollSeed = seasonRollSeed(rollSecret, state.season);
    const { state: next, events } = resolveSeason(state, orders, { rollSeed });
    history.push({ season: state.season, treaties, deals, orders, rollSeed, events });
    state = next;
  }
  return { state, history };
}
