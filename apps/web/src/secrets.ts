// Your orders and salt stay in this browser until the reveal.
//
// Every seal attempt for a season is kept: if a retry finds an earlier seal already onchain,
// the reveal uses whichever secret matches the seal the server reports.
import { sealOrders, type OrderSet } from '@realm-ledger/rules';

export type Secret = { orders: OrderSet; salt: string };

const key = (id: number, season: number): string => `realm-ledger:${id}:${season}`;
// private mode: the reveal still works in this tab
const memory: { id: number; secret: Secret }[] = [];

function stored(id: number, season: number): Secret[] {
  try {
    const v = localStorage.getItem(key(id, season));
    const parsed = v ? (JSON.parse(v) as Secret | Secret[]) : [];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export function keepSecret(id: number, secret: Secret): void {
  memory.push({ id, secret });
  try {
    localStorage.setItem(key(id, secret.orders.season), JSON.stringify([...stored(id, secret.orders.season), secret]));
  } catch {
    // only the in-memory copy survives
  }
}

export function findSecret(id: number, season: number, seal: string | null): Secret | null {
  const all = [...stored(id, season), ...memory.filter((m) => m.id === id && m.secret.orders.season === season).map((m) => m.secret)];
  return all.find((x) => sealOrders(x.orders, x.salt) === seal) ?? null;
}
