import { FORT_DEFENCE, NEUTRAL, OUT_OF_SUPPLY, RIVER_DEFENCE, TERRAIN_DEFENCE } from './constants.ts';
import { friendly, strength } from './state.ts';
import type { GameState, Terrain, Troops } from './types.ts';

/** One side of a forecast battle: the fixed part of its power and the range the roll gives it. */
export interface ForecastSide {
  realm: number;
  troops: Troops;
  strength: number;
  defending: boolean;
  outOfSupply: boolean;
  /** tenths added to the base 10 before the roll: terrain, fort and river for a defender, supply */
  modifier: number;
  /** power with the worst roll (1) and the best roll (6) */
  power: [number, number];
}

export interface Forecast {
  province: number;
  /** why the defender is harder to beat here */
  defence: { terrain: Terrain; terrainBonus: number; fort: number; fortBonus: number; river: boolean; riverBonus: number };
  sides: ForecastSide[];
  /** chance, in whole percent, that the attacker wins, over every roll the committed seed could give */
  winPct: number;
  /** no hostile army there: the march takes the province unopposed (if nobody else marches in) */
  unopposed: boolean;
}

/**
 * What a march of `troops` from `realm` into `to` meets if everyone there stays put. Battles use
 * the same formula as `fight`: power = strength x max(1, 10 + modifier + roll - 3), roll a d6 from
 * the season's committed seed, ties to the defender, then the lower realm id. Only the roll is
 * unknown before the season, so the forecast lists both ends and the exact odds over all rolls.
 * Rivals' orders are sealed, so armies that move in or out this season aren't in it.
 */
export function forecastMarch(s: GameState, realm: number, troops: Troops, to: number): Forecast {
  const p = s.map.provinces[to]!;
  const owner = s.owner[to]!;
  const defence = {
    terrain: p.terrain,
    terrainBonus: TERRAIN_DEFENCE[p.terrain],
    fort: s.forts[to]!,
    fortBonus: s.forts[to]! * FORT_DEFENCE,
    river: p.river,
    riverBonus: p.river ? RIVER_DEFENCE : 0,
  };
  const bonus = defence.terrainBonus + defence.fortBonus + defence.riverBonus;
  const byRealm = new Map<number, Troops>();
  for (const a of s.armies) {
    if (a.province !== to || a.realm === realm || friendly(s, a.realm, realm)) continue;
    const t = byRealm.get(a.realm) ?? { levies: 0, regulars: 0, mercs: 0 };
    byRealm.set(a.realm, { levies: t.levies + a.levies, regulars: t.regulars + a.regulars, mercs: t.mercs + a.mercs });
  }
  const side = (r: number, t: Troops): ForecastSide => {
    const defending = r === owner || (owner === -1 && r === NEUTRAL);
    const outOfSupply = r !== NEUTRAL && owner !== r && !p.neighbors.some((n) => s.owner[n] === r);
    const modifier = (defending ? bonus : 0) + (outOfSupply ? OUT_OF_SUPPLY : 0);
    const st = strength(t);
    const at = (roll: number): number => st * Math.max(1, 10 + modifier + roll - 3);
    return { realm: r, troops: t, strength: st, defending, outOfSupply, modifier, power: [at(1), at(6)] };
  };
  const sides = [side(realm, troops), ...[...byRealm.entries()].sort((a, b) => a[0] - b[0]).map(([r, t]) => side(r, t))];
  if (sides.length === 1) return { province: to, defence, sides, winPct: 100, unopposed: true };

  // every combination of rolls is equally likely: count the ones the attacker wins
  let wins = 0;
  let total = 0;
  const rolls = new Array<number>(sides.length).fill(1);
  for (;;) {
    const powers = sides.map((sd, i) => sd.strength * Math.max(1, 10 + sd.modifier + rolls[i]! - 3));
    const best = sides
      .map((sd, i) => ({ sd, power: powers[i]! }))
      .sort((a, b) => b.power - a.power || Number(b.sd.defending) - Number(a.sd.defending) || a.sd.realm - b.sd.realm)[0]!;
    if (best.sd.realm === realm) wins++;
    total++;
    let i = 0;
    while (i < rolls.length && rolls[i] === 6) rolls[i++] = 1;
    if (i === rolls.length) break;
    rolls[i]!++;
  }
  return { province: to, defence, sides, winPct: Math.round((100 * wins) / total), unopposed: false };
}
