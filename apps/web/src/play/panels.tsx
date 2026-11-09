// The side panels of the game page. Each reads the campaign view and calls the game's flows.
import { useEffect, useState, type FormEvent } from 'react';
import { COST, GOODS, type GameState, type Good, type Treaty } from '@realm-ledger/rules';
import { API, PUBLIC_API, type View } from '../api.ts';
import { REALM_COLORS } from '../map.ts';
import { describeOrder, nearblocks } from '../format.ts';
import type { Game } from './useGame.ts';
import { forecastText, MarchTargets, useMarchForecasts } from './turn.tsx';

const planningOf = (g: Game): boolean => !!g.view && g.view.phase === 'planning' && !g.busy;

// ---------- your orders ----------

function Selection({ game, v }: { game: Game; v: View }) {
  const s = v.state;
  const sel = game.selected;
  if (sel === undefined) return <p className="fine">Select a province on the map.</p>;
  const p = s.map.provinces[sel]!;
  const army = game.armyAt(sel);
  const mine = s.owner[sel] === v.human;
  const off = !planningOf(game);
  return (
    <>
      <p>
        <strong>{p.name}</strong>{' '}
        {army
          ? `Your army: ${army.levies} levies, ${army.regulars} regulars${army.mercs ? `, ${army.mercs} mercenaries` : ''}. March to a highlighted province, or pick one here:`
          : mine
            ? 'Your province.'
            : ''}
      </p>
      {army && <MarchTargets game={game} v={v} from={sel} />}
      {mine && (
        <div className="actions">
          {s.forts[sel]! < 3 && (
            <button type="button" disabled={off} onClick={() => game.addOrder({ kind: 'fortify', province: sel })}>
              Fortify ({COST.fortify.crowns}c {COST.fortify.timber}t {COST.fortify.iron}i)
            </button>
          )}
          <button type="button" disabled={off} onClick={() => game.addOrder({ kind: 'levy', province: sel })}>
            Raise {COST.levyTroops} levies ({COST.levy.crowns}c {COST.levy.grain}g)
          </button>
          {s.towns[sel] ? (
            <button type="button" disabled={off} onClick={() => game.addOrder({ kind: 'recruit', province: sel, count: 2 })}>
              Recruit 2 regulars ({2 * COST.regular.crowns}c 2i)
            </button>
          ) : (
            p.terrain !== 'pass' && (
              <button type="button" disabled={off} onClick={() => game.addOrder({ kind: 'build', province: sel })}>
                Build a town ({COST.town.crowns}c {COST.town.timber}t)
              </button>
            )
          )}
        </div>
      )}
    </>
  );
}

export function OrdersPanel({ game, v }: { game: Game; v: View }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState(5);
  const [good, setGood] = useState<Good>('grain');
  const planning = planningOf(game);
  const me = v.state.realms[v.human]!;
  const forecasts = useMarchForecasts(v, game.orders);
  return (
    <section className="panel" data-tour="orders">
      <h2>Your orders</h2>
      <div className="selection">{v.phase === 'planning' && <Selection game={game} v={v} />}</div>
      <ol className="orders">
        {game.orders.length ? (
          game.orders.map((o, i) => {
            const f = o.kind === 'march' ? forecasts.get(o.to) : undefined;
            return (
              <li key={i}>
                {describeOrder(v.state, o)} {f && <span className="fine forecast">({forecastText(v.state, f)})</span>}{' '}
                <button type="button" className="x" aria-label="Remove" onClick={() => game.removeOrder(i)}>
                  ✕
                </button>
              </li>
            );
          })
        ) : (
          <li className="fine">{v.phase === 'planning' ? 'No orders yet. Sealing with none is allowed.' : 'Waiting…'}</li>
        )}
      </ol>
      <div className="trade">
        <select value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')} aria-label="Buy or sell">
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <input type="number" min={1} max={99} value={qty} onChange={(e) => setQty(Number(e.target.value))} aria-label="Quantity" />
        <select value={good} onChange={(e) => setGood(e.target.value as Good)} aria-label="Good">
          {GOODS.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={!planning}
          onClick={() => {
            const n = Math.floor(qty);
            if (n > 0) game.addOrder({ kind: 'trade', good, side, qty: n });
          }}
        >
          Add trade
        </button>
      </div>
      <p className="purse" data-tour="purse">
        Treasury: {me.purse.crowns} crowns · {GOODS.map((g) => `${me.purse[g]} ${g}`).join(' · ')}
      </p>
      <button type="button" className="primary wide end-season" data-tour="seal" disabled={!planning} onClick={() => void game.seal()}>
        {game.stage?.campaign === v.id ? 'Ending the season…' : `End season: seal ${game.orders.length === 1 ? '1 order' : `${game.orders.length} orders`}`}
      </button>
      <p className="fine">Your browser hashes your orders with a secret salt. Only the hash goes onchain until every ruler has sealed.</p>
      {v.phase === 'sealed' && game.forfeitAt !== null && <ForfeitButton game={game} at={game.forfeitAt} />}
    </section>
  );
}

// ---------- the Chancellor ----------

export function ChancellorPanel({ game, v }: { game: Game; v: View }) {
  const [task, setTask] = useState('');
  const [budget, setBudget] = useState(25);
  const s = v.state;
  const can = planningOf(game) && v.tasksLeft > 0;
  const company = (id: number): string => v.companies.find((c) => c.id === id)?.name ?? `company ${id}`;
  const pname = (id: number): string => s.map.provinces[id]?.name ?? '?';
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (await game.giveTask(task, budget)) setTask('');
  };
  const open = v.plans.flatMap((p) => (p.plan.steps.length ? p.jobs.filter((j) => v.openJobs.includes(j)) : []));
  const reportFor = (job: number) => v.reports.find((r) => r.job === job);

  return (
    <section className="panel">
      <h2>Chancellor</h2>
      <form className="envoy" onSubmit={(e) => void submit(e)}>
        <textarea
          rows={2}
          maxLength={300}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="e.g. Hold Woldfell through winter, or find out what guards the Vey capital."
          aria-label="Task for the Chancellor"
          required
        />
        <div className="row">
          <label className="inline">
            Budget <input type="number" min={1} max={s.realms[v.human]!.purse.crowns} value={budget} onChange={(e) => setBudget(Number(e.target.value))} aria-label="Budget in crowns" />{' '}
            crowns
          </label>
          <button type="submit" disabled={!can}>
            Give the task
          </button>
        </div>
      </form>
      <p className="fine">
        The Chancellor plans with the rules engine, haggles once, and hires through the contract’s escrow within the cap you set. It pays only for work that passes its check.
      </p>
      <ul className="envoys">
        {v.plans
          .map((p, i) => ({ p, i }))
          .reverse()
          .map(({ p, i }) => {
            const advice = p.season === s.season && v.phase === 'planning' ? p.plan.advice : [];
            return (
              <li key={i}>
                <span className="who">“{p.text}”</span> <span className="tag">{p.plan.spent} crowns</span>
                <ul className="steps">
                  {p.plan.steps.map((st, k) => {
                    const what = st.kind === 'spy' ? `a report on ${pname(st.province)}` : `${st.count} swords at ${pname(st.province)}`;
                    const haggle = st.counter ? ` · countered ${st.counter.offer} (${st.counter.reason}) → ${st.counter.accepted ? 'taken' : 'refused'}` : '';
                    return (
                      <li key={k}>
                        {company(st.company)} asked {st.quote} for {what} (fair {st.fair}){haggle} ·{' '}
                        <strong>{st.price !== undefined ? `bought for ${st.price}` : 'walked away'}</strong>
                      </li>
                    );
                  })}
                  {p.plan.summary.map((x, k) => (
                    <li key={`s${k}`} className="quiet">
                      {x}
                    </li>
                  ))}
                </ul>
                {advice.length > 0 && (
                  <div className="advice">
                    {advice.map((o, k) => (
                      <button key={k} type="button" onClick={() => game.addAdvice(o)}>
                        Add: {describeOrder(s, o)}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
      </ul>
      <h3 className="sub">Receipts</h3>
      <ul className="receipts">
        {open.length === 0 && v.receipts.length === 0 && <li className="fine">No hires yet.</li>}
        {open.map((j) => (
          <li key={`open${j}`}>
            <span className="tag wait">job {j} in escrow</span> paid only if the work passes when the season turns
          </li>
        ))}
        {[...v.receipts].reverse().map((r) => {
          const rep = reportFor(r.job);
          const what = r.deal.kind === 'spy' ? `report on ${pname(r.deal.province)}` : `${r.deal.count} swords at ${pname(r.deal.province)}`;
          return (
            <li key={r.job}>
              <span className={`tag ${r.passed ? 'yes' : 'no'}`}>
                job {r.job} {r.passed ? 'paid' : 'refunded'}
              </span>{' '}
              {company(r.deal.company)}, {what}, {r.deal.price} crowns
              {rep && (
                <>
                  <br />
                  Report: {rep.report.armies.length ? rep.report.armies.map((a) => `${a.realm >= 0 ? s.realms[a.realm]!.name : 'militia'} ${a.troops}`).join(', ') : 'no troops'}
                </>
              )}
              {r.deal.kind === 'spy' && ` · ${r.passed ? 'matched the revealed season ✓' : 'did not match: false report ✗'}`}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------- envoys ----------

const TREATIES: { value: Treaty['kind']; label: string }[] = [
  { value: 'peace', label: 'propose peace' },
  { value: 'passage', label: 'propose passage' },
  { value: 'alliance', label: 'propose alliance' },
  { value: 'trade', label: 'propose trade' },
  { value: 'tribute', label: 'offer tribute' },
];

export function EnvoysPanel({ game, v }: { game: Game; v: View }) {
  const s = v.state;
  const rivals = s.realms.filter((r) => r.id !== v.human && r.alive);
  const [toChoice, setTo] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<Treaty['kind'] | ''>('');
  const [amount, setAmount] = useState(6);
  // keep the chosen rival while it lives; otherwise the first one left
  const to = rivals.some((r) => r.id === toChoice) ? toChoice! : (rivals[0]?.id ?? 0);
  const can = planningOf(game) && v.envoysLeft > 0;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const sent = await game.sendEnvoy({
      to,
      message,
      ...(kind ? { proposal: { kind, ...(kind === 'tribute' ? { amount } : {}) } } : {}),
    });
    if (sent) setMessage('');
  };

  return (
    <section className="panel" data-tour="envoys">
      <h2>Envoys</h2>
      <form className="envoy" onSubmit={(e) => void submit(e)}>
        <select value={to} onChange={(e) => setTo(Number(e.target.value))} aria-label="Send to">
          {rivals.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <textarea rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Speak plainly, or don't." aria-label="Message" required />
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as Treaty['kind'] | '')} aria-label="Treaty">
            <option value="">no treaty</option>
            {TREATIES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {kind === 'tribute' && <input type="number" min={1} max={50} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Tribute per season" />}
          <button type="submit" disabled={!can}>
            Send
          </button>
        </div>
      </form>
      <ul className="envoys">
        {v.envoys
          .map((e, i) => ({ e, i }))
          .reverse()
          .map(({ e, i }) => (
            <li key={i}>
              <span className="who" style={{ color: REALM_COLORS[e.to] }}>
                {s.realms[e.to]!.name}
              </span>{' '}
              {e.proposal && (
                <span className={`tag ${e.accepted ? 'yes' : 'no'}`}>
                  {e.proposal.kind} {e.accepted ? 'signed' : 'refused'}
                </span>
              )}{' '}
              {e.verified && (
                <span className="tag tee" title="Reply signed inside a TEE; checked against the attested key">
                  TEE-signed ✓
                </span>
              )}
              <p className="said">“{e.message}”</p>
              <p className="reply">{e.reply}</p>
            </li>
          ))}
      </ul>
    </section>
  );
}

// ---------- realms and proof ----------

export function RealmList({ v }: { v: View }) {
  const s: GameState = v.state;
  const land = (id: number): number => s.owner.filter((o) => o === id).length;
  return (
    <ol className="realms">
      {s.realms.map((r) => {
        const secret = v.phase === 'over' || r.id === v.human;
        const treaties = s.treaties.filter((t) => t.realms.includes(r.id) && t.realms.includes(v.human)).map((t) => t.kind);
        return (
          <li key={r.id} className={r.alive ? '' : 'fallen'}>
            <span className="dot" style={{ background: REALM_COLORS[r.id] }} />
            <span className="name">
              {r.name}
              {r.id === v.human ? ' (you)' : ''}
            </span>
            <span className="score">{v.scores[r.id] ?? ''}</span>
            <span className="meta">
              {land(r.id)} provinces{treaties.length > 0 && r.id !== v.human ? ` · with you: ${treaties.join(', ')}` : ''}
              {secret && r.agenda.text !== 'unknown' && (
                <>
                  <br />
                  <span className="agenda">secret agenda: {r.agenda.text}</span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Proof({ v }: { v: View }) {
  const bundle = `${API}/api/campaigns/${v.id}/proof`;
  return (
    <div id="proof">
      <dl>
        <dt>contract</dt>
        <dd>
          <a href={nearblocks(v.contract)} target="_blank" rel="noopener">
            {v.contract}
          </a>
          , campaign #{v.id}
        </dd>
        <dt>your realm</dt>
        <dd>
          {v.player ? (
            <>
              ruled by your account{' '}
              <a href={nearblocks(v.player)} target="_blank" rel="noopener">
                {v.player}
              </a>
              ; your seals and reveals are signed in this browser
            </>
          ) : (
            'a guest seat signed by the game server; sign in with a NEAR wallet to sign your own moves'
          )}
        </dd>
        <dt>AI diplomacy</dt>
        <dd>
          {v.attested ? (
            <>
              {v.attested.model} in a TEE; attestation fetched with nonce <code>{v.attested.nonce.slice(0, 12)}…</code>
            </>
          ) : (
            'model unavailable'
          )}
        </dd>
        <dt>proof bundle</dt>
        <dd>
          <a href={bundle} target="_blank" rel="noopener">
            download
          </a>
        </dd>
        <dt>check it</dt>
        <dd>
          <code>pnpm verify:campaign {PUBLIC_API}/api/campaigns/{v.id}/proof</code>
        </dd>
      </dl>
      <p>
        {v.phase === 'over'
          ? 'The battle-roll secret and every ruler’s agenda are now revealed and checked onchain against their commitments.'
          : 'The battle-roll secret and the rulers’ agendas are revealed when the campaign ends.'}
      </p>
    </div>
  );
}

/** Settles without your lost orders; enables itself when the contract's reveal window closes. */
function ForfeitButton({ game, at }: { game: Game; at: number }) {
  const [now, setNow] = useState(() => Date.now());
  const open = now >= at;
  useEffect(() => {
    if (open) return;
    // timers overflow past ~24.8 days: wait in steps; each step re-renders and schedules the next
    const t = setTimeout(() => setNow(Date.now()), Math.min(at - now, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [at, now, open]);
  return (
    <button type="button" className="wide" disabled={game.busy || !open} onClick={() => void game.forfeit()}>
      {open ? 'Settle without my orders' : `Settle without my orders (from ${new Date(at).toLocaleString()})`}
    </button>
  );
}
