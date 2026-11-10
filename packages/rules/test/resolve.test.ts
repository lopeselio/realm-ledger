import { describe, expect, it } from 'vitest';
import {
  BASE_PRICE,
  COST,
  fight,
  priceFor,
  resolveSeason,
  sellPrice,
  stateHash,
  type GameEvent,
  type Order,
  type OrderSet,
  newCampaign,
  scores,
  SCORE,
  CITY_AFTER,
  runCampaign,
  replaySeason,
} from '../src/index.ts';
import { army, lineWorld } from './fixture.ts';

const ROLLS = { rollSeed: 'test-rolls' };
const sets = (season: number, byRealm: Record<number, Order[]>): OrderSet[] =>
  Object.entries(byRealm).map(([realm, orders]) => ({ realm: Number(realm), season, orders }));
const ofKind = <K extends GameEvent['kind']>(events: GameEvent[], kind: K) =>
  events.filter((e): e is Extract<GameEvent, { kind: K }> => e.kind === kind);

describe('resolveSeason', () => {
  it('does not modify its input', () => {
    const s = lineWorld();
    s.armies = [army(0, 0, 3)];
    const before = stateHash(s);
    resolveSeason(s, sets(0, { 0: [{ kind: 'march', from: 0, to: 1 }] }), ROLLS);
    expect(stateHash(s)).toBe(before);
  });

  it('marches into empty land and takes it', () => {
    const s = lineWorld();
    s.armies = [army(0, 0, 3)];
    const { state, events } = resolveSeason(s, sets(0, { 0: [{ kind: 'march', from: 0, to: 1 }] }), ROLLS);
    expect(state.owner[1]).toBe(0);
    expect(state.armies).toEqual([army(0, 1, 3)]);
    expect(ofKind(events, 'captured')).toHaveLength(1);
    expect(state.season).toBe(1);
  });

  it('can split an army', () => {
    const s = lineWorld();
    s.armies = [army(0, 0, 3, 4)];
    const { state } = resolveSeason(s, sets(0, { 0: [{ kind: 'march', from: 0, to: 1, troops: { regulars: 2, levies: 0 } }] }), ROLLS);
    expect(state.armies).toEqual([army(0, 0, 1, 4), army(0, 1, 2)]);
  });

  it('rejects bad orders with a reason and applies the rest', () => {
    const s = lineWorld();
    s.armies = [army(0, 0, 3)];
    const { events, state } = resolveSeason(
      s,
      sets(0, {
        0: [
          { kind: 'march', from: 0, to: 2 },
          { kind: 'march', from: 3, to: 2 },
          { kind: 'fortify', province: 4 },
          { kind: 'recruit', province: 1, count: 1 },
          { kind: 'fortify', province: 0 },
        ],
      }),
      ROLLS,
    );
    expect(ofKind(events, 'rejected').map((e) => e.reason)).toEqual([
      'not your province',
      'not your province',
      'not adjacent',
      'no army there',
    ]);
    expect(state.forts[0]).toBe(1);
  });

  it('fights when two realms enter the same province, and the loser falls back', () => {
    const s = lineWorld(3);
    s.armies = [army(0, 0, 6), army(1, 2, 1)];
    const { state, events } = resolveSeason(
      s,
      sets(0, { 0: [{ kind: 'march', from: 0, to: 1 }], 1: [{ kind: 'march', from: 2, to: 1 }] }),
      ROLLS,
    );
    const [battle] = ofKind(events, 'battle');
    expect(battle?.province).toBe(1);
    expect(battle?.winner).toBe(0);
    expect(state.owner[1]).toBe(0);
    const loser = state.armies.find((a) => a.realm === 1);
    if (loser) expect(loser.province).toBe(2);
  });

  it('meets on the border when hostile armies swap provinces', () => {
    const s = lineWorld(2);
    s.armies = [army(0, 0, 8), army(1, 1, 1)];
    const { events } = resolveSeason(
      s,
      sets(0, { 0: [{ kind: 'march', from: 0, to: 1 }], 1: [{ kind: 'march', from: 1, to: 0 }] }),
      ROLLS,
    );
    const [battle] = ofKind(events, 'battle');
    expect(battle?.border).toEqual([0, 1]);
    expect(battle?.winner).toBe(0);
  });

  it('topples a realm whose capital is taken', () => {
    const s = lineWorld(2);
    s.armies = [army(0, 0, 10)];
    const { state, events } = resolveSeason(s, sets(0, { 0: [{ kind: 'march', from: 0, to: 1 }] }), ROLLS);
    expect(ofKind(events, 'fallen')).toEqual([{ kind: 'fallen', realm: 1, by: 0 }]);
    expect(state.realms[1]!.alive).toBe(false);
    expect(state.winner).toBe(0);
    expect(ofKind(events, 'victory')[0]?.reason).toBe('conquest');
  });

  it('breaks a peace treaty when marching on the partner', () => {
    const s = lineWorld(3);
    s.owner[1] = 1;
    s.treaties = [{ kind: 'peace', realms: [0, 1], since: 0 }];
    s.armies = [army(0, 0, 5)];
    const { state, events } = resolveSeason(s, sets(0, { 0: [{ kind: 'march', from: 0, to: 1 }] }), ROLLS);
    expect(ofKind(events, 'treaty-broken')).toHaveLength(1);
    expect(state.treaties).toEqual([]);
    expect(state.owner[1]).toBe(0);
  });

  it('lets passage partners share a province without fighting or capture', () => {
    const s = lineWorld(3);
    s.owner[1] = 1;
    s.treaties = [{ kind: 'passage', realms: [0, 1], since: 0 }];
    s.armies = [army(0, 0, 5), army(1, 1, 2)];
    const { state, events } = resolveSeason(s, sets(0, { 0: [{ kind: 'march', from: 0, to: 1 }] }), ROLLS);
    expect(ofKind(events, 'battle')).toHaveLength(0);
    expect(state.owner[1]).toBe(1);
  });

  it('trades at the posted price and moves next season’s price', () => {
    const s = lineWorld();
    const { state, events } = resolveSeason(
      s,
      sets(0, {
        0: [{ kind: 'trade', good: 'iron', side: 'buy', qty: 10 }],
        1: [{ kind: 'trade', good: 'grain', side: 'sell', qty: 10 }],
      }),
      ROLLS,
    );
    const trades = ofKind(events, 'trade');
    expect(trades).toContainEqual({ kind: 'trade', realm: 0, good: 'iron', side: 'buy', qty: 10, price: BASE_PRICE.iron });
    expect(trades).toContainEqual({ kind: 'trade', realm: 1, good: 'grain', side: 'sell', qty: 10, price: sellPrice(BASE_PRICE.grain) });
    expect(state.realms[0]!.purse.iron).toBe(30);
    expect(state.market.price.iron).toBeGreaterThan(BASE_PRICE.iron);
    expect(state.market.reasons.iron.map((r) => r.kind)).toContain('trade');
  });

  it('shares a short market evenly', () => {
    const s = lineWorld();
    s.market.stock.gold = 11;
    s.market.price.gold = priceFor('gold', 11);
    s.realms[0]!.purse.crowns = 10_000;
    s.realms[1]!.purse.crowns = 10_000;
    const { events } = resolveSeason(
      s,
      sets(0, {
        0: [{ kind: 'trade', good: 'gold', side: 'buy', qty: 10 }],
        1: [{ kind: 'trade', good: 'gold', side: 'buy', qty: 10 }],
      }),
      ROLLS,
    );
    expect(ofKind(events, 'trade').map((t) => t.qty)).toEqual([5, 5]);
  });

  it('pays for builds and refuses what it cannot afford', () => {
    const s = lineWorld();
    s.realms[0]!.purse = { crowns: 20, grain: 50, timber: 0, iron: 2, gold: 0 };
    const { state, events } = resolveSeason(
      s,
      sets(0, { 0: [{ kind: 'recruit', province: 0, count: 5 }, { kind: 'fortify', province: 0 }] }),
      ROLLS,
    );
    expect(ofKind(events, 'built')).toContainEqual({ kind: 'built', realm: 0, province: 0, what: 'regulars', count: 2 });
    expect(ofKind(events, 'rejected')[0]?.reason).toBe('cannot afford a fort');
    expect(state.realms[0]!.purse.crowns).toBe(20 - 2 * COST.regular.crowns + 6 /* capital crowns */ - 2 /* wages */);
  });

  it('starves armies that have no grain', () => {
    const s = lineWorld();
    s.season = 3; // winter: no grain harvest
    s.realms[0]!.purse.grain = 2;
    s.armies = [army(0, 0, 2, 6)];
    const { state, events } = resolveSeason(s, [], ROLLS);
    const upkeep = ofKind(events, 'upkeep').find((e) => e.realm === 0)!;
    expect(upkeep.deserted).toEqual({ levies: 4, regulars: 0, mercs: 0 });
    expect(state.armies.find((a) => a.realm === 0)).toEqual(army(0, 0, 2, 2));
  });

  it('rejects order sets for the wrong season or duplicated realms', () => {
    const s = lineWorld();
    expect(() => resolveSeason(s, sets(1, { 0: [] }), ROLLS)).toThrow();
    expect(() => resolveSeason(s, [...sets(0, { 0: [] }), ...sets(0, { 0: [] })], ROLLS)).toThrow();
  });
});

describe('fight', () => {
  it('is replayable from the roll seed', () => {
    const s = lineWorld();
    const sides = [
      { realm: 0, troops: army(0, 1, 4), defending: false, outOfSupply: false },
      { realm: 1, troops: army(1, 1, 4), defending: true, outOfSupply: false },
    ];
    expect(fight(s, 1, sides, 'seed', 'p1')).toEqual(fight(s, 1, sides, 'seed', 'p1'));
  });

  it('favours a fortified defender in the hills', () => {
    const s = lineWorld(3, { 1: 'hills' });
    s.forts[1] = 2;
    let defenderWins = 0;
    for (let i = 0; i < 200; i++) {
      const r = fight(
        s,
        1,
        [
          { realm: 0, troops: army(0, 1, 5), defending: false, outOfSupply: false },
          { realm: 1, troops: army(1, 1, 4), defending: true, outOfSupply: false },
        ],
        `seed-${i}`,
        'p1',
      );
      if (r.winner === 1) defenderWins++;
    }
    expect(defenderWins).toBeGreaterThan(150);
  });

  it('never wipes out the winner of a battle', () => {
    const s = lineWorld();
    for (let i = 0; i < 100; i++) {
      const r = fight(
        s,
        1,
        [
          { realm: 0, troops: army(0, 1, 1), defending: true, outOfSupply: false },
          { realm: 1, troops: army(1, 1, 0, 3), defending: false, outOfSupply: false },
        ],
        `close-${i}`,
        'p1',
      );
      const w = r.sides.find((x) => x.realm === r.winner)!;
      expect(w.troopsAfter.levies + w.troopsAfter.regulars).toBeGreaterThan(0);
    }
  });

  it('always costs the loser troops', () => {
    const s = lineWorld();
    const r = fight(
      s,
      1,
      [
        { realm: 0, troops: army(0, 1, 10), defending: false, outOfSupply: false },
        { realm: 1, troops: army(1, 1, 1), defending: false, outOfSupply: false },
      ],
      'seed',
      'p1',
    );
    const loser = r.sides.find((x) => x.realm === 1)!;
    expect(loser.troopsAfter.regulars).toBeLessThan(loser.troopsBefore.regulars);
  });
});

describe('cities and shrines (rules version 4)', () => {
  it('places a few shrines on open land, only from version 4, without changing the rest of the setup', () => {
    const v4 = newCampaign({ seed: 'shrines', realms: 4, human: 0, maxSeasons: 8, rulesVersion: 4 });
    const v3 = newCampaign({ seed: 'shrines', realms: 4, human: 0, maxSeasons: 8, rulesVersion: 3 });
    const shrines = v4.shrines!.flatMap((x, p) => (x ? [p] : []));
    expect(shrines.length).toBeGreaterThanOrEqual(2);
    for (const p of shrines) {
      expect(v4.owner[p]).toBe(-1);
      expect(v4.towns[p]).toBe(false);
    }
    expect(v3.shrines).toBeUndefined();
    expect(v4.owner).toEqual(v3.owner);
    expect(v4.towns).toEqual(v3.towns);
  });

  it('grows a town held through enough harvests into a city, worth more, and a capture sacks it back', () => {
    let s = newCampaign({ seed: 'growth', realms: 3, human: 0, maxSeasons: 20, rulesVersion: 4 });
    const capital = s.realms[0]!.capital;
    const crowns = (st: typeof s) => st.realms[0]!.purse.crowns;
    let grew = false;
    for (let i = 0; i < CITY_AFTER; i++) {
      const before = crowns(s);
      const r = resolveSeason(s, [], { rollSeed: `g${i}` });
      grew ||= r.events.some((e) => e.kind === 'grew' && e.province === capital);
      expect(crowns(r.state)).toBeGreaterThanOrEqual(before);
      s = r.state;
    }
    expect(grew).toBe(true);
    expect(s.cities![capital]).toBe(true);
    const asTown = { ...s, cities: s.cities!.map(() => false) };
    expect(scores(s)[0]! - scores(asTown)[0]!).toBe(SCORE.city);
  });

  it('counts a shrine in the score of whoever holds it', () => {
    const s = newCampaign({ seed: 'shrines', realms: 4, human: 0, maxSeasons: 8, rulesVersion: 4 });
    const p = s.shrines!.indexOf(true);
    const held = { ...s, owner: s.owner.map((o, i) => (i === p ? 0 : o)) };
    const asLand = { ...held, shrines: held.shrines!.map(() => false) };
    expect(scores(held)[0]! - scores(asLand)[0]!).toBe(SCORE.shrine);
  });

  it('replays a version-4 campaign exactly', () => {
    const opts = { seed: 'v4-replay', realms: 4, maxSeasons: 12, rulesVersion: 4 };
    const { state, history } = runCampaign(opts);
    let s = newCampaign({ ...opts, human: null });
    for (const h of history) s = replaySeason(s, h).state;
    expect(stateHash(s)).toBe(stateHash(state));
  });
});
