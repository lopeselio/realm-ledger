import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { GameState, OrderSet } from './types.ts';

/**
 * JSON with object keys sorted at every level, no whitespace. Two parties that hold the
 * same value always produce the same bytes, which is what makes seals checkable.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('cannot seal a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const sha256Hex = (s: string): string => bytesToHex(sha256(utf8ToBytes(s)));

/** A fresh 32-byte salt, hex. Uses the platform CSPRNG (Node 22+ and browsers). */
export function newSalt(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** The commitment posted onchain: sha256(canonical(orders) | salt). */
export const sealOrders = (orders: OrderSet, salt: string): string => sha256Hex(`${canonicalJson(orders)}|${salt}`);

export const verifySeal = (seal: string, orders: OrderSet, salt: string): boolean => sealOrders(orders, salt) === seal;

/** Commitment to any secret value (agenda, roll seed), same shape as an order seal. */
export const commit = (value: unknown, salt: string): string => sha256Hex(`${canonicalJson(value)}|${salt}`);

/** Fingerprint of a whole game state, for replay checks. */
/**
 * The hash of a state, as posted onchain each season. Under rules version 3 (`secretRulers`) the
 * rulers' personalities and agendas are left out: they come from a secret revealed only at the
 * end; they are drawn from the roll secret, so its onchain commitment binds them from the
 * start, and a replay mid-campaign, before the secret is revealed, still matches.
 */
export const stateHash = (s: GameState): string =>
  sha256Hex(canonicalJson(s.secretRulers ? { ...s, realms: s.realms.map(({ personality: _p, agenda: _a, ...r }) => r) } : s));

/** The realm contract's MAX_ORDERS_JSON (contracts/realm/src/lib.rs): the largest reveal, in UTF-8 bytes. */
export const MAX_REVEAL_BYTES = 8_000;
/** The realm contract's limit on a reveal's salt, in UTF-8 bytes. */
export const MAX_SALT_BYTES = 128;

/**
 * The realm contract's refusals of the orders themselves (format, size, seal), as opposed to
 * a network error, running out of gas or a reveal that already landed. Matches its panic text.
 */
// ("orders must be this realm's for this season" is left out: it also fires when the chain's
// season moved on, which says nothing about the orders)
export const ORDERS_REFUSED = /orders must be (?:JSON|canonical JSON)|reveal too large|orders do not match the seal/;

/**
 * When the realm contract lets the referee settle a season without a sealed realm's reveal:
 * a full season after the seal deadline (contracts/realm `settle_season`), plus a minute of
 * margin for the chain's clock. Takes the contract's campaign record.
 */
export function forfeitOpensAt(c: { seal_deadline_ms: number; season_ms: number }): number {
  return c.seal_deadline_ms + c.season_ms + 60_000;
}

/**
 * Orders the realm contract accepts as a reveal: canonical JSON it writes the same way (safe
 * whole numbers only, ASCII keys, no lone surrogates) and no larger than MAX_REVEAL_BYTES.
 * Checked before sealing, so a seal can always be revealed.
 */
export function revealable(o: OrderSet, salt?: string): boolean {
  if (salt !== undefined && utf8ToBytes(salt).length > MAX_SALT_BYTES) return false;
  // a lone surrogate can't be written as UTF-8, so the contract can't parse it
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const ok = (v: unknown): boolean => {
    if (typeof v === 'number') return Number.isSafeInteger(v);
    if (typeof v === 'string') return !lone.test(v);
    // JSON has no functions, symbols or bigints
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return false;
    // canonical JSON can't write undefined inside an array (in an object it drops the key)
    if (v === undefined) return false;
    // Array.from turns holes in a sparse array into undefined (every() would skip them)
    if (Array.isArray(v)) return Array.from(v).every(ok);
    // ASCII keys: sorted the same by JavaScript (UTF-16) and the contract (bytes)
    if (v !== null && typeof v === 'object') return Object.entries(v).every(([k, x]) => x === undefined || (/^[\x20-\x7e]*$/.test(k) && ok(x)));
    return true;
  };
  try {
    return Array.isArray(o.orders) && ok(o) && utf8ToBytes(canonicalJson(o)).length <= MAX_REVEAL_BYTES;
  } catch {
    return false;
  }
}
