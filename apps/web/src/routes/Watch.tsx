// "/": an AI-only campaign played out in the browser with the real rules engine, with the
// replay check and the latest campaign on chain.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  BASE_PRICE,
  GOODS,
  newCampaign,
  replaySeason,
  runCampaign,
  scores,
  stateHash,
  type GameState,
} from '@realm-ledger/rules';
import { campaigns, CONTRACT, type ChainCampaign } from '../chain.ts';
import { provinceTip, colorOf } from '../map.ts';
import { Board } from '../components/Board.tsx';
import { ChronicleLines } from '../components/ChronicleLines.tsx';
import { Footer } from '../components/Footer.tsx';
import { nearblocks, seasonTitle } from '../format.ts';

const DEFAULT_SEED = 'ember-pass';

function playOut(seed: string, realms: number) {
  const result = runCampaign({ seed, realms });
  // rebuild every season's state by replaying the recorded orders: this is what the verifier does
  const states: GameState[] = [newCampaign({ seed, realms, human: null })];
  for (const h of result.history) states.push(replaySeason(states.at(-1)!, h).state);
  const hash = stateHash(result.state);
  return { history: result.history, states, hash, replayOk: stateHash(states.at(-1)!) === hash };
}

export function Watch() {
  const [params, setParams] = useSearchParams();
  const seed = params.get('seed')?.trim() || DEFAULT_SEED;
  const realms = Math.min(6, Math.max(3, Number(params.get('realms') ?? 5) || 5));
  const game = useMemo(() => playOut(seed, realms), [seed, realms]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seedInput, setSeedInput] = useState(seed);
  const [realmsInput, setRealmsInput] = useState(realms);
  const last = game.states.length - 1;
  const at = Math.min(index, last);
  const s = game.states[at]!;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setIndex((i) => {
        if (i >= last) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [playing, last]);

  const go = (to: (i: number) => number): void => {
    setPlaying(false);
    setIndex((i) => Math.max(0, Math.min(last, to(Math.min(i, last)))));
  };
  const togglePlay = (): void => {
    if (playing) return setPlaying(false);
    if (at >= last) setIndex(0);
    setPlaying(true);
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setPlaying(false);
    setIndex(0);
    setParams({ seed: seedInput.trim() || DEFAULT_SEED, realms: String(realmsInput) }, { replace: true });
  };

  return (
    <>
      <title>Realm Ledger</title>
      <header className="masthead">
        <div className="brand">
          <h1>Realm Ledger</h1>
          <p className="tagline">Rival realms ruled by AI agents with NEAR wallets. Every season, orders are sealed onchain and revealed at once.</p>
          <Link className="cta" to="/play">
            Play against the AI rulers →
          </Link>
        </div>
        <form className="controls" autoComplete="off" onSubmit={submit}>
          <label>
            Seed <input id="seed" value={seedInput} onChange={(e) => setSeedInput(e.target.value)} maxLength={40} spellCheck={false} />
          </label>
          <label>
            Realms
            <select value={realmsInput} onChange={(e) => setRealmsInput(Number(e.target.value))}>
              {[3, 4, 5, 6].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary">
            Play campaign
          </button>
        </form>
      </header>

      <main className="layout">
        <Board
          state={s}
          tipHtml={(id) => provinceTip(s, id)}
          head={(toggle) => (
            <>
              <h2>{s.winner !== null ? 'The campaign is over' : seasonTitle(s.season)}</h2>
              <div className="timeline">
                {toggle}
                <button type="button" aria-label="Previous season" onClick={() => go((i) => i - 1)}>
                  ◀
                </button>
                <button type="button" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                  {playing ? '❚❚' : '▶'}
                </button>
                <button type="button" aria-label="Next season" onClick={() => go((i) => i + 1)}>
                  ▶|
                </button>
                <input id="scrub" type="range" min={0} max={last} value={at} aria-label="Season" onChange={(e) => go(() => Number(e.target.value))} />
              </div>
            </>
          )}
          legend={
            <p className="legend">
              <span>
                <i className="sw town" />
                town
              </span>
              <span>
                <i className="sw fort" />
                fort
              </span>
              <span>♛ capital</span>
              <span>
                <i className="sw army" />
                army (troops)
              </span>
              <span>
                <i className="sw river" />
                river
              </span>
            </p>
          }
        />

        <aside className="side">
          <section className="panel">
            <h2>Realms</h2>
            <RealmScores s={s} />
          </section>
          <section className="panel">
            <h2>Chronicle</h2>
            <ul className="chronicle">
              {at === 0 ? (
                <li className="quiet">The realms take the field. Scrub forward or press ▶ to watch the seasons turn.</li>
              ) : (
                <ChronicleLines before={game.states[at - 1]!} events={game.history[at - 1]!.events} limit={60} empty="A quiet season." />
              )}
            </ul>
          </section>
          <section className="panel">
            <h2>Market</h2>
            <Market s={s} prev={game.states[Math.max(0, at - 1)]!} showWhy={at > 0} />
          </section>
        </aside>
      </main>

      <section className="proof">
        <div className="panel">
          <h2>The proof</h2>
          <p>
            The campaign above runs in your browser on the same deterministic rules the game server uses. Replaying it from its recorded orders and committed roll seeds
            gives this final state hash:
          </p>
          <p className="mono">{game.hash}</p>
          <p className={`check ${game.replayOk ? 'ok' : 'bad'}`}>
            {game.replayOk ? `✓ Replayed ${game.history.length} seasons from the recorded orders: the same hash.` : '✗ Replay diverged. This is a bug; please report it.'}
          </p>
        </div>
        <div className="panel">
          <h2>
            On chain:{' '}
            <a href={nearblocks(CONTRACT)} target="_blank" rel="noopener">
              {CONTRACT}
            </a>
          </h2>
          <ChainSummary />
        </div>
      </section>

      <Footer>
        <Link to="/play">Play a campaign</Link>
      </Footer>
    </>
  );
}

function RealmScores({ s }: { s: GameState }) {
  const sc = scores(s);
  const land = (id: number): number => s.owner.filter((o) => o === id).length;
  const troops = (id: number): number => s.armies.filter((a) => a.realm === id).reduce((n, a) => n + a.levies + a.regulars + a.mercs, 0);
  const order = [...s.realms].sort((a, b) => sc[b.id]! - sc[a.id]!);
  return (
    <ol className="realms">
      {order.map((r) => {
        const p = r.personality;
        return (
          <li key={r.id} className={r.alive ? '' : 'fallen'}>
            <span className="dot" style={{ background: colorOf(r.id) }} />
            <span className="name">
              {r.name}
              {s.winner === r.id ? ' ♛' : ''}
            </span>
            <span className="score">{sc[r.id]}</span>
            <span className="meta">
              {land(r.id)} provinces · {troops(r.id)} troops · {r.purse.crowns} crowns
              <br />
              greed {p.greed} · caution {p.caution} · honour {p.honour} · ambition {p.ambition}
              <br />
              <span className="agenda">secret agenda: {r.agenda.text}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Market({ s, prev, showWhy }: { s: GameState; prev: GameState; showWhy: boolean }) {
  return (
    <table className="market">
      <tbody>
        {GOODS.map((g) => {
          const p = s.market.price[g];
          const d = p - prev.market.price[g];
          const why = s.market.reasons[g]
            .filter((r) => r.stockDelta !== 0)
            .map((r) => r.text)
            .slice(0, 2)
            .join('; ');
          return [
            <tr key={g}>
              <th>{g}</th>
              <td className="num">{p}</td>
              <td className={`num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`}>
                {d > 0 ? '+' : ''}
                {d || ''}
              </td>
              <td className="num">base {BASE_PRICE[g]}</td>
            </tr>,
            showWhy && why ? (
              <tr key={`${g}-why`}>
                <td colSpan={4} className="why">
                  {why}
                </td>
              </tr>
            ) : null,
          ];
        })}
      </tbody>
    </table>
  );
}

function ChainSummary() {
  const [list, setList] = useState<ChainCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    campaigns()
      .then((l) => live && setList(l))
      .catch((e: unknown) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, []);

  if (error) return <div id="chain">Could not read the contract right now ({error}).</div>;
  if (!list) return <div id="chain">Reading the contract on testnet…</div>;
  if (list.length === 0) return <div id="chain">No campaigns on chain yet.</div>;
  const c = list[0]!;
  const short = (a: string): string => a.replace(`.${CONTRACT}`, '');
  return (
    <div id="chain">
      <p>{list.length} campaigns recorded. The latest:</p>
      <dl>
        <dt>campaign</dt>
        <dd>
          #{c.id}, seed <code>{c.map_seed}</code>
        </dd>
        <dt>phase</dt>
        <dd>
          {c.phase}, {c.season}/{c.max_seasons} seasons settled{c.winner !== null ? `, won by realm ${c.winner}` : ''}
        </dd>
        <dt>rulers</dt>
        <dd>
          {c.realms.map((r, i) => (
            <span key={i}>
              {i}: {short(r.ruler)} ({r.treasury} crowns)
              <br />
            </span>
          ))}
        </dd>
        <dt>roll commit</dt>
        <dd className="mono">{c.roll_commit}</dd>
        <dt>state hashes</dt>
        <dd className="mono">
          {c.state_hashes.length
            ? c.state_hashes.map((h, i) => (
                <span key={i}>
                  {h}
                  <br />
                </span>
              ))
            : 'none yet'}
        </dd>
      </dl>
      <p>Rulers are agent accounts whose only key is a function-call key for this contract, so they can seal, reveal, sign treaties and hire, but can't move NEAR.</p>
    </div>
  );
}
