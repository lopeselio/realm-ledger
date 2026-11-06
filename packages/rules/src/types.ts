// Core data model. Everything is plain JSON so states can be hashed, stored and replayed.

export const GOODS = ['grain', 'timber', 'iron', 'gold'] as const;
export type Good = (typeof GOODS)[number];

/** A realm's holdings: the four goods plus crowns, the coin. */
export interface Purse {
  crowns: number;
  grain: number;
  timber: number;
  iron: number;
  gold: number;
}

export type Terrain = 'plains' | 'forest' | 'hills' | 'pass';

/** Tiles that are not provinces. */
export type Barrier = 'sea' | 'mountains';

export interface Tile {
  q: number;
  r: number;
  /** province terrain, or a barrier */
  kind: Terrain | Barrier;
  /** province id, or -1 for sea and mountains */
  province: number;
  /** 0..1, for rendering */
  elevation: number;
}

export interface Province {
  id: number;
  name: string;
  q: number;
  r: number;
  terrain: Terrain;
  coast: boolean;
  river: boolean;
  /** base yields per season, before the season multiplier */
  yields: Omit<Purse, 'crowns'>;
  /** ids of passable neighbouring provinces, sorted */
  neighbors: number[];
}

export interface GameMap {
  seed: string;
  radius: number;
  tiles: Tile[];
  provinces: Province[];
}

export interface Personality {
  /** each 0..10 */
  greed: number;
  caution: number;
  honour: number;
  ambition: number;
}

export interface Agenda {
  kind: 'covet' | 'vendetta' | 'hoard';
  /** covet: province ids wanted; vendetta: realm id hated; hoard: good to amass */
  provinces?: number[];
  realm?: number;
  good?: Good;
  text: string;
}

export interface Realm {
  id: number;
  name: string;
  /** true for the human player's realm */
  human: boolean;
  capital: number;
  alive: boolean;
  purse: Purse;
  personality: Personality;
  agenda: Agenda;
}

export interface Troops {
  levies: number;
  regulars: number;
  mercs: number;
}

/** One army per realm per province, so an army is named by (realm, province). */
export interface Army extends Troops {
  realm: number;
  province: number;
}

export interface Market {
  /** market stock of each good; price follows stock */
  stock: Record<Good, number>;
  /** current buy price in crowns */
  price: Record<Good, number>;
  /** why each price moved last season */
  reasons: Record<Good, PriceReason[]>;
}

export interface PriceReason {
  kind: 'trade' | 'harvest' | 'war' | 'drift';
  /** change in market stock this reason caused */
  stockDelta: number;
  text: string;
}

export interface Treaty {
  kind: 'peace' | 'passage' | 'trade' | 'alliance' | 'tribute';
  realms: [number, number];
  /** season the treaty was signed */
  since: number;
  /** tribute: crowns per season from realms[0] to realms[1] */
  amount?: number;
}

export interface GameState {
  seed: string;
  /** seasons resolved so far; season 0 is the first spring */
  season: number;
  maxSeasons: number;
  map: GameMap;
  realms: Realm[];
  /** owner realm id per province, or -1 */
  owner: number[];
  /** fort level per province, 0..3 */
  forts: number[];
  /** town per province */
  towns: boolean[];
  armies: Army[];
  market: Market;
  treaties: Treaty[];
  /** set when the campaign is over */
  winner: number | null;
}

// ---- orders ----

export type Order =
  | { kind: 'march'; from: number; to: number; troops?: Partial<Troops> }
  | { kind: 'fortify'; province: number }
  | { kind: 'levy'; province: number }
  | { kind: 'recruit'; province: number; count: number }
  | { kind: 'build'; province: number }
  | { kind: 'trade'; good: Good; side: 'buy' | 'sell'; qty: number };

/** All orders for one realm for one season. */
export interface OrderSet {
  realm: number;
  season: number;
  orders: Order[];
}

// ---- events (the season chronicle) ----

export type GameEvent =
  | { kind: 'rejected'; realm: number; order: Order; reason: string }
  | { kind: 'trade'; realm: number; good: Good; side: 'buy' | 'sell'; qty: number; price: number }
  | { kind: 'built'; realm: number; province: number; what: 'fort' | 'town' | 'levy' | 'regulars'; count?: number }
  | { kind: 'moved'; realm: number; from: number; to: number; troops: Troops }
  | {
      kind: 'battle';
      province: number;
      sides: { realm: number; power: number; roll: number; troopsBefore: Troops; troopsAfter: Troops }[];
      winner: number;
      border?: [number, number];
    }
  | { kind: 'retreated'; realm: number; from: number; to: number }
  | { kind: 'destroyed'; realm: number; province: number }
  | { kind: 'captured'; realm: number; province: number; from: number }
  | { kind: 'fallen'; realm: number; by: number }
  | { kind: 'treaty-broken'; realm: number; against: number; treaty: Treaty['kind']; province: number }
  | { kind: 'harvest'; realm: number; gained: Purse }
  | { kind: 'upkeep'; realm: number; paid: Purse; deserted: Troops; spoiled: Omit<Purse, 'crowns'> }
  | { kind: 'price'; good: Good; from: number; to: number }
  | { kind: 'victory'; realm: number; reason: 'conquest' | 'last-winter'; scores: number[] };
