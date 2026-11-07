import { newMarket, type Army, type GameState, type Province, type Realm, type Terrain } from '../src/index.ts';

/**
 * A tiny hand-made world for scenario tests: provinces 0..n-1 in a line, each next to
 * its neighbours, all plains unless overridden. Two realms: 0 holds province 0, 1 holds
 * the last province. No neutral militias.
 */
export function lineWorld(n = 5, terrain: Partial<Record<number, Terrain>> = {}): GameState {
  const provinces: Province[] = Array.from({ length: n }, (_, id) => ({
    id,
    name: `P${id}`,
    q: id,
    r: 0,
    terrain: terrain[id] ?? 'plains',
    coast: false,
    river: false,
    yields: { grain: 3, timber: 0, iron: 0, gold: 0 },
    neighbors: [id - 1, id + 1].filter((x) => x >= 0 && x < n),
  }));
  const realm = (id: number, capital: number): Realm => ({
    id,
    name: `Realm ${id}`,
    human: false,
    capital,
    alive: true,
    purse: { crowns: 100, grain: 50, timber: 20, iron: 20, gold: 0 },
    personality: { greed: 5, caution: 5, honour: 5, ambition: 5 },
    agenda: { kind: 'hoard', good: 'gold', text: 'test' },
  });
  const owner = new Array<number>(n).fill(-1);
  owner[0] = 0;
  owner[n - 1] = 1;
  const towns = new Array<boolean>(n).fill(false);
  towns[0] = true;
  towns[n - 1] = true;
  return {
    seed: 'fixture',
    season: 0,
    maxSeasons: 20,
    map: {
      seed: 'fixture',
      radius: n,
      tiles: provinces.map((p) => ({ q: p.q, r: p.r, kind: p.terrain, province: p.id, elevation: 0.5 })),
      provinces,
    },
    realms: [realm(0, 0), realm(1, n - 1)],
    owner,
    forts: new Array<number>(n).fill(0),
    towns,
    armies: [],
    market: newMarket(),
    treaties: [],
    betrayals: [],
    companies: [],
    lastBattles: 0,
    winner: null,
  };
}

export const army = (realm: number, province: number, regulars: number, levies = 0): Army => ({
  realm,
  province,
  levies,
  regulars,
  mercs: 0,
});
