import type { Rng } from './rng.ts';

// Original place-name generator for the Shattered Reach.

const STARTS = ['Ash', 'Bryn', 'Cal', 'Dun', 'Ember', 'Fen', 'Gal', 'Hollow', 'Iron', 'Kest', 'Lorn', 'Mar', 'Nor', 'Oak', 'Pell', 'Raven', 'Sel', 'Thorn', 'Ul', 'Vey', 'Wold', 'Yar'];
const ENDS = ['mere', 'ford', 'holt', 'stead', 'wick', 'moor', 'reach', 'gate', 'combe', 'fell', 'marsh', 'vale', 'crag', 'barrow', 'haven', 'ridge'];

export function provinceName(rng: Rng, used: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const n = rng.pick(STARTS) + rng.pick(ENDS);
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
  const n = `${rng.pick(STARTS)}${rng.pick(ENDS)} ${used.size}`;
  used.add(n);
  return n;
}

export const REALM_NAMES = [
  'The Ember Throne',
  'Kingdom of Vey',
  'The Salt Marches',
  'Duchy of Lornhold',
  'The Iron Compact',
  'Thornwood Free Cities',
  'The Raven Crown',
  'Principality of Galmoor',
] as const;
