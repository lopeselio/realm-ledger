// What the guide remembers about this browser. Storage can be missing or throw (private
// windows, blocked site data): then the welcome simply shows again next time.

const WELCOME = 'realm-ledger:welcome-seen';

export function welcomeSeen(): boolean {
  try {
    return localStorage.getItem(WELCOME) === '1';
  } catch {
    return false;
  }
}

export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(WELCOME, '1');
  } catch {
    // not remembered: it shows again on the next visit
  }
}

/** True when the user asked the system for less motion. */
export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Keys typed into a form field belong to the field, not to the guide. */
export function typingIn(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** Give focus back after a dialog closes: to what had it, or else to the guide's button. */
export function restoreFocus(before: Element | null): void {
  const to = before instanceof HTMLElement && before.isConnected && before !== document.body ? before : document.querySelector<HTMLElement>('.ob-help-btn');
  to?.focus({ preventScroll: true });
}
