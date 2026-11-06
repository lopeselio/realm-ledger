import { friendly, strength, treatyBetween } from './state.ts';
import type { GameState, Treaty } from './types.ts';

// Diplomacy is decided here, deterministically, from a ruler's own view. The language
// model only voices the answer; it never decides whether a treaty is signed.

export interface Verdict {
  accept: boolean;
  /** plain reasons, fed to the model so its words match the decision */
  reasons: string[];
}

const MIN_TRIBUTE = 5;

function borders(s: GameState, a: number, b: number): boolean {
  return s.map.provinces.some((p) => s.owner[p.id] === a && p.neighbors.some((n) => s.owner[n] === b));
}

/** Strength of a realm's armies as seen in this view (fog applies to rivals). */
export function visibleStrength(view: GameState, realm: number): number {
  return view.armies.filter((a) => a.realm === realm).reduce((n, a) => n + strength(a), 0);
}

/**
 * Should ruler `me` sign a treaty that `from` proposes? For tribute, `from` pays `me`
 * `amount` crowns a season.
 */
export function considerTreaty(view: GameState, me: number, from: number, kind: Treaty['kind'], amount = 0): Verdict {
  const self = view.realms[me]!;
  const other = view.realms[from];
  if (!other || !other.alive || !self.alive || me === from) return { accept: false, reasons: ['there is no such realm to treat with'] };
  if (treatyBetween(view, me, from, kind)) return { accept: false, reasons: [`a ${kind} treaty already stands`] };
  const { greed, caution, honour, ambition } = self.personality;
  const wronged = view.betrayals.filter((b) => b.by === from && b.against === me).length;
  const broken = view.betrayals.filter((b) => b.by === from).length;
  const vendetta = self.agenda.kind === 'vendetta' && self.agenda.realm === from;
  const mine = visibleStrength(view, me);
  const theirs = visibleStrength(view, from);
  const reasons: string[] = [];

  if (wronged > 0 && kind !== 'tribute') return { accept: false, reasons: [`they broke a treaty with us before`] };
  if (vendetta && kind !== 'tribute') return { accept: false, reasons: ['an old blood debt stands between us'] };
  if (broken > 0) reasons.push(`they have broken ${broken} treaty${broken > 1 ? 'ies' : ''} with others`);

  let score = 0;
  let needed = 0;
  switch (kind) {
    case 'peace':
      score = caution * 2 + honour - ambition - 4 * broken + (theirs > mine ? 6 : 0);
      needed = 8;
      reasons.push(theirs > mine ? 'their armies look stronger than ours' : 'our armies look the stronger');
      break;
    case 'passage':
      score = honour + (theirs < mine ? 3 : -2) - 3 * broken + (borders(view, me, from) ? 0 : 2);
      needed = 7;
      reasons.push(theirs < mine ? 'their host is small enough to watch' : 'their host is large to let through our land');
      break;
    case 'alliance': {
      const common = view.realms.find(
        (r) =>
          r.alive &&
          r.id !== me &&
          r.id !== from &&
          !friendly(view, me, r.id) &&
          !friendly(view, from, r.id) &&
          borders(view, me, r.id) &&
          borders(view, from, r.id) &&
          visibleStrength(view, r.id) >= Math.min(mine, theirs),
      );
      score = (common ? 8 : 0) + honour - 3 * broken - (ambition > 7 ? 3 : 0);
      needed = 10;
      reasons.push(common ? `we share an enemy in ${common.name}` : 'we share no enemy worth an alliance');
      break;
    }
    case 'trade':
      score = greed + 2 - 2 * broken;
      needed = 5;
      reasons.push(greed >= 3 ? 'trade fills the treasury' : 'we have little interest in trade');
      break;
    case 'tribute':
      score = amount >= MIN_TRIBUTE ? 10 : 0;
      needed = 10;
      reasons.push(amount >= MIN_TRIBUTE ? `${amount} crowns a season is worth taking` : `${amount} crowns a season is an insult`);
      break;
  }
  return { accept: score >= needed, reasons };
}

/** Adds a signed treaty to the state. Returns a new state; the input is not modified. */
export function signTreaty(s: GameState, t: Treaty): GameState {
  if (treatyBetween(s, t.realms[0], t.realms[1], t.kind)) return s;
  return { ...s, treaties: [...s.treaties, { ...t }] };
}

/**
 * Treaties an AI ruler proposes to its neighbours this season: peace when a stronger
 * neighbour looms and the ruler is cautious, trade when it is greedy. At most one.
 */
export function proposeTreaties(view: GameState, me: number): Treaty[] {
  const self = view.realms[me]!;
  if (!self.alive) return [];
  const mine = visibleStrength(view, me);
  for (const r of view.realms) {
    if (!r.alive || r.id === me || !borders(view, me, r.id)) continue;
    if (self.agenda.kind === 'vendetta' && self.agenda.realm === r.id) continue;
    const theirs = visibleStrength(view, r.id);
    if (self.personality.caution >= 6 && theirs > mine * 1.2 && !treatyBetween(view, me, r.id, 'peace'))
      return [{ kind: 'peace', realms: [me, r.id], since: view.season }];
    if (self.personality.greed >= 7 && !treatyBetween(view, me, r.id, 'trade'))
      return [{ kind: 'trade', realms: [me, r.id], since: view.season }];
  }
  return [];
}
