import { describe, expect, it } from 'vitest';
import { eventFor, eventsFor, type GameEvent } from '../src/index.ts';

const t = { levies: 1, regulars: 0, mercs: 0 };
const purse = { crowns: 1, grain: 0, timber: 0, iron: 0, gold: 0 };

describe('the season as one realm sees it', () => {
  const events: GameEvent[] = [
    { kind: 'moved', realm: 1, from: 8, to: 9, troops: t }, // in the fog
    { kind: 'moved', realm: 1, from: 8, to: 3, troops: t }, // arrives in sight
    { kind: 'moved', realm: 0, from: 20, to: 21, troops: t }, // yours, far away
    { kind: 'battle', province: 9, sides: [{ realm: 1, power: 1, roll: 1, troopsBefore: t, troopsAfter: t }], winner: 1 },
    { kind: 'battle', province: 21, sides: [{ realm: 0, power: 1, roll: 1, troopsBefore: t, troopsAfter: t }], winner: 0 },
    { kind: 'captured', realm: 1, province: 9, from: -1 },
    { kind: 'captured', realm: 2, province: 30, from: 0 }, // your land, lost out of sight
    { kind: 'built', realm: 1, province: 3, what: 'fort' },
    { kind: 'built', realm: 1, province: 9, what: 'fort' },
    { kind: 'harvest', realm: 1, gained: purse },
    { kind: 'harvest', realm: 0, gained: purse },
    { kind: 'rejected', realm: 1, order: { kind: 'levy', province: 9 }, reason: 'x' },
    { kind: 'trade', realm: 1, good: 'grain', side: 'buy', qty: 1, price: 4 },
    { kind: 'fallen', realm: 2, by: 1 },
  ];

  it('keeps your own events, what happened in sight, and public news; drops the rest', () => {
    const seen = new Set([2, 3, 4]);
    expect(events.flatMap((e, i) => (eventFor(e, 0, seen) ? [i] : []))).toEqual([1, 2, 4, 6, 7, 10, 12, 13]);
    expect(eventsFor(events, 0, seen)).toHaveLength(8);
  });

  it('sees a border battle from either side of the border', () => {
    const border: GameEvent = { kind: 'battle', province: 9, border: [8, 9], sides: [], winner: 1 };
    expect(eventsFor([border], 0, new Set([8]))).toHaveLength(1);
    expect(eventsFor([border], 0, new Set([7]))).toHaveLength(0);
  });
});

describe('the season as one realm sees it: every kind', () => {
  const t = { levies: 1, regulars: 0, mercs: 0 };
  const zero = { crowns: 0, grain: 0, timber: 0, iron: 0, gold: 0 };
  const seen = new Set([3]);
  const cases: [GameEvent, boolean][] = [
    [{ kind: 'retreated', realm: 1, from: 9, to: 3 }, true],
    [{ kind: 'retreated', realm: 1, from: 8, to: 9 }, false],
    [{ kind: 'destroyed', realm: 1, province: 3 }, true],
    [{ kind: 'destroyed', realm: 1, province: 9 }, false],
    [{ kind: 'destroyed', realm: 0, province: 9 }, true],
    [{ kind: 'upkeep', realm: 1, paid: zero, deserted: t, spoiled: { grain: 0, timber: 0, iron: 0, gold: 0 } }, false],
    [{ kind: 'tribute', from: 1, to: 2, amount: 3 }, true],
    [{ kind: 'price', good: 'iron', from: 8, to: 9 }, true],
    [{ kind: 'treaty-broken', realm: 1, against: 2, treaty: 'passage', province: 9 }, true],
    [{ kind: 'moved', realm: 1, from: 3, to: 9, troops: t }, false],
    [{ kind: 'retreated', realm: 1, from: 3, to: 9 }, false],
    [{ kind: 'treaty-broken', realm: 1, against: 0, treaty: 'peace', province: 9 }, true],
    [{ kind: 'treaty-broken', realm: 1, against: 2, treaty: 'peace', province: 3 }, true],
    [{ kind: 'victory', realm: 1, reason: 'last-winter', scores: [] }, true],
  ];
  it.each(cases)('%j: %s', (e, shown) => {
    expect(eventsFor([e], 0, seen)).toHaveLength(shown ? 1 : 0);
  });

  it('tells of a betrayal out of sight, but not where', () => {
    const far: GameEvent = { kind: 'treaty-broken', realm: 1, against: 2, treaty: 'peace', province: 9 };
    expect(eventsFor([far], 0, seen)).toEqual([{ ...far, province: -1 }]);
    const near: GameEvent = { ...far, province: 3 };
    expect(eventsFor([near], 0, seen)).toEqual([near]);
  });
});

describe('what a realm is told of where a rival came from', () => {
  const t = { levies: 1, regulars: 0, mercs: 0 };
  it('masks an origin out of sight, for a march or a retreat; never your own', () => {
    const seen = new Set([3]);
    expect(eventsFor([{ kind: 'retreated', realm: 1, from: 9, to: 3 }], 0, seen)).toEqual([{ kind: 'retreated', realm: 1, from: -1, to: 3 }]);
    expect(eventsFor([{ kind: 'moved', realm: 1, from: 9, to: 3, troops: t }], 0, seen)[0]).toMatchObject({ from: -1 });
    expect(eventsFor([{ kind: 'moved', realm: 0, from: 9, to: 8, troops: t }], 0, seen)[0]).toMatchObject({ from: 9 });
  });
});


describe('a victory before the end', () => {
  it('is told, but without the scores, which hold every treasury', () => {
    const v: GameEvent = { kind: 'victory', realm: 1, reason: 'last-winter', scores: [10, 20, 30] };
    expect(eventsFor([v], 0, new Set())).toEqual([{ ...v, scores: [] }]);
  });
});
