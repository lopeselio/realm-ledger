import { battleSide, byBattleRank, sideModifier, sidePower, type BattleSide } from './battle.ts';
import { FORT_DEFENCE, RIVER_DEFENCE, TERRAIN_DEFENCE } from './constants.ts';
import { addTroops, friendly, marchingTroops, noTroops, pickTroops, strength, troopCount } from './state.ts';
import type { GameState, Order, Terrain, Troops } from './types.ts';

/** One side of a forecast battle: the fixed part of its power and the range the roll gives it. */
export interface ForecastSide extends BattleSide {
  strength: number;
  /** an ally of the marching realm: if it wins, your side wins and your troops stand aside */
  ally: boolean;
  /** tenths added to the base 10 before the roll: terrain, fort and river for a defender, supply */
  modifier: number;
  /** power with the worst roll (1) and the best roll (6) */
  power: [number, number];
}

export interface Forecast {
  province: number;
  /** why the defender is harder to beat here */
  defence: { terrain: Terrain; terrainBonus: number; fort: number; fortBonus: number; river: boolean; riverBonus: number };
  /** the marching realm first, then everyone else standing there, by realm id */
  sides: ForecastSide[];
  /** chance, in whole percent, that the marching realm or an ally wins, over every roll the committed seed could give */
  winPct: number;
  /** no hostile army there: no battle (if nobody else marches in) */
  unopposed: boolean;
}

/**
 * What `troops` of `realm` marching into `to` meet if everyone there stays put. It builds the
 * battle the way the season does (`battleSide`, `sidePower`, `byBattleRank`), so the only unknown
 * is the roll: a d6 per side from the season's committed seed. The odds count every combination.
 * Rivals' orders are sealed, so armies that move in or out this season aren't in it.
 */
export function forecastMarch(s: GameState, realm: number, troops: Troops, to: number): Forecast {
  const p = s.map.provinces[to]!;
  const defence = {
    terrain: p.terrain,
    terrainBonus: TERRAIN_DEFENCE[p.terrain],
    fort: s.forts[to]!,
    fortBonus: s.forts[to]! * FORT_DEFENCE,
    river: p.river,
    riverBonus: p.river ? RIVER_DEFENCE : 0,
  };
  const bonus = defence.terrainBonus + defence.fortBonus + defence.riverBonus;
  const here = new Map<number, Troops>([[realm, troops]]);
  for (const a of s.armies) if (a.province === to) here.set(a.realm, addTroops(here.get(a.realm) ?? noTroops(), pickTroops(a)));
  const sides = [...here.entries()]
    .sort((a, b) => Number(b[0] === realm) - Number(a[0] === realm) || a[0] - b[0])
    .map(([r, t]): ForecastSide => {
      const side = battleSide(s, to, r, t);
      const modifier = sideModifier(side, bonus);
      return { ...side, strength: strength(t), ally: r !== realm && friendly(s, r, realm), modifier, power: [sidePower(side, modifier, 1), sidePower(side, modifier, 6)] };
    });
  if (!sides.some((x) => !friendly(s, x.realm, realm))) return { province: to, defence, sides, winPct: 100, unopposed: true };

  // every combination of rolls is equally likely: count the ones your side wins
  let wins = 0;
  let total = 0;
  const rolls = new Array<number>(sides.length).fill(1);
  for (;;) {
    let best = { side: sides[0]!, power: sidePower(sides[0]!, sides[0]!.modifier, rolls[0]!) };
    for (let i = 1; i < sides.length; i++) {
      const x = { side: sides[i]!, power: sidePower(sides[i]!, sides[i]!.modifier, rolls[i]!) };
      if (byBattleRank(x, best) < 0) best = x;
    }
    if (friendly(s, best.side.realm, realm)) wins++;
    total++;
    let i = 0;
    while (i < rolls.length && rolls[i] === 6) rolls[i++] = 1;
    if (i === rolls.length) break;
    rolls[i]!++;
  }
  return { province: to, defence, sides, winPct: Math.round((100 * wins) / total), unopposed: false };
}

/**
 * The troops `realm`'s march orders send into each province, taken as the season takes them:
 * in order, each from what earlier marches left of the army, whole and capped at what is there.
 */
export function plannedMarches(s: GameState, realm: number, orders: Order[]): Map<number, Troops> {
  const left = new Map<number, Troops>();
  const into = new Map<number, Troops>();
  for (const o of orders) {
    if (o.kind !== 'march') continue;
    const army = left.get(o.from) ?? s.armies.find((a) => a.realm === realm && a.province === o.from);
    if (!army || !s.map.provinces[o.from]?.neighbors.includes(o.to)) continue;
    const t = marchingTroops(army, o.troops);
    if (troopCount(t) === 0) continue;
    left.set(o.from, { levies: army.levies - t.levies, regulars: army.regulars - t.regulars, mercs: army.mercs - t.mercs });
    into.set(o.to, addTroops(into.get(o.to) ?? noTroops(), t));
  }
  return into;
}
