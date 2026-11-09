import { describe, expect, it } from 'vitest';
import { fight, forecastMarch, plannedMarches, type Troops } from '../src/index.ts';
import { lineWorld } from './fixture.ts';

const t = (levies: number, regulars = 0, mercs = 0): Troops => ({ levies, regulars, mercs });

describe('march forecast', () => {
  it('names an unopposed march, and explains the defence of the province', () => {
    const s = lineWorld(5, { 2: 'hills' });
    s.forts[2] = 1;
    const f = forecastMarch(s, 0, t(4), 2);
    expect(f.unopposed).toBe(true);
    expect(f.winPct).toBe(100);
    expect(f.defence).toMatchObject({ terrain: 'hills', terrainBonus: 2, fort: 1, fortBonus: 3 });
  });

  it('matches what fight does with every roll, and its odds match the rolls fight draws', () => {
    const s = lineWorld(5, { 3: 'forest' });
    s.owner[3] = 1;
    s.owner[2] = 0;
    s.forts[3] = 1;
    s.armies = [{ realm: 1, province: 3, ...t(2, 2) }];
    const mine = t(3, 3);
    const f = forecastMarch(s, 0, mine, 3);
    expect(f.unopposed).toBe(false);
    const [att, def] = f.sides;
    expect(att).toMatchObject({ realm: 0, defending: false, outOfSupply: false });
    expect(def).toMatchObject({ realm: 1, defending: true, modifier: 1 + 3 });
    let wins = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const r = fight(s, 3, f.sides.map((x) => ({ realm: x.realm, troops: x.troops, defending: x.defending, outOfSupply: x.outOfSupply })), `seed${i}`, 'province:3');
      for (const [k, sd] of r.sides.entries()) {
        const fs = f.sides[k]!;
        expect(sd.power).toBe(fs.strength * Math.max(1, 10 + fs.modifier + sd.roll - 3));
        expect(sd.power).toBeGreaterThanOrEqual(fs.power[0]);
        expect(sd.power).toBeLessThanOrEqual(fs.power[1]);
      }
      if (r.winner === 0) wins++;
    }
    expect(Math.abs((100 * wins) / n - f.winPct)).toBeLessThan(4);
  });

  it('counts a march with nowhere of its own next door as out of supply', () => {
    const s = lineWorld(6);
    s.armies = [{ realm: 1, province: 3, ...t(2) }];
    s.owner[3] = 1;
    const f = forecastMarch(s, 0, t(2), 3);
    expect(f.sides[0]).toMatchObject({ outOfSupply: true, modifier: -2 });
  });

  it("counts an ally's win as yours, and an ally's empty province as no battle", () => {
    const s = lineWorld(5);
    s.realms.push({ ...s.realms[1]!, id: 2, name: 'Realm 2', capital: 2 });
    s.owner[2] = 2;
    s.treaties = [{ kind: 'alliance', realms: [0, 2], since: 0 }];
    expect(forecastMarch(s, 0, t(2), 2).unopposed).toBe(true);
    s.owner[3] = 1;
    s.armies = [
      { realm: 1, province: 3, ...t(2) },
      { realm: 2, province: 3, ...t(0, 20) },
    ];
    const f = forecastMarch(s, 0, t(1), 3);
    expect(f.sides.map((x) => [x.realm, x.ally])).toEqual([[0, false], [1, false], [2, true]]);
    expect(f.winPct).toBe(100);
  });

  it('plans split marches the way the season takes them: in order, whole, capped', () => {
    const s = lineWorld(5);
    s.armies = [{ realm: 0, province: 1, ...t(6, 4) }];
    const into = plannedMarches(s, 0, [
      { kind: 'march', from: 1, to: 2, troops: { levies: 6.7, regulars: 0 } },
      { kind: 'march', from: 1, to: 0 },
      { kind: 'march', from: 1, to: 2, troops: { levies: 9 } },
    ]);
    expect(into.get(2)).toEqual(t(6));
    expect(into.get(0)).toEqual(t(0, 4));
  });

  it('counts levies and recruits raised this season in the army that marches', () => {
    const s = lineWorld(5);
    s.owner[1] = 0;
    s.towns[1] = true;
    const into = plannedMarches(s, 0, [
      { kind: 'march', from: 1, to: 2 },
      { kind: 'levy', province: 1 },
      { kind: 'recruit', province: 1, count: 2 },
    ]);
    expect(into.get(2)).toMatchObject({ regulars: 2 });
    expect(into.get(2)!.levies).toBeGreaterThan(0);
  });

  it('never reads 100% for a battle that can be lost, nor 0% for one that can be won', () => {
    const s = lineWorld(5);
    s.owner[2] = 0;
    s.owner[3] = 1;
    s.armies = [{ realm: 1, province: 3, ...t(6) }];
    for (let n = 1; n <= 40; n++) {
      const f = forecastMarch(s, 0, t(n), 3);
      const [me, them] = f.sides;
      const canLose = me!.power[0] <= them!.power[1];
      const canWin = me!.power[1] > them!.power[0];
      if (canLose) expect(f.winPct).toBeLessThan(100);
      if (canWin) expect(f.winPct).toBeGreaterThan(0);
    }
  });
});

