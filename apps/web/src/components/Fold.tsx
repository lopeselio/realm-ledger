// A panel that folds to its heading. The page says whether it should be open (folded in a first
// campaign, open otherwise) and it follows that until the player opens or folds it themselves.
import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';

export function Fold({ title, note, open, children, 'data-tour': tour }: { title: string; note?: string; open: boolean; children: ReactNode; 'data-tour'?: string }) {
  const [isOpen, setOpen] = useState(open);
  // the player opened or folded it: from then on it stays as they left it
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpen(open);
  }, [open]);
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>): void => {
    const now = e.currentTarget.open;
    // (a toggle the page made reports the state it set; one that differs is the player's click)
    if (now !== isOpen) {
      touched.current = true;
      setOpen(now);
    }
  };
  return (
    <details className="panel fold" open={isOpen} onToggle={onToggle} data-tour={tour}>
      <summary>
        <h2>{title}</h2>
        {!isOpen && note && <span className="fold-note">{note}: click to open</span>}
      </summary>
      {children}
    </details>
  );
}
