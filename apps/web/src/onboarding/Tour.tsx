// The walkthrough: coach-marks that light up real parts of the page, one at a time.
// A step whose element isn't on the page is skipped. A step with `acted` also moves on by
// itself when the player does the thing it asks for.
// The light doesn't block the page, so the player can act on what it points at.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { reducedMotion, restoreFocus, typingIn } from './storage.ts';

export interface TourStep<S> {
  /** a CSS selector for the element to light up */
  target: string;
  title: string;
  body: ReactNode;
  /** moves on by itself when this says the player did what the step asks, comparing the
   * signals as they were when the step was reached with now */
  acted?: (before: S, now: S) => boolean;
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
/** Controls that use the arrow keys themselves: the tour leaves those keys to them. */
// (fields are already left alone by typingIn)
const ARROW_CONTROLS = 'select, canvas, [role="slider"], [role="listbox"], [role="tablist"], [role="menu"], [role="menubar"], [role="radiogroup"]';
const CARD_ROOM = 230;

function find(sel: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(sel);
  // display:none or hidden elements have no box: treat them as missing
  return el && el.getClientRects().length > 0 ? el : null;
}

export function Tour<S>({ steps, signals, onClose }: { steps: TourStep<S>[]; signals: S; onClose: () => void }) {
  const [present, setPresent] = useState<boolean[]>(() => presentOnPage(steps, -1));
  const [i, setI] = useState(() => nextPresent(present, 0, 1));
  // the light's box, and the step it was measured for: kept through a blip on that step, never
  // shown on another
  const [box, setBox] = useState<(Box & { at: number }) | null>(null);
  // (`present`: which steps' elements are on the page; the current one counts while it lays out)
  const card = useRef<HTMLDivElement>(null);
  const step = i >= 0 && i < steps.length ? steps[i] : undefined;

  // the tour ends when it runs out of steps it can show
  useEffect(() => {
    if (!step) onClose();
  }, [step, onClose]);

  // the card takes focus when the player moves the tour (and when it opens), not when it
  // moves on by itself after they acted, so focus stays on the map or the button they used
  const focusCard = useRef(true);
  // the step shown now, for moves decided a moment earlier (a key, a timer, a watch)
  const shown = useRef(i);
  // (set once a step is committed, not during a render React might throw away)
  useLayoutEffect(() => {
    shown.current = i;
  }, [i]);
  /** Moves one step (to the next one on the page, as the buttons show it). `by` says why: the
   *  player (the card takes focus), their action on the page (focus stays on what they pressed),
   *  or the target going away (nothing was pressed). */
  const go = useCallback(
    (dir: 1 | -1, by: 'player' | 'action' | 'gone' = 'player') => {
      // decided on a step the tour has already left: ignore it
      if (shown.current !== i) return;
      // which steps are on the page right now (a campaign that just opened mounts the table's
      // steps in the same moment), and the buttons follow the same answer
      const p = presentOnPage(steps, i);
      setPresent((old) => sameOr(old, p));
      const n = nextPresent(p, i + dir, dir);
      // nothing earlier to go back to: stay put (the refresh above hides the Back button)
      if (dir === -1 && n < 0) return;
      shown.current = n;
      // the card takes focus when the player moved the tour, or when the element that had focus
      // went away with the step (focus fell back to the page, so the new step would go unannounced)
      const lost = document.activeElement === document.body || document.activeElement === null;
      focusCard.current = by === 'player' || (by === 'gone' && lost);
      setI(n);
    },
    [i, steps],
  );

  // a change in the game (a campaign opening, a phase turning) mounts or removes steps' elements:
  // the buttons follow at once rather than at the next tick
  useLayoutEffect(() => {
    setPresent((old) => sameOr(old, presentOnPage(steps, i)));
  }, [signals, steps, i]);

  // move on when the player does what the step asks
  const start = useRef<{ i: number; signals: S | undefined }>({ i: -1, signals: undefined });
  useEffect(() => {
    // every arrival at a step (forwards or Back) takes a fresh starting point, so something
    // done before the player came back to it doesn't count
    if (start.current.i !== i) {
      start.current = { i, signals };
      return;
    }
    // compared with how things were when the step was reached (the counters only go up, so an
    // order removed and added back still counts; a view reloading back to where it was doesn't)
    if (step?.acted?.(start.current.signals as S, signals)) go(1, 'action');
  }, [i, step, signals, go]);

  // bring the target into view, then follow it as the page moves
  useLayoutEffect(() => {
    if (!step) return;
    // a target that's gone (a campaign closed, a phase changed) moves the tour on, from this
    // step only: if something else moved it meanwhile, this does nothing
    const skip = (): void => go(1, 'gone');
    const updatePresent = (): void => setPresent((old) => sameOr(old, presentOnPage(steps, i)));
    // a target missing for a moment (laying out, re-rendering, the 2D/3D switch) isn't gone: it
    // is skipped only once it has been missing for 400ms
    let missingSince: number | null = null;
    let graceTimer = 0;
    let scrolled = false;
    let observed: Element | null = null;
    const ro = new ResizeObserver(() => measure());
    let frame = 0;
    const look = (): void => {
        const now = find(step.target);
        if (!now) {
          // (the light keeps its last place meanwhile, so a blip doesn't flash)
          if (missingSince === null) {
            missingSince = Date.now();
            window.clearTimeout(graceTimer);
            graceTimer = window.setTimeout(look, 410);
          }
          if (Date.now() - missingSince >= 400) skip();
          return;
        }
        missingSince = null;
        if (observed !== now) {
          if (observed) ro.unobserve(observed);
          ro.observe(now);
          observed = now;
        }
        if (!scrolled) {
          scrolled = true;
          const r = now.getBoundingClientRect();
          if (r.top < 0 || r.bottom > window.innerHeight) {
            now.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? 'start' : 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
          }
        }
        const b = now.getBoundingClientRect();
        setBox((old) =>
          old && old.at === i && old.top === b.top && old.left === b.left && old.width === b.width && old.height === b.height
            ? old
            : { at: i, top: b.top, left: b.left, width: b.width, height: b.height },
        );
    };
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(look);
    };
    // the new step's box before the first paint, so nothing is drawn where the last one was
    // (which steps are on the page was just refreshed by the effect above)
    look();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    // smooth scrolling and late layout (the 3D table loading) move things without events; which
    // steps are on the page is checked here too, not on every scroll frame
    const t = window.setInterval(() => {
      updatePresent();
      measure();
    }, 300);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(graceTimer);
      ro.disconnect();
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      window.clearInterval(t);
    };
  }, [i, step, steps, go]);

  // Esc closes the tour from anywhere but a field. The arrows move it from anywhere except a
  // field or a control that uses arrows itself (a dropdown, a slider, the 3D table); Enter only
  // from the card or nothing in particular, since everywhere else it presses what has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // a key something else already handled (the welcome's last Enter, which started the
      // tour) must not also move it on
      if (e.defaultPrevented || typingIn(e.target)) return;
      const target = e.target as Element | null;
      const ours = target === document.body || target === document.documentElement || (!!target && !!card.current?.contains(target));
      const usesArrows = !!target?.closest?.(ARROW_CONTROLS);
      if (e.key === 'Escape') onClose();
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !usesArrows) go(e.key === 'ArrowRight' ? 1 : -1);
      else if (e.key === 'Enter' && ours && !(target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement)) go(1);
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
  const here = box && box.at === i ? box : null;
  const light = here && clampToView(here);
  const count = present.filter(Boolean).length;
  const at = present.slice(0, i + 1).filter(Boolean).length;
  const hasBack = present.slice(0, i).some(Boolean);
  const isLast = !present.slice(i + 1).some(Boolean);

  return (
    <div className="ob-tour">
      {light && <div className="ob-light" aria-hidden="true" style={light} />}
      <div ref={card} className="ob-card ob-mark" style={placeCard(here)} role="dialog" aria-modal="false" aria-labelledby="ob-mark-title" tabIndex={-1}>
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

/** Just below the header's controls, but never so low a card would run off the screen (a tall
 *  wrapped header on a short window). Measured only when a placement needs it. */
function belowHeader(vh: number): number {
  const header = (document.querySelector('.masthead')?.getBoundingClientRect().bottom ?? 0) + 8;
  return Math.max(16, Math.min(header, vh - CARD_ROOM - 16));
}

/** `old` if `next` says the same, so an unchanged answer doesn't re-render. */
function sameOr(old: boolean[], next: boolean[]): boolean[] {
  return old.length === next.length && old.every((x, k) => x === next[k]) ? old : next;
}

/** Which steps' elements are on the page (the current one counts while it lays out). */
function presentOnPage<S>(steps: TourStep<S>[], current: number): boolean[] {
  return steps.map((s, k) => k === current || !!find(s.target));
}

/** The index of the first step from `from` (going `dir`) marked present; -1 or the length if none. */
function nextPresent(present: boolean[], from: number, dir: 1 | -1): number {
  for (let k = from; k >= 0 && k < present.length; k += dir) if (present[k]) return k;
  return dir === 1 ? present.length : -1;
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
 * Below the target if there's room, else above it, else beside it. Otherwise, on a narrow screen
 * the edge away from the target's middle; on a wide one the bottom-right corner (a target that
 * big is the map, and the top edge holds the header's controls).
 */
function placeCard(box: Box | null): CSSProperties {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const width = Math.min(360, vw - 32);
  const centred = (vw - width) / 2;
  if (!box) return { left: centred, bottom: 16, width };
  // a narrow screen: full width, at the top (below the header's controls) or the bottom, away
  // from the target
  const awayFromTarget = (): CSSProperties => (box.top + box.height / 2 <= vh / 2 ? { left: centred, bottom: 16, width } : { left: centred, top: belowHeader(vh), width });
  if (vw < 560) return awayFromTarget();
  const left = Math.min(Math.max(16, box.left), vw - width - 16);
  if (box.top + box.height + PAD + CARD_ROOM < vh) return { left, top: box.top + box.height + PAD + 10, width };
  if (box.top - PAD > CARD_ROOM) return { left, bottom: vh - box.top + PAD + 10, width };
  // (beside the target, below the header's controls, and on screen)
  const top = Math.max(belowHeader(vh), Math.min(box.top, vh - CARD_ROOM - 16));
  if (vw - (box.left + box.width + PAD) > width + 32) return { left: box.left + box.width + PAD + 16, top, width };
  if (box.left - PAD > width + 32) return { left: box.left - PAD - 16 - width, top, width };
  // a target filling the screen (the map): the bottom-right corner, clear of the header's controls
  return { left: vw - width - 16, bottom: 16, width };
}
