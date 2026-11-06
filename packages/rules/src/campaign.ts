import { decideOrders } from './ai.ts';
import { resolveSeason } from './resolve.ts';
import { hash32 } from './rng.ts';
import { newCampaign, type CampaignOptions } from './setup.ts';
import { viewFor } from './state.ts';
import type { GameEvent, GameState, OrderSet } from './types.ts';

export interface SeasonRecord {
  season: number;
  orders: OrderSet[];
  rollSeed: string;
  events: GameEvent[];
}

/** Season roll seed derived from a campaign roll secret. The secret is committed at campaign start. */
export const seasonRollSeed = (rollSecret: string, season: number): string => `${rollSecret}:${season}:${hash32(rollSecret, season)}`;

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
    const orders = aiOrders(state);
    const rollSeed = seasonRollSeed(rollSecret, state.season);
    const { state: next, events } = resolveSeason(state, orders, { rollSeed });
    history.push({ season: state.season, orders, rollSeed, events });
    state = next;
  }
  return { state, history };
}
