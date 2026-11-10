import { NEUTRAL, troopCount, type GameEvent, type GameState } from '@realm-ledger/rules';

export interface Line {
  text: string;
  tone: 'big' | 'normal' | 'quiet';
}

/** Turns a season's events into chronicle lines, most dramatic first. */
export function chronicle(before: GameState, events: GameEvent[]): Line[] {
  const realm = (id: number): string => (id === NEUTRAL ? 'a town militia' : before.realms[id]!.name);
  const place = (id: number): string => before.map.provinces[id]!.name;
  const big: Line[] = [];
  const normal: Line[] = [];
  const quiet: Line[] = [];

  for (const e of events) {
    switch (e.kind) {
      case 'victory':
        big.push({ tone: 'big', text: `${realm(e.realm)} wins the campaign ${e.reason === 'conquest' ? 'by conquest' : 'with the best score when the last season ended'}.` });
        break;
      case 'fallen':
        big.push({ tone: 'big', text: `${realm(e.realm)} falls. ${realm(e.by)} holds its capital.` });
        break;
      case 'treaty-broken':
        // (where is told only if you saw it)
        big.push({ tone: 'big', text: `${realm(e.realm)} breaks its ${e.treaty} with ${realm(e.against)}${e.province >= 0 ? `, marching on ${place(e.province)}` : ''}.` });
        break;
      case 'battle': {
        const [w, ...rest] = [...e.sides].sort((a, b) => (a.realm === e.winner ? -1 : b.realm === e.winner ? 1 : 0));
        const lost = rest.map((s) => `${realm(s.realm)} (${troopCount(s.troopsBefore)}→${troopCount(s.troopsAfter)})`).join(', ');
        const where = e.border ? `on the border of ${place(e.border[0])} and ${place(e.border[1])}` : `at ${place(e.province)}`;
        normal.push({ tone: 'normal', text: `Battle ${where}: ${realm(w!.realm)} (${troopCount(w!.troopsBefore)}→${troopCount(w!.troopsAfter)}, rolled ${w!.roll}) beats ${lost}.` });
        break;
      }
      case 'captured':
        normal.push({ tone: 'normal', text: `${realm(e.realm)} takes ${place(e.province)}${e.from >= 0 ? ` from ${realm(e.from)}` : ''}${e.sacked ? ', and sacks the city back to a town' : ''}.` });
        break;
      case 'grew':
        normal.push({ tone: 'normal', text: `${place(e.province)} has grown into a city under ${realm(e.realm)}.` });
        break;
      case 'built':
        if (e.what === 'town' || e.what === 'fort') normal.push({ tone: 'normal', text: `${realm(e.realm)} builds a ${e.what} in ${place(e.province)}.` });
        else quiet.push({ tone: 'quiet', text: `${realm(e.realm)} raises ${e.count} ${e.what === 'levy' ? 'levies' : 'regulars'} in ${place(e.province)}.` });
        break;
      case 'upkeep':
        if (troopCount(e.deserted) > 0) normal.push({ tone: 'normal', text: `${troopCount(e.deserted)} of ${realm(e.realm)}'s troops desert, unfed or unpaid.` });
        break;
      case 'trade':
        quiet.push({ tone: 'quiet', text: `${realm(e.realm)} ${e.side === 'buy' ? 'buys' : 'sells'} ${e.qty} ${e.good} at ${e.price}.` });
        break;
      case 'retreated':
        // (from where only if you saw it)
        quiet.push({ tone: 'quiet', text: `${realm(e.realm)} falls back ${e.from >= 0 ? `from ${place(e.from)} ` : ''}to ${place(e.to)}.` });
        break;
      case 'destroyed':
        if (e.realm !== NEUTRAL) normal.push({ tone: 'normal', text: `${realm(e.realm)}'s army at ${place(e.province)} is destroyed.` });
        break;
      default:
        break;
    }
  }
  return [...big, ...normal, ...quiet];
}
