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
export const stateHash = (s: GameState): string => sha256Hex(canonicalJson(s));

/** The realm contract's MAX_ORDERS_JSON (contracts/realm/src/lib.rs): the largest reveal, in UTF-8 bytes. */
export const MAX_REVEAL_BYTES = 8_000;

/**
 * Orders the realm contract accepts as a reveal: canonical JSON it writes the same way (safe
 * whole numbers only, ASCII keys, no lone surrogates) and no larger than MAX_REVEAL_BYTES.
 * Checked before sealing, so a seal can always be revealed.
 */
export function revealable(o: OrderSet): boolean {
  // a lone surrogate can't be written as UTF-8, so the contract can't parse it
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const ok = (v: unknown): boolean => {
    if (typeof v === 'number') return Number.isSafeInteger(v);
    if (typeof v === 'string') return !lone.test(v);
    // canonical JSON can't write undefined inside an array (in an object it drops the key)
    if (v === undefined) return false;
    if (Array.isArray(v)) return v.every(ok);
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
