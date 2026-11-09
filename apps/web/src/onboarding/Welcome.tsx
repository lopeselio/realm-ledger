// The first-run welcome: four short cards before the war table. Enter or → goes on, ← goes
// back, Esc skips. Closing it either way marks it seen.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { restoreFocus, typingIn } from './storage.ts';

interface Slide {
  kicker: string;
  title: string;
  body: ReactNode;
}

const SLIDES: Slide[] = [
  {
    kicker: 'The realm',
    title: 'Rule a realm. Trust no one.',
    body: (
      <>
        <p>
          You rule the <strong className="red">red realm</strong> against two to four AI rulers. Each has its own NEAR account, a treasury and a secret agenda.
        </p>
        <p>They answer your envoys in plain words, hire spies and swords, and may lie. Their orders stay sealed until the season turns.</p>
      </>
    ),
  },
  {
    kicker: 'A season',
    title: 'Plan, seal, reveal, turn',
    body: (
      <ol className="ob-beats">
        <li>
          <strong>Plan.</strong> March armies, fortify, raise levies, build, trade. Send envoys and give your Chancellor a task.
        </li>
        <li>
          <strong>Seal.</strong> Your browser hashes your orders with a secret salt. Only the hash goes onchain, and every ruler seals at once.
        </li>
        <li>
          <strong>Reveal.</strong> Everyone opens their orders. The contract checks each one against its seal.
        </li>
        <li>
          <strong>Turn.</strong> All orders resolve together: marches, battles, harvests, prices. The chronicle tells you what happened.
        </li>
      </ol>
    ),
  },
  {
    kicker: 'Victory and fair play',
    title: 'Hold the most crowns',
    body: (
      <>
        <p>
          Win by holding the most crowns of land and treasury at the last season, or by taking every rival capital.
        </p>
        <p>
          NEAR keeps it fair. Seals posted onchain mean nobody can change an order after seeing yours. Battle rolls and every ruler’s agenda were committed before the first season, so
          anyone can replay the campaign and check it.
        </p>
      </>
    ),
  },
  {
    kicker: 'Where to start',
    title: 'Set the table',
    body: (
      <>
        <p>
          Choose how many rivals and how many seasons, then press <strong>New campaign</strong>. Or pick up one you started from the list.
        </p>
        <p>Sign in with a NEAR testnet wallet to rule from your own account, or play as a guest with no wallet.</p>
        <p className="ob-note">The walkthrough points at each part of the table as you play. The “?” button reopens this guide at any time.</p>
      </>
    ),
  },
];

export function Welcome({ onClose, onTour }: { onClose: () => void; onTour: () => void }) {
  const [i, setI] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const last = i === SLIDES.length - 1;
  const slide = SLIDES[i]!;

  // focus the card so the keys work at once, and give focus back afterwards
  useEffect(() => {
    const before = document.activeElement;
    box.current?.focus();
    return () => restoreFocus(before);
  }, []);

  const next = (): void => (last ? onTour() : setI(i + 1));
  const back = (): void => setI(Math.max(0, i - 1));

  const onKey = (e: KeyboardEvent): void => {
    if (typingIn(e.target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement))) {
      // Enter on a focused button presses that button instead
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      back();
    } else if (e.key === 'Tab') trapFocus(e, box.current);
  };

  return (
    <div className="ob-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ob-card ob-welcome" role="dialog" aria-modal="true" aria-labelledby="ob-title" tabIndex={-1} ref={box} onKeyDown={onKey}>
        <p className="ob-kicker">
          {slide.kicker} · {i + 1} of {SLIDES.length}
        </p>
        <h2 id="ob-title">{slide.title}</h2>
        <div className="ob-body" aria-live="polite">
          {slide.body}
        </div>
        <div className="ob-dots" role="tablist" aria-label="Welcome cards">
          {SLIDES.map((s, k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === i}
              aria-label={`Card ${k + 1}: ${s.title}`}
              className={k === i ? 'on' : ''}
              onClick={() => setI(k)}
            />
          ))}
        </div>
        <div className="ob-nav">
          <button type="button" className="ob-skip" onClick={onClose}>
            Skip
          </button>
          <span className="ob-grow" />
          {i > 0 && (
            <button type="button" onClick={back}>
              Back
            </button>
          )}
          {last ? (
            <>
              <button type="button" onClick={onClose}>
                Start playing
              </button>
              <button type="button" className="primary" onClick={onTour}>
                Show me around
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={next}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Keep Tab inside a dialog. */
export function trapFocus(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
  if (items.length === 0) return;
  const first = items[0]!;
  const lastItem = items[items.length - 1]!;
  if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    e.preventDefault();
    lastItem.focus();
  } else if (!e.shiftKey && document.activeElement === lastItem) {
    e.preventDefault();
    first.focus();
  }
}
