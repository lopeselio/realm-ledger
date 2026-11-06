import { describe, expect, it } from 'vitest';
import { considerTreaty, resolveSeason, runCampaign, signTreaty, viewFor } from '../src/index.ts';
import { army, lineWorld } from './fixture.ts';

describe('considerTreaty', () => {
  it('a cautious ruler facing a stronger neighbour accepts peace', () => {
    const s = lineWorld(3);
    s.realms[1]!.personality = { greed: 5, caution: 8, honour: 6, ambition: 2 };
    s.armies = [army(0, 0, 10), army(1, 2, 2)];
    expect(considerTreaty(viewFor(s, 1), 1, 0, 'peace').accept).toBe(true);
  });

  it('an ambitious ruler who is stronger refuses peace', () => {
    const s = lineWorld(3);
    s.realms[1]!.personality = { greed: 5, caution: 2, honour: 3, ambition: 9 };
    s.armies = [army(0, 0, 2), army(1, 2, 10)];
    const v = considerTreaty(viewFor(s, 1), 1, 0, 'peace');
    expect(v.accept).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/stronger/);
  });

  it('nobody signs with a realm that betrayed them, and a blood debt blocks peace', () => {
    const s = lineWorld(3);
    s.realms[1]!.personality = { greed: 9, caution: 9, honour: 9, ambition: 1 };
    s.betrayals = [{ by: 0, against: 1, season: 0 }];
    expect(considerTreaty(viewFor(s, 1), 1, 0, 'trade')).toEqual({ accept: false, reasons: ['they broke a treaty with us before'] });
    const t = lineWorld(3);
    t.realms[1]!.personality = { greed: 9, caution: 9, honour: 9, ambition: 1 };
    t.realms[1]!.agenda = { kind: 'vendetta', realm: 0, text: 'blood debt' };
    expect(considerTreaty(viewFor(t, 1), 1, 0, 'peace').accept).toBe(false);
  });

  it('takes tribute worth having and refuses an insult', () => {
    const s = lineWorld(3);
    expect(considerTreaty(viewFor(s, 1), 1, 0, 'tribute', 8).accept).toBe(true);
    expect(considerTreaty(viewFor(s, 1), 1, 0, 'tribute', 1).accept).toBe(false);
  });

  it('refuses a treaty that already stands', () => {
    const s = signTreaty(lineWorld(3), { kind: 'trade', realms: [0, 1], since: 0 });
    expect(considerTreaty(viewFor(s, 1), 1, 0, 'trade').accept).toBe(false);
  });
});

describe('treaties in play', () => {
  it('tribute moves crowns every season', () => {
    const s = signTreaty(lineWorld(3), { kind: 'tribute', realms: [0, 1], since: 0, amount: 7 });
    const before = s.realms[1]!.purse.crowns;
    const { state, events } = resolveSeason(s, [], { rollSeed: 'r' });
    expect(events).toContainEqual({ kind: 'tribute', from: 0, to: 1, amount: 7 });
    // realm 1 also earns 6 crowns from its capital town
    expect(state.realms[1]!.purse.crowns).toBe(before + 7 + 6);
  });

  it('a broken peace is remembered', () => {
    const s = signTreaty(lineWorld(3), { kind: 'peace', realms: [0, 1], since: 0 });
    s.owner[1] = 1;
    s.armies = [army(0, 0, 5)];
    const { state } = resolveSeason(s, [{ realm: 0, season: 0, orders: [{ kind: 'march', from: 0, to: 1 }] }], { rollSeed: 'r' });
    expect(state.betrayals).toEqual([{ by: 0, against: 1, season: 0 }]);
  });

  it('AI rulers sign treaties with each other during campaigns', () => {
    let signed = 0;
    for (let i = 0; i < 10; i++) signed += runCampaign({ seed: `dip-${i}` }).history.reduce((n, h) => n + h.treaties.length, 0);
    expect(signed).toBeGreaterThan(0);
  });
});
