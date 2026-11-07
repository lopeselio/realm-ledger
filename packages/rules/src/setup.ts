import { NEUTRAL, NEUTRAL_TOWN_MILITIA, START_ARMY, START_PURSE } from './constants.ts';
import { makeCompanies } from './agents.ts';
import { generateMap, type MapOptions } from './map.ts';
import { newMarket } from './market.ts';
import { REALM_NAMES } from './names.ts';
import { rng, type Rng } from './rng.ts';
import { GOODS, type Agenda, type Army, type GameMap, type GameState, type Personality, type Realm } from './types.ts';

export interface CampaignOptions {
  seed: string;
  /** 2..8 realms; the design plays 4-6 */
  realms?: number;
  /** realm id controlled by a human, or null for an AI-only campaign */
  human?: number | null;
  maxSeasons?: number;
  map?: MapOptions;
  /**
   * Which rules the campaign plays by: 1 = before the agent market (2026-11-06),
   * 2 = with it. Defaults to the current version.
   */
  rulesVersion?: number;
}

export const RULES_VERSION = 2;

/** Breadth-first distances (in moves) from one province to all others. */
export function distancesFrom(map: GameMap, start: number): number[] {
  const dist = map.provinces.map(() => Infinity);
  dist[start] = 0;
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    for (const n of map.provinces[p]!.neighbors) {
      if (dist[n] === Infinity) {
        dist[n] = dist[p]! + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

const provinceWorth = (map: GameMap, id: number): number => {
  const y = map.provinces[id]!.yields;
  return y.grain + y.timber + y.iron + 2 * y.gold;
};

/** Farthest-point sampling over move distance from a given first capital. */
function spreadFrom(map: GameMap, first: number, n: number, candidates: number[]): number[] {
  const capitals = [first];
  const minDist = distancesFrom(map, first);
  while (capitals.length < n) {
    let best = -1;
    let bestScore = -1;
    for (const c of candidates) {
      if (capitals.includes(c)) continue;
      // prefer far away, then richer land
      const score = minDist[c]! * 100 + provinceWorth(map, c);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    capitals.push(best);
    const d = distancesFrom(map, best);
    for (let i = 0; i < minDist.length; i++) minDist[i] = Math.min(minDist[i]!, d[i]!);
  }
  return capitals;
}

/** How uneven the land nearest each capital is: largest share minus smallest. */
function unevenness(map: GameMap, capitals: number[]): number {
  const d = capitals.map((c) => distancesFrom(map, c));
  const land = capitals.map(() => 0);
  for (let p = 0; p < map.provinces.length; p++) {
    const ds = d.map((x) => x[p]!);
    const m = Math.min(...ds);
    const nearest = ds.filter((x) => x === m).length;
    ds.forEach((x, i) => {
      if (x === m) land[i]! += 1 / nearest;
    });
  }
  return Math.max(...land) - Math.min(...land);
}

/**
 * Capitals spread out and fair: tries many spreads and keeps the one where every
 * realm has the most even share of nearby land, then shuffles who sits where.
 */
function placeCapitals(map: GameMap, n: number, r: Rng): number[] {
  const candidates = map.provinces.filter((p) => p.terrain !== 'pass' && p.neighbors.length >= 3).map((p) => p.id);
  if (candidates.length < n) throw new Error(`map has room for ${candidates.length} capitals, need ${n}`);
  const firsts = r.shuffle([...candidates]).slice(0, 32);
  let best: number[] = [];
  let bestScore = Infinity;
  for (const first of firsts) {
    const caps = spreadFrom(map, first, n, candidates);
    const score = unevenness(map, caps);
    if (score < bestScore) {
      bestScore = score;
      best = caps;
    }
  }
  return r.shuffle(best);
}

function personality(r: Rng): Personality {
  return { greed: r.range(1, 9), caution: r.range(1, 9), honour: r.range(1, 9), ambition: r.range(1, 9) };
}

function agenda(r: Rng, map: GameMap, self: number, capitals: number[], owner: number[]): Agenda {
  const roll = r.int(3);
  if (roll === 0) {
    const d = distancesFrom(map, capitals[self]!);
    const near = map.provinces.filter((p) => d[p.id]! >= 2 && d[p.id]! <= 4 && owner[p.id] !== self).map((p) => p.id);
    if (near.length >= 2) {
      r.shuffle(near);
      const provinces = near.slice(0, 2 + r.int(2)).sort((a, b) => a - b);
      const names = provinces.map((id) => map.provinces[id]!.name).join(', ');
      return { kind: 'covet', provinces, text: `covets ${names}` };
    }
  }
  if (roll <= 1) {
    const d = distancesFrom(map, capitals[self]!);
    const rivals = capitals.map((c, i) => ({ i, dist: d[c]! })).filter((x) => x.i !== self);
    rivals.sort((a, b) => a.dist - b.dist || a.i - b.i);
    const realm = rivals[0]!.i;
    return { kind: 'vendetta', realm, text: `owes a blood debt to ${REALM_NAMES[realm]}` };
  }
  const good = r.pick(GOODS);
  return { kind: 'hoard', good, text: `hoards ${good} against a coming famine` };
}

/** Builds the starting state of a campaign. Deterministic in its options. */
export function newCampaign(opts: CampaignOptions): GameState {
  const n = opts.realms ?? 5;
  if (n < 2 || n > REALM_NAMES.length) throw new Error(`realms must be 2..${REALM_NAMES.length}`);
  const human = opts.human ?? null;
  const rulesVersion = opts.rulesVersion ?? RULES_VERSION;
  const map = generateMap(opts.seed, opts.map);
  const r = rng(opts.seed, 'setup');
  const capitals = placeCapitals(map, n, r);

  const P = map.provinces.length;
  const owner = new Array<number>(P).fill(-1);
  const forts = new Array<number>(P).fill(0);
  const towns = new Array<boolean>(P).fill(false);
  const armies: Army[] = [];

  capitals.forEach((c, i) => {
    owner[c] = i;
    forts[c] = 1;
    towns[c] = true;
    armies.push({ realm: i, province: c, ...START_ARMY });
  });
  // each realm also starts with the free provinces next to its capital
  capitals.forEach((c, i) => {
    for (const nb of map.provinces[c]!.neighbors) if (owner[nb] === -1) owner[nb] = i;
  });

  // a few neutral market towns, each with a militia
  const free = map.provinces.filter((p) => owner[p.id] === -1 && p.terrain !== 'pass').map((p) => p.id);
  r.shuffle(free);
  const townCount = Math.floor(P / 12);
  const placed: number[] = [];
  for (const id of free) {
    if (placed.length >= townCount) break;
    if (placed.some((t) => map.provinces[t]!.neighbors.includes(id))) continue;
    placed.push(id);
  }
  for (const id of placed.sort((a, b) => a - b)) {
    towns[id] = true;
    armies.push({ realm: NEUTRAL, province: id, ...NEUTRAL_TOWN_MILITIA });
  }

  const realms: Realm[] = capitals.map((capital, id) => ({
    id,
    name: REALM_NAMES[id]!,
    human: id === human,
    capital,
    alive: true,
    purse: { ...START_PURSE },
    personality: personality(r),
    agenda: { kind: 'hoard', text: '' },
  }));
  for (const realm of realms) realm.agenda = agenda(r, map, realm.id, capitals, owner);

  return {
    seed: opts.seed,
    season: 0,
    maxSeasons: opts.maxSeasons ?? 20,
    map,
    realms,
    owner,
    forts,
    towns,
    armies,
    market: newMarket(),
    treaties: [],
    betrayals: [],
    // rules version 1 predates the agent market; leaving these out keeps its state hashes
    ...(rulesVersion >= 2 ? { companies: makeCompanies(opts.seed), lastBattles: 0 } : {}),
    winner: null,
  };
}
