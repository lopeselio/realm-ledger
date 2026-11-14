// The first season's guide: a checklist pinned above the war table in your first campaign. Each
// step lights up from the game's real state (an army selected, a march ordered, the season
// sealed), stays lit once done, and has a "Show me" that lights up the control it means, using
// the walkthrough's coach-mark. It can be dismissed, and "How to play" brings it back.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Order } from '@realm-ledger/rules';
import type { View } from '../api.ts';
import { usePhone } from '../media.ts';
import type { Game } from '../play/useGame.ts';
import { recentCampaigns } from '../recent.ts';
import { Tour, type TourStep } from './Tour.tsx';

export type StepId = 'army' | 'march' | 'build' | 'envoy' | 'chancellor' | 'seal' | 'watch';

/** What this browser remembers: which campaign is the first, and what has been done in it. */
interface Saved {
  campaign: number;
  done: StepId[];
  /** the player opened a reply's "TEE-signed ✓ verify" */
  verified?: boolean;
  dismissed?: boolean;
}

const KEY = 'realm-ledger:first-season';
/** How long after the season turns its playback runs, before "watch" counts as done. */
const WATCH_MS = 4600;
const BUILDS: Order['kind'][] = ['fortify', 'levy', 'recruit', 'build'];

function read(): Saved | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
    return v && Number.isInteger(v.campaign) && Array.isArray(v.done) ? v : null;
  } catch {
    return null;
  }
}

function write(v: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // not remembered: the guide keeps going for this visit only
  }
}

interface StepInfo {
  id: StepId;
  /** the chip's short name */
  short: string;
  label: string;
  optional?: boolean;
}

const STEPS: StepInfo[] = [
  { id: 'army', short: 'Army', label: 'Select your army' },
  { id: 'march', short: 'March', label: 'March to a highlighted province' },
  { id: 'build', short: 'Build', label: 'Build or recruit' },
  { id: 'envoy', short: 'Envoy', label: 'Send an envoy and verify the reply', optional: true },
  { id: 'chancellor', short: 'Chancellor', label: 'Give the Chancellor a task', optional: true },
  { id: 'seal', short: 'Seal', label: 'End season: seal your orders' },
  { id: 'watch', short: 'Watch', label: 'Watch the season play out' },
];
const REQUIRED = STEPS.filter((s) => !s.optional);

/** The first element of these selectors that is on the page and shown. */
function firstShown(selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.getClientRects().length > 0) return sel;
  }
  return null;
}

export interface FirstSeasonGuide {
  /** the guide is on screen for this campaign */
  active: boolean;
  /** every required step is done (the guide stays until closed) */
  finished: boolean;
  /** a province for the table's beacon: your army, until you first select it */
  beacon: number | undefined;
  /** the strip above the table (null when the guide isn't active) */
  strip: ReactNode;
  /** the phone dock's one-line version (null when not active) */
  dockLine: ReactNode;
  /** the "Show me" coach-mark, rendered once by the page */
  spotlight: ReactNode;
  /** brings the guide back for the campaign on screen (from "How to play"), or null if it can't */
  restore: (() => void) | null;
}

export function useFirstSeason(game: Game): FirstSeasonGuide {
  const v = game.view;
  const phone = usePhone();
  const [saved, setSaved] = useState<Saved | null>(read);
  const update = useCallback((fn: (s: Saved | null) => Saved | null) => {
    setSaved((old) => {
      const next = fn(old);
      if (next && next !== old) write(next);
      return next;
    });
  }, []);

  // a fresh campaign becomes the first one if this browser has played none before, or if the guide
  // was left unfinished in an earlier one (a campaign opened from a link, already under way, never is)
  const fresh = !!v && v.phase === 'planning' && v.state.season === 0;
  const id = v?.id ?? null;
  useEffect(() => {
    if (!fresh || id === null) return;
    update((old) => {
      if (old?.campaign === id) return old;
      if (old ? old.dismissed || REQUIRED.every((s) => old.done.includes(s.id)) : recentCampaigns().some((c) => c !== id)) return old;
      return { campaign: id, done: [] };
    });
  }, [fresh, id, update]);

  const active = !!v && !!saved && saved.campaign === v.id && !saved.dismissed;
  const done = useMemo(() => new Set(active ? saved!.done : []), [active, saved]);

  // what the game shows now, step by step (latched into `done` below, so a draft cleared when the
  // season turns doesn't unlight its steps)
  const live = useMemo(() => {
    const out = new Set<StepId>();
    if (!v || !active) return out;
    const orders = game.orders;
    const march = orders.some((o) => o.kind === 'march');
    if (march || (game.selected !== undefined && game.armyAt(game.selected))) out.add('army');
    if (march) out.add('march');
    if (orders.some((o) => BUILDS.includes(o.kind))) out.add('build');
    // a reply that can't be opened in NEAR AI's Verification Center counts once sent
    if (v.envoys.length > 0 && (saved?.verified || v.envoys.every((e) => !e.verifyUrl))) out.add('envoy');
    if (v.plans.length > 0) out.add('chancellor');
    if (v.phase !== 'planning' || v.state.season > 0) out.add('seal');
    return out;
    // armyAt reads the view
  }, [v, active, saved?.verified, game.orders, game.selected]);

  useEffect(() => {
    const add = [...live].filter((s) => !done.has(s));
    if (add.length) update((old) => (old ? { ...old, done: [...old.done, ...add] } : old));
  }, [live, done, update]);

  // the season has turned: once its playback has run, "watch" is done
  const turned = !!v && v.state.season > 0;
  useEffect(() => {
    if (!active || !turned || done.has('watch')) return;
    const t = window.setTimeout(() => update((old) => (old && !old.done.includes('watch') ? { ...old, done: [...old.done, 'watch'] } : old)), WATCH_MS);
    return () => window.clearTimeout(t);
  }, [active, turned, done, update]);

  // opening a reply's "TEE-signed ✓ verify" link (it opens in a new tab)
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest?.('a.tag.tee')) update((old) => (old && !old.verified ? { ...old, verified: true } : old));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [active, update]);

  const [picked, setPicked] = useState<StepId | null>(null);
  const [showing, setShowing] = useState<StepId | null>(null);
  // a step picked from the chips that gets done hands back to the next one
  useEffect(() => {
    if (picked && done.has(picked)) setPicked(null);
  }, [picked, done]);

  const closeShowMe = useCallback(() => setShowing(null), []);
  const dismiss = useCallback(() => {
    setShowing(null);
    update((old) => (old ? { ...old, dismissed: true } : old));
  }, [update]);
  const restore = useMemo(
    () =>
      v && v.phase !== 'over'
        ? () => update((old) => (old?.campaign === v.id ? { ...old, dismissed: false } : { campaign: v.id, done: [] }))
        : null,
    [v, update],
  );

  const army = v?.state.armies.find((a) => a.realm === v.human)?.province;
  const beacon = active && !done.has('army') && game.selected === undefined ? army : undefined;

  if (!v || !active) return { active: false, finished: false, beacon: undefined, strip: null, dockLine: null, spotlight: null, restore };

  const next = REQUIRED.find((s) => !done.has(s.id)) ?? null;
  const shown = STEPS.find((s) => s.id === picked) ?? next;
  const finished = next === null;
  const sealing = game.stage?.campaign === v.id || v.phase === 'sealed';
  const hint = (id: StepId): string => hintFor(id, v, game, saved?.verified ?? false, sealing);
  const number = (id: StepId): number => STEPS.findIndex((s) => s.id === id) + 1;
  const optionalLeft = STEPS.filter((s) => s.optional && !done.has(s.id));

  const showMe = (id: StepId): void => setShowing(id);

  const chips = (
    <ol className="fs-steps">
      {STEPS.map((s, k) => {
        const isDone = done.has(s.id);
        return (
          <li key={s.id}>
            <button
              type="button"
              className={`fs-step${isDone ? ' done' : ''}${shown?.id === s.id ? ' on' : ''}${s.optional ? ' opt' : ''}`}
              aria-pressed={shown?.id === s.id}
              aria-label={`Step ${k + 1}${s.optional ? ' (optional)' : ''}: ${s.label}${isDone ? ', done' : ''}`}
              title={s.label}
              onClick={() => setPicked(s.id)}
            >
              <span className="fs-num" aria-hidden="true">
                {isDone ? '✓' : k + 1}
              </span>
              <span className="fs-short" aria-hidden="true">
                {s.short}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  const strip = (
    <section className={`fs${finished ? ' fs-finished' : ''}${picked ? ' fs-picked' : ''}`} aria-label="First season guide" data-quest="strip">
      <div className="fs-head">
        <h3 className="fs-title">First season</h3>
        <span className="fs-count">
          {REQUIRED.filter((s) => done.has(s.id)).length} of {REQUIRED.length} done
        </span>
        {chips}
        <button type="button" className="fs-x" aria-label="Dismiss the first-season guide" title="Dismiss (How to play brings it back)" onClick={dismiss}>
          ✕
        </button>
      </div>
      {finished && !picked ? (
        <div className="fs-now">
          <p>
            <strong>Your first season is played.</strong>{' '}
            <span className="fs-hint">
              The rest of the campaign is yours. The Chronicle lists what everyone did; Realms and The proof are open below.
              {optionalLeft.length > 0 && ` Still to try: ${optionalLeft.map((s) => s.short.toLowerCase()).join(' and ')}.`}
            </span>
          </p>
          <button type="button" className="primary" onClick={dismiss}>
            Close the guide
          </button>
        </div>
      ) : (
        shown && (
          <div className="fs-now">
            <p>
              <strong>
                {number(shown.id)}. {shown.label}
              </strong>
              {shown.optional && <em className="fs-opt"> optional</em>}
              {done.has(shown.id) && <span className="fs-done"> ✓ done</span>} <span className="fs-hint">{hint(shown.id)}</span>
            </p>
            <div className="fs-actions">
              {shown.id === 'seal' &&
                !sealing &&
                optionalLeft.map((s) => (
                  <button key={s.id} type="button" onClick={() => setPicked(s.id)}>
                    First try {number(s.id)}: {s.short}
                  </button>
                ))}
              <button type="button" className="primary" onClick={() => showMe(shown.id)}>
                Show me
              </button>
            </div>
          </div>
        )
      )}
    </section>
  );

  const dockLine =
    !finished && next ? (
      <div className="fs-dock" data-quest="dock">
        <span className="fs-dock-text">
          <strong>
            First season {number(next.id)}/{STEPS.length}:
          </strong>{' '}
          {next.label}
        </span>
        <button type="button" onClick={() => showMe(next.id)}>
          Show me
        </button>
      </div>
    ) : null;

  const target = showing ? targetFor(showing, v, game, phone) : null;
  const spotlight =
    showing && target ? (
      <ShowMe key={showing} target={target} title={STEPS.find((s) => s.id === showing)!.label} text={hint(showing)} progress={done.size} onClose={closeShowMe} />
    ) : null;

  return { active, finished, beacon, strip, dockLine, spotlight, restore };
}

/**
 * One coach-mark from the walkthrough, on the control a step means. It closes by itself once a
 * step gets done. (Built from strings, so it stays the same step while the page re-renders.)
 */
function ShowMe({ target, title, text, progress, onClose }: { target: string; title: string; text: string; progress: number; onClose: () => void }) {
  const steps = useMemo<TourStep<number>[]>(() => [{ target, title, body: <p>{text}</p>, acted: (before, now) => now > before }], [target, title, text]);
  return <Tour steps={steps} signals={progress} onClose={onClose} kicker="First season · show me" />;
}

/** A rival's capital to suggest to the Chancellor. */
function rivalCapital(v: View): string | null {
  const r = v.state.realms.find((x) => x.id !== v.human && x.alive);
  return r ? (v.state.map.provinces[r.capital]?.name ?? null) : null;
}

function hintFor(id: StepId, v: View, game: Game, verified: boolean, sealing: boolean): string {
  const armySelected = game.selected !== undefined && !!game.armyAt(game.selected);
  switch (id) {
    case 'army':
      return 'Click the red circle on the table (the pulsing ring). Your orders then lists where it can march.';
    case 'march':
      return armySelected
        ? 'Click a glowing province, or one of the forecasts listed under Your orders: each shows your odds.'
        : 'Select your army first, then click a glowing province or one of its forecasts.';
    case 'build':
      return 'Select one of your provinces (your capital ♛ works), then press Fortify, Raise levies or Recruit. Each shows its cost.';
    case 'envoy':
      return v.envoys.length > 0 && !verified
        ? 'Now click “TEE-signed ✓ verify” on the reply: NEAR AI’s Verification Center checks its signature in your browser.'
        : 'Write to a rival under Envoys (a treaty is optional). The reply is signed in a TEE: click “TEE-signed ✓ verify” on it.';
    case 'chancellor': {
      const cap = rivalCapital(v);
      return `Under Chancellor, give a task such as “Find out what guards ${cap ?? 'a rival capital'}” with a budget of 25. It hires a spy through escrow.`;
    }
    case 'seal':
      return sealing
        ? 'Sealing: every ruler’s hash goes onchain, then the orders are revealed. The season turns in about 10 seconds.'
        : 'Press End season. Your browser hashes your orders with a secret salt; only the hash goes onchain until every ruler has sealed.';
    case 'watch':
      return 'When the season turns, armies march across the table, battles flash and captured provinces raise new banners. The Chronicle lists it all.';
  }
}

/** What "Show me" lights up for a step: the control itself where it is shown, else the table. */
function targetFor(id: StepId, v: View, game: Game, phone: boolean): string | null {
  const map = '[data-tour="map"]';
  const armySelected = game.selected !== undefined && !!game.armyAt(game.selected);
  const options: Record<StepId, string[]> = {
    army: [map],
    march: armySelected ? ['.selection .targets', '.dock-selection .targets', map] : [map],
    build: ['.selection .actions', '.dock-selection .actions', map],
    envoy: v.envoys.some((e) => e.verifyUrl) ? ['[data-tour="envoys"] a.tag.tee', '[data-tour="envoys"]'] : ['[data-tour="envoys"]'],
    chancellor: ['[data-quest="chancellor"]'],
    seal: phone ? ['.phone-dock .end-season', '[data-tour="seal"]'] : ['[data-tour="seal"]', '.phone-dock .end-season'],
    watch: [map],
  };
  return firstShown(options[id]);
}
