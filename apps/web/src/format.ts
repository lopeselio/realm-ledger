import { seasonName, type GameState, type Order } from '@realm-ledger/rules';

/** "Spring, year 1" */
export function seasonTitle(season: number): string {
  const name = seasonName(season);
  return `${name[0]!.toUpperCase()}${name.slice(1)}, year ${Math.floor(season / 4) + 1}`;
}

/** One order in words, for the orders list and the Chancellor's advice. */
export function describeOrder(s: GameState, o: Order): string {
  const name = (id: number): string => s.map.provinces[id]!.name;
  switch (o.kind) {
    case 'march':
      return `March ${name(o.from)} → ${name(o.to)}`;
    case 'fortify':
      return `Fortify ${name(o.province)}`;
    case 'levy':
      return `Raise levies in ${name(o.province)}`;
    case 'recruit':
      return `Recruit ${o.count} regulars in ${name(o.province)}`;
    case 'build':
      return `Build a town in ${name(o.province)}`;
    case 'trade':
      return `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty} ${o.good} at ~${o.side === 'buy' ? s.market.price[o.good] : Math.floor(s.market.price[o.good] * 0.8)}`;
  }
}

export const nearblocks = (account: string): string => `https://testnet.nearblocks.io/address/${account}`;
