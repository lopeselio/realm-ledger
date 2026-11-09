import { NEUTRAL, SCORE, STRENGTH } from './constants.ts';
import { sellPrice } from './market.ts';
import { GOODS, type Army, type GameEvent, type GameState, type Treaty, type Troops } from './types.ts';

export const noTroops = (): Troops => ({ levies: 0, regulars: 0, mercs: 0 });
export const troopCount = (t: Troops): number => t.levies + t.regulars + t.mercs;
export const strength = (t: Troops): number =>
  t.levies * STRENGTH.levies + t.regulars * STRENGTH.regulars + t.mercs * STRENGTH.mercs;
export const addTroops = (a: Troops, b: Troops): Troops => ({
  levies: a.levies + b.levies,
  regulars: a.regulars + b.regulars,
  mercs: a.mercs + b.mercs,
});
export const pickTroops = (t: Troops): Troops => ({ levies: t.levies, regulars: t.regulars, mercs: t.mercs });

/** The troops a march order takes from `army`: what it asks for (all of it by default), whole and at most what is there. */
export function marchingTroops(army: Troops, asked?: Partial<Troops>): Troops {
  const want = { ...pickTroops(army), ...(asked ?? {}) };
  return {
    levies: Math.max(0, Math.min(army.levies, Math.floor(want.levies))),
    regulars: Math.max(0, Math.min(army.regulars, Math.floor(want.regulars))),
    mercs: Math.max(0, Math.min(army.mercs, Math.floor(want.mercs))),
  };
}

export const armyAt = (s: GameState, realm: number, province: number): Army | undefined =>
  s.armies.find((a) => a.realm === realm && a.province === province);

export const armiesIn = (s: GameState, province: number): Army[] => s.armies.filter((a) => a.province === province);

export const treatyBetween = (s: GameState, a: number, b: number, kind?: Treaty['kind']): Treaty | undefined =>
  s.treaties.find(
    (t) => (kind === undefined || t.kind === kind) && ((t.realms[0] === a && t.realms[1] === b) || (t.realms[0] === b && t.realms[1] === a)),
  );

/** Realms whose armies may share a province without fighting: themselves, allies and passage partners. */
export function friendly(s: GameState, a: number, b: number): boolean {
  if (a === b) return true;
  if (a === NEUTRAL || b === NEUTRAL) return false;
  return s.treaties.some(
    (t) =>
      (t.kind === 'alliance' || t.kind === 'passage') &&
      ((t.realms[0] === a && t.realms[1] === b) || (t.realms[0] === b && t.realms[1] === a)),
  );
}

/** Keeps armies sorted and merged: at most one per (realm, province), none empty. */
export function normaliseArmies(s: GameState): void {
  const merged = new Map<string, Army>();
  for (const a of s.armies) {
    if (troopCount(a) <= 0) continue;
    const k = `${a.realm}:${a.province}`;
    const m = merged.get(k);
    if (m) {
      m.levies += a.levies;
      m.regulars += a.regulars;
      m.mercs += a.mercs;
    } else merged.set(k, { ...a });
  }
  s.armies = [...merged.values()].sort((a, b) => a.province - b.province || a.realm - b.realm);
}

/** Provinces a realm can see: its own, their neighbours, and around its armies. */
export function visibleProvinces(s: GameState, realm: number): Set<number> {
  const seen = new Set<number>();
  const around = (p: number): void => {
    seen.add(p);
    for (const n of s.map.provinces[p]!.neighbors) seen.add(n);
  };
  s.owner.forEach((o, p) => o === realm && around(p));
  for (const a of s.armies) if (a.realm === realm) around(a.province);
  return seen;
}

/**
 * What one realm knows: the full map and market, but only the armies it can see
 * and only its own purse, personality and agenda. AI rulers decide from this.
 */
export function viewFor(s: GameState, realm: number): GameState {
  const seen = visibleProvinces(s, realm);
  return {
    ...s,
    armies: s.armies.filter((a) => a.realm === realm || seen.has(a.province)).map((a) => ({ ...a })),
    realms: s.realms.map((r) =>
      r.id === realm
        ? structuredClone(r)
        : {
            ...r,
            purse: { crowns: 0, grain: 0, timber: 0, iron: 0, gold: 0 },
            personality: { greed: 0, caution: 0, honour: 0, ambition: 0 },
            agenda: { kind: 'hoard', text: 'unknown' },
          },
    ),
  };
}

/**
 * The season's events as one realm may see them: its own, and those in provinces it saw at the
 * start or the end of the season (`seen`). Treasury-revealing events of other realms (harvest,
 * upkeep, rejected orders) stay hidden; public ones (trades on the shared market, prices,
 * tribute, broken treaties, fallen realms, victory) are kept. The proof bundle keeps them all.
 */
export function eventsFor(events: GameEvent[], realm: number, seen: Set<number>): GameEvent[] {
  const sees = (...ps: (number | undefined)[]): boolean => ps.some((p) => p !== undefined && seen.has(p));
  return events.filter((e) => {
    switch (e.kind) {
      case 'rejected':
      case 'harvest':
      case 'upkeep':
        return e.realm === realm;
      case 'built':
      case 'destroyed':
        return e.realm === realm || sees(e.province);
      case 'moved':
      case 'retreated':
        return e.realm === realm || sees(e.from, e.to);
      case 'captured':
        return e.realm === realm || e.from === realm || sees(e.province);
      case 'battle':
        return e.sides.some((x) => x.realm === realm) || sees(e.province, ...(e.border ?? []));
      default:
        return true;
    }
  });
}

/** Campaign score: treasury (goods at what they'd sell for) plus land, towns and forts. */
export function scores(s: GameState): number[] {
  return s.realms.map((r) => {
    if (!r.alive) return 0;
    let total = r.purse.crowns;
    for (const g of GOODS) total += r.purse[g] * sellPrice(s.market.price[g]);
    s.owner.forEach((o, p) => {
      if (o !== r.id) return;
      total += SCORE.province + (s.towns[p] ? SCORE.town : 0) + s.forts[p]! * SCORE.fort;
    });
    return total;
  });
}
