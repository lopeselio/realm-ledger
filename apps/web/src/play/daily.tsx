// The daily challenge's board: everyone plays the same map on a UTC day; finished campaigns are
// ranked by your realm's final score, each linked to its campaign (and from there its proof).
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { QUICK_MATCH, utcDay } from '@realm-ledger/rules';
import { api } from '../api.ts';

interface Entry {
  id: number;
  player: string | null;
  phase: 'planning' | 'sealed' | 'over';
  season: number;
  maxSeasons: number;
  score: number;
  conquest: boolean;
  rank: number | null;
}

/** Today's board (UTC), or `date`'s; `mine` marks the campaign on screen, fetched again whenever `progress` changes. */
export function DailyBoard({ date, mine, progress }: { date?: string; mine?: number; progress?: string }) {
  const [board, setBoard] = useState<{ date: string; today: boolean; entries: Entry[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    // another day's board isn't shown while this one loads
    setBoard((b) => (b && date && b.date !== date ? null : b));
    api<{ date: string; today?: boolean; entries: Entry[] }>(`/daily${date ? `?date=${date}` : ''}`)
      .then((b) => {
        if (!live) return;
        setFailed(false);
        setBoard({ ...b, today: b.today ?? b.date === utcDay(Date.now()) });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [date, mine, progress]);
  // nothing to show yet and the board can't be reached: leave it out (a later fetch may bring it)
  if (failed && !board) return null;
  const done = board?.entries.filter((e) => e.rank !== null) ?? [];
  const playing = board?.entries.filter((e) => e.rank === null).length ?? 0;
  const today = !board || board.today;
  const rivals = QUICK_MATCH.realms - 1;
  return (
    <section className="daily" aria-label="Daily challenge">
      <h2>Daily challenge{board ? ` · ${board.date}` : ''}</h2>
      <p className="fine">
        Everyone gets the same map {today ? 'today' : 'that day'}: a quick match against {rivals} AI rulers. Best final score wins the day; taking every rival capital beats any score.
      </p>
      {!board ? (
        <p className="fine">Loading the board…</p>
      ) : done.length === 0 ? (
        <p className="fine">
          {today ? `No one has finished today's map yet${playing ? ` (${playing} playing)` : ''}. Choose “Daily challenge” as the length and start.` : 'No one finished that day’s map.'}
        </p>
      ) : (
        <>
          <ol className="daily-board">
            {done.slice(0, 10).map((e) => (
              <li key={e.id} className={e.id === mine ? 'mine' : ''}>
                <span className="daily-rank">{e.rank}</span>
                <span className="daily-who">{e.player ?? `guest #${e.id}`}</span>
                <strong>{e.conquest ? 'conquest' : e.score}</strong>
                <Link to={`/play/${e.id}`}>campaign</Link>
              </li>
            ))}
          </ol>
          {playing > 0 && <p className="fine">{playing} still playing.</p>}
        </>
      )}
    </section>
  );
}
