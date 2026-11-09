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
  /** whether a change of the watched value counts as doing what the step asks (default: any change) */
  moved?: (from: unknown, to: unknown) => boolean;
  /** what the player can do to move on, shown under the text */
  hint?: string;
  /** the Next button's label on this step */
  next?: string;
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
      setI((cur) => (cur === i ? n : cur));
    },
    [steps, i],
  );

  // move on when the player does what the step asks
  const watched = step?.watch?.(signals);
  const start = useRef<{ i: number; value: unknown }>({ i: -1, value: undefined });
  useEffect(() => {
    // every arrival at a step (forwards or Back) takes a fresh starting point, so a change made
    // before the player came back to it doesn't count
    if (start.current.i !== i) {
      start.current = { i, value: watched };
      return;
    }
    if (!step?.watch) return;
    const moved = step.moved ?? ((a: unknown, b: unknown) => !Object.is(a, b));
    if (moved(start.current.value, watched)) go(1, false);
    // keep following the value, so (say) an order removed and added back counts once
    else start.current = { i, value: watched };
  }, [i, step, watched, go]);

  // bring the target into view, then follow it as the page moves
  useLayoutEffect(() => {
    if (!step) return;
    // a target that's gone (a campaign closed, a phase changed) moves the tour on, from this
    // step only: if something else moved it meanwhile, this does nothing
    const skip = (): void => setI((cur) => (cur === i ? firstPresent(steps, i + 1, 1) : cur));
    const el = find(step.target);
    if (!el) {
      setBox(null);
      // it may only be laying out (the 3D table): give it a moment before skipping
      const t = window.setTimeout(() => {
        if (!find(step.target)) skip();
      }, 400);
      return () => window.clearTimeout(t);
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
        if (!now) {
          skip();
          return;
        }
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
  }, [i, step, steps]);

  // Esc closes the tour from anywhere but a field; the arrows and Enter move it only when focus
  // is on the card or on nothing in particular, so the rest of the page keeps its keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // a key something else already handled (the welcome's last Enter, which started the
      // tour) must not also move it on
      if (e.defaultPrevented || typingIn(e.target)) return;
      const target = e.target as Node | null;
      const ours = target === document.body || target === document.documentElement || (!!target && !!card.current?.contains(target));
      // buttons and links don't use the arrows, and after the tour moves on by itself focus
      // stays on the one the player pressed
      const onControl = e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement;
      const arrow = e.key === 'ArrowRight' || e.key === 'ArrowLeft';
      if (e.key === 'Escape') onClose();
      else if (!ours && !(arrow && onControl)) return;
      else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !onControl)) go(1);
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
  // which steps' elements are on the page: looked up once per render
  const present = steps.map((s) => !!find(s.target));
  const count = present.filter(Boolean).length;
  const at = present.slice(0, i + 1).filter(Boolean).length;
  const hasBack = present.slice(0, i).some(Boolean);
  const isLast = !present.slice(i + 1).some(Boolean);

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
          {hasBack && (
            <button type="button" onClick={() => go(-1)}>
              Back
            </button>
          )}
          <button type="button" className="primary" onClick={() => go(1)}>
            {isLast ? 'Done' : (step.next ?? 'Next')}
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

/**
 * Below the target if there's room, else above it, else beside it, else at the screen edge
 * farther from the target's middle, so the card covers as little of what it points at as it can.
 */
function placeCard(box: Box | null): CSSProperties {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const width = Math.min(360, vw - 32);
  const centred = (vw - width) / 2;
  if (!box) return { left: centred, bottom: 16, width };
  // a narrow screen: full width, at the top or bottom, away from the target
  const awayFromTarget = (left: number): CSSProperties => (box.top + box.height / 2 > vh / 2 ? { left, top: 16, width } : { left, bottom: 16, width });
  if (vw < 560) return awayFromTarget(centred);
  const left = Math.min(Math.max(16, box.left), vw - width - 16);
  if (box.top + box.height + PAD + CARD_ROOM < vh) return { left, top: box.top + box.height + PAD + 10, width };
  if (box.top - PAD > CARD_ROOM) return { left, bottom: vh - box.top + PAD + 10, width };
  const top = Math.max(16, Math.min(box.top, vh - CARD_ROOM - 16));
  if (vw - (box.left + box.width + PAD) > width + 32) return { left: box.left + box.width + PAD + 16, top, width };
  if (box.left - PAD > width + 32) return { left: box.left - PAD - 16 - width, top, width };
  // a target filling the screen (the map): the bottom-right corner, clear of the header's controls
  return { left: vw - width - 16, bottom: 16, width };
}
