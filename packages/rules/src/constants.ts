import type { Good, Purse, Terrain, Troops } from './types.ts';

// Every tunable number in the game lives here, so balance changes are one-file diffs.

export const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'] as const;
export const seasonName = (season: number): (typeof SEASON_NAMES)[number] => SEASON_NAMES[season % 4]!;
/** grain harvest multiplier by season: autumn doubles, winter yields none */
export const GRAIN_FACTOR = [1, 1, 2, 0] as const;

export const TOWN_CROWNS = 4;
export const CAPITAL_CROWNS = 6;
/** Rules version 4: a town held through this many harvests by one realm grows into a city. */
export const CITY_AFTER = 4;
/** Rules version 4: a city's extra crowns each harvest, on top of a town's (or capital's). */
export const CITY_BONUS = 3;

export const COST = {
  levy: { crowns: 4, grain: 2 },
  levyTroops: 3,
  regular: { crowns: 8, iron: 1 },
  fortify: { crowns: 4, timber: 3, iron: 2 },
  town: { crowns: 20, timber: 6 },
} as const;
export const MAX_FORT = 3;

/** crowns per season per troop */
export const UPKEEP = { levies: 0, regulars: 1, mercs: 3 } as const satisfies Troops;
/** one grain feeds this many troops per season */
export const TROOPS_PER_GRAIN = 2;

export const STRENGTH = { levies: 1, regulars: 3, mercs: 3 } as const satisfies Troops;
/** defender bonus in tenths of strength */
export const TERRAIN_DEFENCE: Record<Terrain, number> = { plains: 0, forest: 1, hills: 2, pass: 4 };
export const FORT_DEFENCE = 3;
export const RIVER_DEFENCE = 1;
export const OUT_OF_SUPPLY = -2;
/** percent of each troop type a beaten side loses */
export const LOSER_LOSS_PCT = { levies: 60, regulars: 40, mercs: 40 } as const satisfies Troops;
/** a winner loses up to this percent, scaled by how close the fight was */
export const WINNER_MAX_LOSS_PCT = 40;

export const MARKET_BASE_STOCK = 100;
export const BASE_PRICE: Record<Good, number> = { grain: 4, timber: 6, iron: 8, gold: 16 };
/** sellers get this percent of the buy price */
export const SELL_PCT = 80;
/** percent of the gap to the base stock the market recovers each season */
export const MARKET_DRIFT_PCT = 20;

/** stores above this spoil (grain rots, timber warps, iron rusts); gold keeps */
export const STORE_LIMIT = 40;
/** percent of the amount above the limit lost each season */
export const SPOIL_PCT = 25;

export const START_PURSE: Purse = { crowns: 30, grain: 12, timber: 6, iron: 6, gold: 2 };
export const START_ARMY: Troops = { levies: 4, regulars: 3, mercs: 0 };
export const NEUTRAL_TOWN_MILITIA: Troops = { levies: 3, regulars: 0, mercs: 0 };
/** realm id used for neutral militias */
export const NEUTRAL = -1;

/** What land is worth at the end. `city` and `shrine` count from rules version 4 (city on top of town). */
export const SCORE = { province: 15, town: 20, fort: 5, city: 20, shrine: 25 } as const;
