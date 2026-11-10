// The season at a glance: the standing of every realm, where ending the season has got to,
// and what a march would meet.
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { forecastMarch, friendly, pickTroops, treatyBetween, plannedMarches, type Forecast, type ForecastSide, type GameState, type Order } from '@realm-ledger/rules';
import type { View } from '../api.ts';
import { colorOf } from '../map.ts';
import type { Game } from './useGame.ts';

/** Every realm's campaign score, leader first; the end of the campaign is always in sight. */
export function StandingBar({ v }: { v: View }) {
  const s = v.state;
  const left = Math.max(0, s.maxSeasons - s.season);
  const ranked = s.realms.map((r) => ({ r, score: v.scores[r.id] ?? 0 })).sort((a, b) => b.score - a.score || a.r.id - b.r.id);
  // the winner once there is one; before that, the realm the last winter would crown (the best
  // score among the living, ties to the lower realm id, as in the rules)
  const leader = v.winner ?? ranked.find((x) => x.r.alive)?.r.id ?? null;
  return (
    <div className="standing" role="group" aria-label="Standing">
      <span className="standing-season">
        {v.phase === 'over' ? `Over after ${s.season} seasons` : `Season ${s.season + 1} of ${s.maxSeasons}`}
        {v.phase !== 'over' && <span className="fine"> · {left === 1 ? 'last season' : `${left} left`}</span>}
      </span>
      <ol className="standing-realms">
        {ranked.map(({ r, score }) => (
          <li key={r.id} className={`${r.id === v.human ? 'you' : ''} ${r.alive ? '' : 'fallen'}`} title={`${r.name}: ${score} (treasury at market price, plus land, towns and forts)`}>
            <span className="chip" style={{ background: colorOf(r.id) }} aria-hidden="true" />
            <span className="standing-name">{r.id === v.human ? 'You' : r.name}</span>
            <strong>{r.alive ? score : 'fallen'}</strong>
            {/* the realm the last winter would crown: ties go to the lower realm id, as in the rules */}
            {r.id === leader && (
              <span className="lead" role="img" aria-label={v.winner === null ? 'leading' : 'winner'}>
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

/**
 * On a phone, what you are doing stays under your thumb: the province you picked, where its army
 * can march (with forecasts) or what you can build there, and End season. Hidden on wider screens,
 * where the orders panel sits beside the map.
 */
export function PhoneDock({ game, v, selection }: { game: Game; v: View; selection: ReactNode }) {
  const dock = useRef<HTMLDivElement>(null);
  const over = v.phase === 'over';
  // the page keeps room under itself for the dock as it grows and shrinks, only while there is one
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const body = document.body;
    body.classList.add('has-dock');
    const o = new ResizeObserver(() => body.style.setProperty('--dock-h', `${el.offsetHeight}px`));
    o.observe(el);
    return () => {
      o.disconnect();
      body.classList.remove('has-dock');
      body.style.removeProperty('--dock-h');
    };
  }, [over]);
  if (over) return null;
  return (
    <div className="phone-dock" role="region" aria-label="Your move" ref={dock}>
      {v.phase === 'planning' && (game.selected !== undefined ? <div className="dock-selection">{selection}</div> : <p className="fine dock-hint">Tap your army or one of your provinces on the map.</p>)}
      <div className="dock-bar">
        <a href="#orders" className="dock-orders">
          {ordersCount(game.orders.length)}
        </a>
        <EndSeasonButton game={game} v={v} short />
      </div>
    </div>
  );
}

/** Whether you can act on the campaign now: planning, and no flow running. One rule for every order button. */
export const canAct = (g: Game): boolean => !!g.view && g.view.phase === 'planning' && !g.busy;

const ordersCount = (n: number): string => (n === 1 ? '1 order' : `${n} orders`);

/** Seals your orders and ends the season; one button for the orders panel and the phone dock. */
export function EndSeasonButton({ game, v, short = false }: { game: Game; v: View; short?: boolean }) {
  const planning = canAct(game);
  return (
    <button type="button" className={`primary end-season${short ? '' : ' wide'}`} {...(short ? {} : { 'data-tour': 'seal' })} disabled={!planning} onClick={() => void game.seal()}>
      {game.stage?.campaign === v.id ? 'Ending the season…' : short ? 'End season' : `End season: seal ${ordersCount(game.orders.length)}`}
    </button>
  );
}

/** A short reading of a forecast: the odds, the powers, and what helps the defender. */
export function forecastText(s: GameState, f: Forecast): string {
  const [me, ...them] = f.sides;
  // marching on a peace partner's land or army breaks the peace, guarded or not
  const owner = s.owner[f.province]!;
  const partners = new Set([owner, ...them.map((x) => x.realm)].filter((r) => r >= 0 && r !== me!.realm && treatyBetween(s, r, me!.realm, 'peace')));
  const peace = partners.size ? ' · breaks your peace' : '';
  if (f.unopposed) {
    if (owner === me!.realm) return 'your own province';
    if (owner === -1) return 'unopposed: an empty province';
    if (friendly(s, owner, me!.realm)) return 'a friendly realm’s province: you pass through, it isn’t taken';
    // an ally standing there takes it instead if it is stronger
    const rival = them.some((x) => x.ally) ? ', or by the stronger of you and your ally there' : '';
    return `unguarded: taken if nobody else marches in${rival}${peace}`;
  }
  const d = f.defence;
  const why = [d.terrainBonus ? `${d.terrain} +${d.terrainBonus}` : '', d.fortBonus ? `fort +${d.fortBonus}` : '', d.riverBonus ? `river +${d.riverBonus}` : ''].filter(Boolean);
  const defender = f.sides.find((x) => x.defending);
  const supply = me!.outOfSupply ? ' · you are out of supply −2' : '';
  const range = (x: ForecastSide): string => `${x.ally ? 'ally ' : ''}${x.power[0]}–${x.power[1]}`;
  return `${f.winPct}% to win · you ${range(me!)} vs ${them.map(range).join(', ')}${defender && why.length ? ` · ${defender === me ? 'you defend' : 'defender'} ${why.join(', ')}` : ''}${supply}${peace}`;
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
  const orders = game.orders;
  // what this army would meet in each neighbour, together with your other marches there: as if
  // this army's march went there instead of where it is ordered now
  const targets = useMemo(() => {
    if (!army) return [];
    const others = orders.filter((o) => !(o.kind === 'march' && o.from === from));
    return s.map.provinces[from]!.neighbors.map((to) => {
      const into = plannedMarches(s, v.human, [...others, { kind: 'march', from, to }]);
      return { to, f: forecastMarch(s, v.human, into.get(to) ?? pickTroops(army), to) };
    });
  }, [s, v.human, from, army, orders]);
  if (!army) return null;
  const off = !canAct(game);
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
