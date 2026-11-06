import { BASE_PRICE, MARKET_BASE_STOCK, MARKET_DRIFT_PCT, SELL_PCT } from './constants.ts';
import { GOODS, type Good, type Market, type PriceReason } from './types.ts';

/**
 * Price of a good from its market stock: base price scaled by how scarce it is,
 * clamped to a quarter and four times the base. Integer crowns.
 */
export function priceFor(good: Good, stock: number): number {
  const base = BASE_PRICE[good];
  const raw = Math.round((base * MARKET_BASE_STOCK) / Math.max(stock, 1));
  return Math.min(base * 4, Math.max(Math.ceil(base / 4), raw));
}

export const sellPrice = (buyPrice: number): number => Math.floor((buyPrice * SELL_PCT) / 100);

export function newMarket(): Market {
  const stock = {} as Record<Good, number>;
  const price = {} as Record<Good, number>;
  const reasons = {} as Record<Good, PriceReason[]>;
  for (const g of GOODS) {
    stock[g] = MARKET_BASE_STOCK;
    price[g] = priceFor(g, MARKET_BASE_STOCK);
    reasons[g] = [];
  }
  return { stock, price, reasons };
}

/** Applies a stock change with a stated reason. Stock never drops below 1. */
export function moveStock(m: Market, good: Good, delta: number, kind: PriceReason['kind'], text: string): void {
  if (delta === 0) return;
  const before = m.stock[good];
  m.stock[good] = Math.max(1, before + delta);
  m.reasons[good].push({ kind, stockDelta: m.stock[good] - before, text });
}

/** End of season: the market drifts back toward its base stock, then prices are recomputed. */
export function settleMarket(m: Market): { good: Good; from: number; to: number }[] {
  const changes: { good: Good; from: number; to: number }[] = [];
  for (const g of GOODS) {
    const gap = MARKET_BASE_STOCK - m.stock[g];
    // always at least one unit, so small gaps close too
    const drift = Math.sign(gap) * Math.ceil((Math.abs(gap) * MARKET_DRIFT_PCT) / 100);
    moveStock(m, g, drift, 'drift', drift > 0 ? 'merchants restock' : 'surplus spoils or ships abroad');
    const from = m.price[g];
    m.price[g] = priceFor(g, m.stock[g]);
    if (m.price[g] !== from) changes.push({ good: g, from, to: m.price[g] });
  }
  return changes;
}
