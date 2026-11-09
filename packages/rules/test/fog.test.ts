import { describe, expect, it } from 'vitest';
import { eventsFor, type GameEvent } from '../src/index.ts';

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
    const kept = eventsFor(events, 0, new Set([2, 3, 4]));
    expect(kept.map((e) => events.indexOf(e))).toEqual([1, 2, 4, 6, 7, 10, 12, 13]);
  });

  it('sees a border battle from either side of the border', () => {
    const border: GameEvent = { kind: 'battle', province: 9, border: [8, 9], sides: [], winner: 1 };
    expect(eventsFor([border], 0, new Set([8]))).toHaveLength(1);
    expect(eventsFor([border], 0, new Set([7]))).toHaveLength(0);
  });
});
