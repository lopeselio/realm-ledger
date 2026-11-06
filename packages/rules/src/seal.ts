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
