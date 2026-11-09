// The season at a glance: the standing of every realm, where ending the season has got to,
// and what a march would meet.
import { useMemo } from 'react';
import { forecastMarch, friendly, pickTroops, plannedMarches, type Forecast, type ForecastSide, type GameState, type Order } from '@realm-ledger/rules';
import type { View } from '../api.ts';
import { REALM_COLORS } from '../map.ts';
import type { Game } from './useGame.ts';

/** Every realm's campaign score, leader first; the end of the campaign is always in sight. */
export function StandingBar({ v }: { v: View }) {
  const s = v.state;
  const left = Math.max(0, s.maxSeasons - s.season);
  const ranked = s.realms.map((r) => ({ r, score: v.scores[r.id] ?? 0 })).sort((a, b) => b.score - a.score || a.r.id - b.r.id);
  return (
    <div className="standing" role="group" aria-label="Standing">
      <span className="standing-season">
        {v.phase === 'over' ? `Over after ${s.season} seasons` : `Season ${s.season + 1} of ${s.maxSeasons}`}
        {v.phase !== 'over' && <span className="fine"> · {left === 1 ? 'last season' : `${left} left`}</span>}
      </span>
      <ol className="standing-realms">
        {ranked.map(({ r, score }, i) => (
          <li key={r.id} className={`${r.id === v.human ? 'you' : ''} ${r.alive ? '' : 'fallen'}`} title={`${r.name}: ${score} (treasury at market price, plus land, towns and forts)`}>
            <span className="chip" style={{ background: REALM_COLORS[r.id] }} aria-hidden="true" />
            <span className="standing-name">{r.id === v.human ? 'You' : r.name}</span>
            <strong>{r.alive ? score : 'fallen'}</strong>
            {i === 0 && r.alive && (
              <span className="lead" aria-label="leading">
                ▲
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

const STEPS = [
  ['plan', 'Plan'],
  ['seal', 'Seal'],
  ['reveal', 'Reveal'],
  ['resolve', 'Resolve'],
] as const;

/** Plan → Seal → Reveal → Resolve, with the step the season is on. */
export function TurnSteps({ game, v }: { game: Game; v: View }) {
  if (v.phase === 'over') return null;
  // a flow ending another campaign's season doesn't move this one's steps
  const running = game.stage?.campaign === v.id ? game.stage.step : null;
  const at = running ?? (v.phase === 'sealed' ? 'reveal' : 'plan');
  const idx = STEPS.findIndex(([k]) => k === at);
  return (
    <ol className="turn-steps" aria-label="Ending the season">
      {STEPS.map(([k, label], i) => (
        <li key={k} className={i < idx ? 'done' : i === idx ? `now${running ? ' working' : ''}` : ''} aria-current={i === idx ? 'step' : undefined}>
          {label}
        </li>
      ))}
    </ol>
  );
}

/** A short reading of a forecast: the odds, the powers, and what helps the defender. */
export function forecastText(s: GameState, f: Forecast): string {
  const [me, ...them] = f.sides;
  if (f.unopposed) {
    const owner = s.owner[f.province]!;
    if (owner === me!.realm) return 'your own province';
    if (owner === -1) return 'unopposed: an empty province';
    return friendly(s, owner, me!.realm) ? 'a friendly realm’s province: you pass through, it isn’t taken' : 'unguarded: taken if nobody else marches in';
  }
  const d = f.defence;
  const why = [d.terrainBonus ? `${d.terrain} +${d.terrainBonus}` : '', d.fortBonus ? `fort +${d.fortBonus}` : '', d.riverBonus ? `river +${d.riverBonus}` : ''].filter(Boolean);
  const defender = them.find((x) => x.defending);
  const supply = me!.outOfSupply ? ' · you are out of supply −2' : '';
  const range = (x: ForecastSide): string => `${x.ally ? 'ally ' : ''}${x.power[0]}–${x.power[1]}`;
  return `${f.winPct}% to win · you ${range(me!)} vs ${them.map(range).join(', ')}${defender && why.length ? ` · defender ${why.join(', ')}` : ''}${supply}`;
}

/** What your march orders meet, by the province they march into (marches into one province fight together). */
export function useMarchForecasts(v: View, orders: Order[]): Map<number, Forecast> {
  return useMemo(() => {
    const out = new Map<number, Forecast>();
    for (const [to, troops] of plannedMarches(v.state, v.human, orders)) out.set(to, forecastMarch(v.state, v.human, troops, to));
    return out;
  }, [v, orders]);
}

/** Where the selected army can march, each with what it would meet. Tapping one orders it. */
export function MarchTargets({ game, v, from }: { game: Game; v: View; from: number }) {
  const s = v.state;
  const army = game.armyAt(from);
  // what this army would meet in each neighbour, marching alone; worked out once per army and state
  const targets = useMemo(
    () => (army ? s.map.provinces[from]!.neighbors.map((to) => ({ to, f: forecastMarch(s, v.human, pickTroops(army), to) })) : []),
    [s, v.human, from, army],
  );
  if (!army) return null;
  const off = v.phase !== 'planning' || game.busy;
  return (
    <ul className="targets" aria-label="March to">
      {targets.map(({ to, f }) => {
        const tone = f.unopposed ? 'safe' : f.winPct >= 67 ? 'good' : f.winPct >= 34 ? 'even' : 'bad';
        return (
          <li key={to}>
            <button type="button" className={`target ${tone}`} disabled={off} onClick={() => game.clickProvince(to)}>
              <span className="target-name">→ {s.map.provinces[to]!.name}</span>
              <span className="target-odds">{forecastText(s, f)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
