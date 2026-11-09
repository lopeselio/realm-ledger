// The walkthrough: coach-marks that light up real parts of the page, one at a time.
// A step whose element isn't on the page is skipped. A step with `watch` also moves on by
// itself when the player does the thing it asks for (the watched value changes).
// The light doesn't block the page, so the player can act on what it points at.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { reducedMotion, restoreFocus, typingIn } from './storage.ts';

export interface TourStep<S> {
  /** a CSS selector for the element to light up */
  target: string;
  title: string;
  body: ReactNode;
  /** moves on when this value changes while the step is shown */
  watch?: (signals: S) => unknown;
  /** what the player can do to move on, shown under the text */
  hint?: string;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 6;
const CARD_ROOM = 230;

function find(sel: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(sel);
  // display:none or hidden elements have no box: treat them as missing
  return el && el.getClientRects().length > 0 ? el : null;
}

export function Tour<S>({ steps, signals, onClose }: { steps: TourStep<S>[]; signals: S; onClose: () => void }) {
  const [i, setI] = useState(() => firstPresent(steps, 0, 1));
  const [box, setBox] = useState<Box | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = i >= 0 && i < steps.length ? steps[i] : undefined;

  // the tour ends when it runs out of steps it can show
  useEffect(() => {
    if (!step) onClose();
  }, [step, onClose]);

  // the card takes focus when the player moves the tour (and when it opens), not when it
  // moves on by itself after they acted, so focus stays on the map or the button they used
  const focusCard = useRef(true);
  const go = useCallback(
    (dir: 1 | -1, manual = true) => {
      const n = firstPresent(steps, i + dir, dir);
      // nothing earlier to go back to: stay put
      if (dir === -1 && n < 0) return;
      focusCard.current = manual;
      setI(n);
    },
    [steps, i],
  );

  // a target that vanished (a campaign closed, a phase changed) moves the tour on
  useEffect(() => {
    if (!step) return;
    const t = window.setInterval(() => {
      if (!find(step.target)) setI((cur) => firstPresent(steps, cur + 1, 1));
    }, 400);
    return () => window.clearInterval(t);
  }, [step, steps]);

  // move on when the player does what the step asks
  const watched = step?.watch?.(signals);
  const start = useRef<{ i: number; value: unknown }>({ i: -1, value: undefined });
  useEffect(() => {
    if (!step?.watch) return;
    if (start.current.i !== i) {
      start.current = { i, value: watched };
      return;
    }
    if (!Object.is(start.current.value, watched)) go(1, false);
  }, [i, step, watched, go]);

  // bring the target into view, then follow it as the page moves
  useLayoutEffect(() => {
    if (!step) return;
    const el = find(step.target);
    if (!el) {
      setBox(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    if (r.top < 0 || r.bottom > window.innerHeight) {
      el.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? 'start' : 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const now = find(step.target);
        if (!now) return;
        const b = now.getBoundingClientRect();
        setBox((old) =>
          old && old.top === b.top && old.left === b.left && old.width === b.width && old.height === b.height ? old : { top: b.top, left: b.left, width: b.width, height: b.height },
        );
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    // smooth scrolling and late layout (the 3D table loading) move things without events
    const t = window.setInterval(measure, 300);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      window.clearInterval(t);
    };
  }, [step]);

  // the keys work anywhere on the page, except while typing in a field
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // a key something else already handled (the welcome's last Enter, which started the
      // tour) must not also move it on
      if (e.defaultPrevented || typingIn(e.target)) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement))) go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  // announce a step the player moved to by focusing the card
  useEffect(() => {
    if (focusCard.current) card.current?.focus({ preventScroll: true });
    focusCard.current = false;
  }, [i]);

  // give focus back to what had it when the tour closes (Skip, Done or Esc); read at the
  // first render, before the card takes focus
  const before = useRef<Element | null>(null);
  if (before.current === null) before.current = document.activeElement;
  useEffect(() => () => restoreFocus(before.current), []);

  if (!step) return null;
  // keep the light's edge on screen when the target is bigger than the window (the map)
  const light = box && clampToView(box);
  const count = steps.filter((s) => find(s.target)).length;
  const at = steps.slice(0, i + 1).filter((s) => find(s.target)).length;

  return (
    <div className="ob-tour">
      {light && <div className="ob-light" aria-hidden="true" style={light} />}
      <div ref={card} className="ob-card ob-mark" style={placeCard(box)} role="dialog" aria-modal="false" aria-labelledby="ob-mark-title" tabIndex={-1}>
        <p className="ob-kicker">
          Walkthrough · {at} of {count}
        </p>
        <h2 id="ob-mark-title">{step.title}</h2>
        <div className="ob-body">{step.body}</div>
        {step.hint && <p className="ob-hint">{step.hint}</p>}
        <div className="ob-nav">
          <button type="button" className="ob-skip" onClick={onClose}>
            Skip
          </button>
          <span className="ob-grow" />
          {firstPresent(steps, i - 1, -1) >= 0 && (
            <button type="button" onClick={() => go(-1)}>
              Back
            </button>
          )}
          <button type="button" className="primary" onClick={() => go(1)}>
            {firstPresent(steps, i + 1, 1) >= steps.length ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The index of the first step from `from` (going `dir`) whose element is on the page; -1 or steps.length if none. */
function firstPresent<S>(steps: TourStep<S>[], from: number, dir: 1 | -1): number {
  for (let k = from; k >= 0 && k < steps.length; k += dir) if (find(steps[k]!.target)) return k;
  return dir === 1 ? steps.length : -1;
}

/** The target's box plus padding, cut to the window with a small margin. */
function clampToView(b: Box): CSSProperties {
  const m = 3;
  const top = Math.max(m, b.top - PAD);
  const left = Math.max(m, b.left - PAD);
  const bottom = Math.min(window.innerHeight - m, b.top + b.height + PAD);
  const right = Math.min(window.innerWidth - m, b.left + b.width + PAD);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Below the target if there's room, else above it, else pinned to the bottom of the screen. */
function placeCard(box: Box | null): CSSProperties {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const width = Math.min(360, vw - 32);
  if (!box || vw < 560) return { left: (vw - width) / 2, bottom: 16, width };
  const left = Math.min(Math.max(16, box.left), vw - width - 16);
  if (box.top + box.height + PAD + CARD_ROOM < vh) return { left, top: box.top + box.height + PAD + 10, width };
  if (box.top - PAD > CARD_ROOM) return { left, bottom: vh - box.top + PAD + 10, width };
  return { left: vw - width - 16, bottom: 16, width };
}
