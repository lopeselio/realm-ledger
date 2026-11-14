// The side panels of the game page. Each reads the campaign view and calls the game's flows.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { COST, GOODS, type GameState, type Good, type Treaty } from '@realm-ledger/rules';
import { API, PUBLIC_API, type View } from '../api.ts';
import { colorOf, provinceNotes } from '../map.ts';
import { describeOrder, nearblocks } from '../format.ts';
import type { Game } from './useGame.ts';
import { canAct, isFinal, shownScores, EndSeasonButton, forecastText, MarchTargets, useMarchForecasts } from './turn.tsx';
import { usePhone } from '../media.ts';
import { PurseLine } from './juice.tsx';
import { boardFx, toast } from '../juice.ts';
import { coinSound, parchmentSound, stampSound } from '../sound.ts';
import { TIMING } from '../playback.ts';


// ---------- your orders ----------

export function Selection({ game, v }: { game: Game; v: View }) {
  const s = v.state;
  const sel = game.selected;
  if (sel === undefined) return <p className="fine">Select a province on the map.</p>;
  const p = s.map.provinces[sel]!;
  const army = game.armyAt(sel);
  const mine = s.owner[sel] === v.human;
  const notes = provinceNotes(s, sel);
  const off = !canAct(game);
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
      {notes.length > 0 && <p className="fine">{notes.join(' · ')}</p>}
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
  const planning = canAct(game);
  const phone = usePhone();
  const forecasts = useMarchForecasts(v, game.orders);
  return (
    <section className="panel" data-tour="orders" id="orders">
      <h2>Your orders</h2>
      {/* on a phone the selection lives in the dock under your thumb */}
      <div className="selection">{v.phase === 'planning' && !phone && <Selection game={game} v={v} />}</div>
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
          <li className="fine">{v.phase === 'planning' ? 'No orders yet. Sealing with none is allowed.' : v.phase === 'over' ? 'The campaign is over: start a new one at the top.' : 'Waiting…'}</li>
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
      <PurseLine v={v} orders={game.orders} />
      {v.phase !== 'over' && <EndSeasonButton game={game} v={v} />}
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
  const can = canAct(game) && v.tasksLeft > 0;
  const company = (id: number): string => v.companies.find((c) => c.id === id)?.name ?? `company ${id}`;
  const pname = (id: number): string => s.map.provinces[id]?.name ?? '?';
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (await game.giveTask(task, budget)) setTask('');
  };
  const open = v.plans.flatMap((p) => (p.plan.steps.length ? p.jobs.filter((j) => v.openJobs.includes(j)) : []));
  const reportFor = (job: number) => v.reports.find((r) => r.job === job);
  const { freshPlan, freshJobs } = useChancellorFx(v);

  return (
    <section className="panel" data-quest="chancellor">
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
            const fresh = i === freshPlan;
            // a fresh plan reveals itself a beat at a time: asked, the quote against fair, the counter, bought or walked away
            const beat = (n: number) => (fresh ? { style: { animationDelay: `${n * 0.45}s` }, className: 'beat' } : {});
            let n = 0;
            return (
              <li key={i} className={fresh ? 'fresh' : undefined}>
                <span className="who">“{p.text}”</span> <span className="tag">{p.plan.spent} crowns</span>
                <ul className="steps">
                  {p.plan.steps.map((st, k) => {
                    const what = st.kind === 'spy' ? `a report on ${pname(st.province)}` : `${st.count} swords at ${pname(st.province)}`;
                    const haggle = st.counter ? ` · countered ${st.counter.offer} (${st.counter.reason}) → ${st.counter.accepted ? 'taken' : 'refused'}` : '';
                    return (
                      <li key={k}>
                        <span {...beat(n++)}>
                          {company(st.company)} asked {st.quote} for {what}
                        </span>{' '}
                        <span {...beat(n++)}>(fair {st.fair})</span>
                        {haggle && <span {...beat(n++)}>{haggle}</span>} ·{' '}
                        <strong {...beat(n++)}>{st.price !== undefined ? `bought for ${st.price}` : 'walked away'}</strong>
                      </li>
                    );
                  })}
                  {p.plan.summary.map((x, k) => (
                    <li key={`s${k}`} className="quiet">
                      <span {...beat(n++)}>{x}</span>
                    </li>
                  ))}
                </ul>
                {fresh && p.plan.spent > 0 && p.season === s.season && v.phase !== 'over' && (
                  <p className="escrow beat" style={{ animationDelay: `${n * 0.45}s` }}>
                    <span className="coins" aria-hidden="true">
                      <i>🪙</i>
                      <i>🪙</i>
                      <i>🪙</i>
                    </span>
                    🔒 {p.plan.spent} crowns in escrow
                  </p>
                )}
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
            <li key={r.job} className={freshJobs.has(r.job) ? `fresh ${r.passed ? 'paid' : 'refunded'}` : undefined}>
              {freshJobs.has(r.job) && (
                <span className={`verdict ${r.passed ? 'yes' : 'no'}`}>
                  {r.passed ? `✓ paid: ${r.deal.kind === 'spy' ? 'report matched' : 'work checked'}` : `↩ refunded: ${r.deal.kind === 'spy' ? 'false report' : 'work failed'}`}
                  <span className="burst" aria-hidden="true">
                    <i>🪙</i>
                    <i>🪙</i>
                    <i>🪙</i>
                    <i>🪙</i>
                    <i>🪙</i>
                  </span>
                </span>
              )}
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

/**
 * The Chancellor's news as it arrives: a new plan (its beats revealed in turn, coins clinking into
 * escrow, a stamp), and receipts settled at the season's turn (stamped once the season has played out).
 */
function useChancellorFx(v: View): { freshPlan: number | null; freshJobs: Set<number> } {
  const seen = useRef<{ id: number; plans: number; receipts: number } | null>(null);
  const [freshPlan, setFreshPlan] = useState<number | null>(null);
  const [freshJobs, setFreshJobs] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    const was = seen.current;
    seen.current = { id: v.id, plans: v.plans.length, receipts: v.receipts.length };
    if (!was || was.id !== v.id) {
      setFreshPlan(null);
      setFreshJobs(new Set());
      return;
    }
    if (v.plans.length > was.plans) {
      const i = v.plans.length - 1;
      const p = v.plans[i]!;
      setFreshPlan(i);
      // on the same beats as the panel: coins when a step is bought, the stamp as escrow shows
      let beat = 0;
      for (const st of p.plan.steps) {
        beat += st.counter ? 3 : 2;
        if (st.price !== undefined) coinSound(beat * 0.45, 3);
        beat += 1;
      }
      stampSound((beat + p.plan.summary.length) * 0.45);
      if (p.plan.spent > 0) toast({ icon: '🔒', text: `${p.plan.spent} crowns in escrow`, detail: 'paid only if the work checks out', tone: 'gold' }, 3600);
      else toast({ icon: '🤝', text: 'The Chancellor walked away', detail: 'nothing bought', tone: 'info' });
    }
    if (v.receipts.length > was.receipts) {
      const fresh = v.receipts.slice(was.receipts);
      setFreshJobs(new Set(fresh.map((r) => r.job)));
      // stamped once the season's playback is over
      const after = (TIMING.capture + TIMING.captureFor) / 1000;
      stampSound(after);
      coinSound(after + 0.15, fresh.some((r) => r.passed) ? 5 : 2);
    }
  }, [v.id, v.plans.length, v.receipts.length]);
  return { freshPlan, freshJobs };
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
  const can = canAct(game) && v.envoysLeft > 0;
  // the envoy on the road, until the reply comes back
  const [riding, setRiding] = useState<number | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!can) return;
    setRiding(to);
    parchmentSound();
    boardFx({ kind: 'fly', from: s.realms[v.human]!.capital, to: s.realms[to]!.capital, icon: '🕊', ms: 2000 });
    const sent = await game.sendEnvoy({
      to,
      message,
      ...(kind ? { proposal: { kind, ...(kind === 'tribute' ? { amount } : {}) } } : {}),
    });
    setRiding(null);
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
      {riding !== null && (
        <p className="riding" role="status">
          <span className="bird" aria-hidden="true">
            🕊
          </span>{' '}
          Envoy rides to {s.realms[riding]?.name ?? 'the rival'}…
        </p>
      )}
      <ul className="envoys">
        {v.envoys
          .map((e, i) => ({ e, i }))
          .reverse()
          .map(({ e, i }) => (
            <li key={i}>
              <span className="who" style={{ color: colorOf(e.to) }}>
                {s.realms[e.to]!.name}
              </span>{' '}
              {e.proposal && (
                <span className={`tag ${e.accepted ? 'yes' : 'no'}`}>
                  {e.proposal.kind} {e.accepted ? 'signed' : 'refused'}
                </span>
              )}{' '}
              {e.verified &&
                (e.verifyUrl ? (
                  <a
                    className="tag tee"
                    href={e.verifyUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="Signed by the model in a TEE; its signature checks out. Opens NEAR AI's Verification Center, which checks the signer against fresh TEE hardware evidence in your browser"
                  >
                    TEE-signed ✓ verify
                  </a>
                ) : (
                  <span className="tag tee" title="Its signature checks out; pnpm verify:campaign checks the signer against the model's attested TEE key">
                    signed ✓
                  </span>
                ))}
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
            <span className="dot" style={{ background: colorOf(r.id) }} />
            <span className="name">
              {r.name}
              {r.id === v.human ? ' (you)' : ''}
            </span>
            {/* the final score once it's over; before, land held, the same measure for every realm as the standing's */}
            <span className="score" title={isFinal(v) ? 'final score' : 'land held (treasuries are secret until the end)'}>
              {shownScores(v)[r.id] ?? ''}
            </span>
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
