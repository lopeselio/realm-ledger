import { describe, expect, it } from 'vitest';
import {
  acceptsCounter,
  applyDeal,
  makeCompanies,
  newCampaign,
  planDeals,
  planTask,
  quoteMercs,
  replaySeason,
  reportHolds,
  runCampaign,
  spyReport,
  stateHash,
  viewFor,
  type Company,
  type GameState,
} from '../src/index.ts';
import { army, lineWorld } from './fixture.ts';

const world = (): GameState => {
  const s = lineWorld(5);
  s.companies = makeCompanies('agents-test');
  return s;
};
const merc = (s: GameState): Company => s.companies!.find((c) => c.kind === 'mercs')!;

describe('the agent market', () => {
  it('has mercenary companies and spy rings, one reliable and one not', () => {
    const cs = makeCompanies('x');
    expect(cs.filter((c) => c.kind === 'mercs')).toHaveLength(2);
    const spies = cs.filter((c) => c.kind === 'spy');
    expect(spies.map((c) => c.honesty >= 8)).toEqual([true, false]);
    expect(makeCompanies('x')).toEqual(cs);
  });

  it('charges more for swords in wartime', () => {
    const s = world();
    const peace = quoteMercs(s, merc(s), 4);
    s.lastBattles = 5;
    expect(quoteMercs(s, merc(s), 4)).toBeGreaterThan(peace);
  });

  it('greedy companies concede less when haggling', () => {
    const quote = 100;
    const greedy = { greed: 9 } as Company;
    const easy = { greed: 2 } as Company;
    expect(acceptsCounter(easy, quote, 80)).toBe(true);
    expect(acceptsCounter(greedy, quote, 80)).toBe(false);
  });

  it('mercenaries muster in your own province and cost crowns', () => {
    const s = world();
    const c = merc(s);
    const next = applyDeal(s, { kind: 'mercs', realm: 0, company: c.id, province: 0, count: 3, price: 30 });
    expect(next.realms[0]!.purse.crowns).toBe(70);
    expect(next.armies).toContainEqual({ realm: 0, province: 0, levies: 0, regulars: 0, mercs: 3 });
    expect(s.realms[0]!.purse.crowns).toBe(100);
    expect(() => applyDeal(s, { kind: 'mercs', realm: 0, company: c.id, province: 4, count: 3, price: 30 })).toThrow(/own province/);
    expect(() => applyDeal(s, { kind: 'mercs', realm: 0, company: c.id, province: 0, count: 3, price: 999 })).toThrow(/cannot pay/);
  });

  it('honest spies tell the truth; the check catches the liars', () => {
    const s = world();
    s.armies = [army(1, 2, 5)];
    let lies = 0;
    let caught = 0;
    for (let season = 0; season < 60; season++) {
      for (const c of s.companies!.filter((x) => x.kind === 'spy')) {
        const r = spyReport(s, c.id, 2, season);
        if (!reportHolds(s, r)) {
          lies++;
          caught++;
        }
      }
    }
    // the unreliable ring lies sometimes, and every lie fails the check
    expect(lies).toBeGreaterThan(5);
    expect(caught).toBe(lies);
  });
});

describe('the Chancellor', () => {
  it('buys a spy on hidden ground and swords to hold a threatened province', () => {
    const s = world();
    s.owner[1] = 0;
    s.owner[3] = 1;
    s.armies = [army(0, 1, 1), army(1, 2, 6)];
    const plan = planTask(viewFor(s, 0), 0, { goal: 'hold', province: 1, budget: 200 });
    const kinds = plan.steps.map((x) => x.kind);
    expect(kinds).toContain('mercs');
    expect(plan.spent).toBeLessThanOrEqual(200);
    expect(plan.advice).toContainEqual({ kind: 'fortify', province: 1 });
    // every bought step becomes a deal the rules can apply
    let next = s;
    for (const d of planDeals(plan, 0)) next = applyDeal(next, d);
    expect(next.realms[0]!.purse.crowns).toBe(100 - plan.spent);
  });

  it('never spends past the budget, and walks away from overpriced work', () => {
    const s = world();
    s.owner[1] = 0;
    s.armies = [army(1, 2, 30)];
    s.lastBattles = 6;
    for (const budget of [0, 5, 20, 60]) {
      const plan = planTask(viewFor(s, 0), 0, { goal: 'hold', province: 1, budget });
      expect(plan.spent).toBeLessThanOrEqual(budget);
      for (const st of plan.steps) if (st.price === undefined) expect(st.note).toMatch(/walked away|over the remaining budget/);
    }
  });

  it('counters once, with its reasoning', () => {
    const s = world();
    s.owner[1] = 0;
    s.armies = [army(1, 2, 9)];
    s.lastBattles = 6;
    const plan = planTask(viewFor(s, 0), 0, { goal: 'hold', province: 1, budget: 500 });
    const m = plan.steps.find((x) => x.kind === 'mercs')!;
    expect(m.quote).toBeGreaterThan(m.fair);
    expect(m.counter?.offer).toBe(m.fair);
    expect(m.counter?.reason).toMatch(/over the going rate/);
  });
});

describe('deals in campaigns', () => {
  it('AI rulers hire swords, and campaigns with deals still replay exactly', () => {
    let hires = 0;
    for (let i = 0; i < 8; i++) {
      const { state, history } = runCampaign({ seed: `market-${i}`, realms: 4 });
      hires += history.reduce((n, h) => n + h.deals.length, 0);
      let s = newCampaign({ seed: `market-${i}`, realms: 4, human: null });
      for (const h of history) s = replaySeason(s, h).state;
      expect(stateHash(s)).toBe(stateHash(state));
    }
    expect(hires).toBeGreaterThan(0);
  });
});
