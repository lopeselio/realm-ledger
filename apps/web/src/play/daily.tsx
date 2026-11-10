// The boards: the daily challenge's (everyone plays the same map on a UTC day) and a challenge
// between friends (everyone with the link plays its map). Finished campaigns are ranked by your
// realm's final score, each linked to its campaign (and from there its proof).
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
        Everyone gets the same map {today ? 'today' : 'that day'}: a quick match against {rivals} AI rulers (their secret aims are your campaign's own). Best final score wins the day; taking every rival capital beats any score.
      </p>
      {!board ? (
        <p className="fine">Loading the board…</p>
      ) : done.length === 0 ? (
        <p className="fine">
          {today ? `No one has finished today's map yet${playing ? ` (${playing} playing)` : ''}. Choose “Daily challenge” as the length and start.` : 'No one finished that day’s map.'}
        </p>
      ) : (
        <Ranked done={done} playing={playing} mine={mine} />
      )}
    </section>
  );
}

/** The ranked finishes (the top ten, and yours if it ranks lower), then how many are still playing. */
function Ranked({ done, playing, mine }: { done: Entry[]; playing: number; mine?: number | undefined }) {
  return (
    <>
      <ol className="daily-board">
        {[...done.slice(0, 10), ...done.slice(10).filter((e) => e.id === mine)].map((e) => (
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
  );
}

/** A challenge's board and the link to share it; `mine` marks the campaign on screen. */
export function ChallengeBoard({ code, mine, progress, onMissing }: { code: string; mine?: number; progress?: string; onMissing?: () => void }) {
  const [board, setBoard] = useState<{ code: string; entries: Entry[] } | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);
  // another challenge: start afresh, not with the last one's board or "Copied"
  useEffect(() => {
    setBoard(null);
    setMissing(false);
    setCopied(false);
  }, [code]);
  useEffect(() => {
    let live = true;
    api<{ entries: Entry[] }>(`/challenge/${code}`)
      .then((b) => live && setBoard({ code, entries: b.entries }))
      .catch((e: unknown) => {
        // no such challenge (a mistyped or stale link): say so, rather than load forever
        if (!live || !/no such challenge/.test((e as Error).message)) return;
        setMissing(true);
        onMissing?.();
      });
    return () => {
      live = false;
    };
  }, [code, mine, progress]);
  const entries = board?.code === code ? board.entries : null;
  const link = `${window.location.origin}/challenge/${code}`;
  const share = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // the link is on screen to copy by hand
    }
  };
  const done = entries?.filter((e) => e.rank !== null) ?? [];
  const playing = entries?.filter((e) => e.rank === null).length ?? 0;
  return (
    <section className="daily" aria-label="Challenge">
      <h2>Challenge {code}</h2>
      <p className="fine">
        Send this link to a friend: they play the same map against {QUICK_MATCH.realms - 1} AI rulers ({QUICK_MATCH.maxSeasons} seasons), and this board compares your results. Best final
        score wins; taking every rival capital beats any score.
      </p>
      <p className="challenge-link">
        <input readOnly value={link} aria-label="Challenge link" onFocus={(e) => e.currentTarget.select()} />{' '}
        <button type="button" onClick={() => void share()}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </p>
      {missing ? (
        <p className="fine">This link doesn't lead to a challenge: check it with whoever sent it.</p>
      ) : entries === null ? (
        <p className="fine">Loading the board…</p>
      ) : done.length === 0 ? (
        <p className="fine">No one has finished this map yet{playing ? ` (${playing} playing)` : ''}.</p>
      ) : (
        <Ranked done={done} playing={playing} mine={mine} />
      )}
    </section>
  );
}
