// Game feel: toasts, and short effects over the board. Raised only from real changes (an order
// added, a server reply, a settled season); they never touch the game's state or the chain.
import { useSyncExternalStore } from 'react';

export type Tone = 'info' | 'good' | 'bad' | 'gold';

export interface Toast {
  id: number;
  icon: string;
  text: string;
  detail?: string;
  tone: Tone;
}

/** Effects the board draws over itself, wherever a province sits on the 3D table or flat map. */
export type BoardFx =
  /** an icon (and a word) rising from a province */
  | { kind: 'pop'; province: number; icon: string; text?: string; tone?: Tone; big?: boolean }
  /** an icon travelling from one province to another (an envoy riding out) */
  | { kind: 'fly'; from: number; to: number; icon: string; ms: number }
  /** a banner across the table (a battle, a capture) */
  | { kind: 'banner'; icon: string; text: string; tone: Tone; ms: number }
  /** the table flashes (and shakes, for a loss) */
  | { kind: 'flash'; tone: 'gold' | 'red'; shake?: boolean };

// ---- toasts ----

const MAX_TOASTS = 4;
let toasts: Toast[] = [];
let nextToast = 1;
const toastListeners = new Set<() => void>();
const changed = (): void => {
  for (const l of toastListeners) l();
};

/** Shows a toast for a few seconds. */
export function toast(t: Omit<Toast, 'id'>, ms = 3400): void {
  const id = nextToast++;
  toasts = [...toasts, { ...t, id }].slice(-MAX_TOASTS);
  changed();
  window.setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  changed();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
  );
}

// ---- board effects ----

const fxListeners = new Set<(e: BoardFx) => void>();

/** Sends an effect to the board on screen (after `delayMs`); returns a function that cancels it if it hasn't run. */
export function boardFx(e: BoardFx, delayMs = 0): () => void {
  const run = (): void => {
    for (const l of fxListeners) l(e);
  };
  if (delayMs <= 0) {
    run();
    return () => undefined;
  }
  const t = window.setTimeout(run, delayMs);
  return () => window.clearTimeout(t);
}

export function onBoardFx(l: (e: BoardFx) => void): () => void {
  fxListeners.add(l);
  return () => fxListeners.delete(l);
}

/** Runs `fn` after `ms`; collects the cancel in `bag` so a whole sequence can be called off. */
export function later(bag: (() => void)[], ms: number, fn: () => void): void {
  const t = window.setTimeout(fn, ms);
  bag.push(() => window.clearTimeout(t));
}
