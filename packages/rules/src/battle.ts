import {
  FORT_DEFENCE,
  LOSER_LOSS_PCT,
  NEUTRAL,
  OUT_OF_SUPPLY,
  RIVER_DEFENCE,
  TERRAIN_DEFENCE,
  WINNER_MAX_LOSS_PCT,
} from './constants.ts';
import { rng } from './rng.ts';
import { strength } from './state.ts';
import type { GameState, Troops } from './types.ts';

export interface BattleSide {
  realm: number;
  troops: Troops;
  /** holds the province and fights from its walls and terrain */
  defending: boolean;
  /** none of its own provinces is here or next door */
  outOfSupply: boolean;
}

export interface BattleResult {
  winner: number;
  sides: { realm: number; power: number; roll: number; troopsBefore: Troops; troopsAfter: Troops }[];
}

/** Defence bonus in tenths for a side holding `province` (terrain, fort, river). */
export function defenceBonus(s: GameState, province: number): number {
  const p = s.map.provinces[province]!;
  return TERRAIN_DEFENCE[p.terrain] + s.forts[province]! * FORT_DEFENCE + (p.river ? RIVER_DEFENCE : 0);
}

/** A realm's side in a battle in `province`: whether it holds it, and whether it is cut off from its land. */
export function battleSide(s: GameState, province: number, realm: number, troops: Troops): BattleSide {
  const owner = s.owner[province]!;
  return {
    realm,
    troops,
    defending: realm === owner || (owner === -1 && realm === NEUTRAL),
    outOfSupply: realm !== NEUTRAL && owner !== realm && !s.map.provinces[province]!.neighbors.some((n) => s.owner[n] === realm),
  };
}

/** Tenths a side adds to the base 10 before its roll: the province's defence if it holds it, less if out of supply. */
export const sideModifier = (side: BattleSide, bonus: number): number => (side.defending ? bonus : 0) + (side.outOfSupply ? OUT_OF_SUPPLY : 0);

/** A side's power with a given d6 roll. */
export const sidePower = (side: BattleSide, modifier: number, roll: number): number => strength(side.troops) * Math.max(1, 10 + modifier + roll - 3);

/** Battle order, strongest first: the highest power, ties to the defender, then to the lower realm id. */
export const byBattleRank = (a: { side: BattleSide; power: number }, b: { side: BattleSide; power: number }): number =>
  b.power - a.power || Number(b.side.defending) - Number(a.side.defending) || a.side.realm - b.side.realm;

const lose = (t: Troops, pct: Troops | number, round: (x: number) => number): Troops => {
  const p = (k: keyof Troops): number => (typeof pct === 'number' ? pct : pct[k]);
  const cut = (n: number, k: keyof Troops): number => n - Math.min(n, round((n * p(k)) / 100));
  return { levies: cut(t.levies, 'levies'), regulars: cut(t.regulars, 'regulars'), mercs: cut(t.mercs, 'mercs') };
};

/**
 * Resolves one battle. Power = strength x (10 + bonuses + roll - 3) where roll is a d6
 * drawn from the season's committed roll seed, so anyone with the seed can replay it.
 * The highest power wins; ties go to the defender, then to the lower realm id.
 * `where` names the battle in the roll stream (a province id, or a border "a-b").
 */
export function fight(s: GameState, province: number, sides: BattleSide[], rollSeed: string, where: string): BattleResult {
  const bonus = defenceBonus(s, province);
  const scored = sides.map((side) => {
    const roll = rng(rollSeed, s.season, where, side.realm).range(1, 6);
    return { side, roll, power: sidePower(side, sideModifier(side, bonus), roll) };
  });
  const ranked = [...scored].sort(byBattleRank);
  const top = ranked[0]!;
  const runnerUp = ranked[1];
  const winnerLossPct =
    runnerUp && top.power > 0 ? Math.floor((WINNER_MAX_LOSS_PCT * runnerUp.power) / top.power) : 0;
  return {
    winner: top.side.realm,
    sides: scored.map(({ side, roll, power }) => ({
      realm: side.realm,
      power,
      roll,
      troopsBefore: { ...side.troops },
      // a beaten side always bleeds (round up); a winner never loses more than its share (round down)
      troopsAfter:
        side.realm === top.side.realm ? lose(side.troops, winnerLossPct, Math.floor) : lose(side.troops, LOSER_LOSS_PCT, Math.ceil),
    })),
  };
}
