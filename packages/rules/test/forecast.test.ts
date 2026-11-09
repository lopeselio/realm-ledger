import { describe, expect, it } from 'vitest';
import { fight, forecastMarch, type Troops } from '../src/index.ts';
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
});
