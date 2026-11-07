import type { GameEvent, GameState } from '@realm-ledger/rules';
import { chronicle } from '../chronicle.ts';

/** A season's events as chronicle lines, most dramatic first. */
export function ChronicleLines({ before, events, limit, empty }: { before: GameState; events: GameEvent[]; limit: number; empty: string }) {
  const lines = chronicle(before, events);
  if (!lines.length) return <li className="quiet">{empty}</li>;
  return (
    <>
      {lines.slice(0, limit).map((l, i) => (
        <li key={i} className={l.tone}>
          {l.text}
        </li>
      ))}
    </>
  );
}
