// The season at a glance: the standing of every realm, where ending the season has got to,
// and what a march would meet.
import { forecastMarch, type Forecast, type GameState, type Order, type Troops } from '@realm-ledger/rules';
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
  const at = game.stage ?? (v.phase === 'sealed' ? 'reveal' : 'plan');
  const idx = STEPS.findIndex(([k]) => k === at);
  return (
    <ol className="turn-steps" aria-label="Ending the season">
      {STEPS.map(([k, label], i) => (
        <li key={k} className={i < idx ? 'done' : i === idx ? `now${game.busy ? ' working' : ''}` : ''} aria-current={i === idx ? 'step' : undefined}>
          {label}
        </li>
      ))}
    </ol>
  );
}

const troopsOf = (a: Troops): Troops => ({
  levies: a.levies,
  regulars: a.regulars,
  mercs: a.mercs,
});

/** A short reading of a forecast: the odds, the powers, and what helps the defender. */
export function forecastText(s: GameState, f: Forecast): string {
  if (f.unopposed) {
    const owner = s.owner[f.province];
    if (owner === f.sides[0]!.realm) return 'your own province';
    return owner === -1 ? 'unopposed: an empty province' : 'unguarded: taken if nobody else marches in';
  }
  const [me, ...them] = f.sides;
  const d = f.defence;
  const why = [d.terrainBonus ? `${d.terrain} +${d.terrainBonus}` : '', d.fortBonus ? `fort +${d.fortBonus}` : '', d.riverBonus ? `river +${d.riverBonus}` : ''].filter(Boolean);
  const defender = them.find((x) => x.defending);
  const supply = me!.outOfSupply ? ' · you are out of supply −2' : '';
  return `${f.winPct}% to win · you ${me!.power[0]}–${me!.power[1]} vs ${them.map((x) => `${x.power[0]}–${x.power[1]}`).join(', ')}${
    defender && why.length ? ` · defender ${why.join(', ')}` : ''
  }${supply}`;
}

/** The forecast of a march order on screen, or null for other orders. */
export function marchForecast(v: View, o: Order): Forecast | null {
  if (o.kind !== 'march') return null;
  const army = v.state.armies.find((a) => a.realm === v.human && a.province === o.from);
  if (!army) return null;
  return forecastMarch(v.state, v.human, o.troops ? { ...troopsOf(army), ...o.troops } : troopsOf(army), o.to);
}

/** Where the selected army can march, each with what it would meet. Tapping one orders it. */
export function MarchTargets({ game, v, from }: { game: Game; v: View; from: number }) {
  const s = v.state;
  const army = game.armyAt(from);
  if (!army) return null;
  const off = v.phase !== 'planning' || game.busy;
  return (
    <ul className="targets" aria-label="March to">
      {s.map.provinces[from]!.neighbors.map((to) => {
        const f = forecastMarch(s, v.human, troopsOf(army), to);
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
