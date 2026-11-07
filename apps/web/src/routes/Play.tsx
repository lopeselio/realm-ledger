// "/play" and "/play/:id": rule one realm against the AI rulers.
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { visibleProvinces } from '@realm-ledger/rules';
import { provinceTip } from '../map.ts';
import { Board, type BoardOverlay } from '../components/Board.tsx';
import { ChronicleLines } from '../components/ChronicleLines.tsx';
import { Footer } from '../components/Footer.tsx';
import { api, type CampaignSummary } from '../api.ts';
import { seasonTitle } from '../format.ts';
import { recentCampaigns } from '../recent.ts';
import { findSecret } from '../secrets.ts';
import { restoreSigner, signIn, type Signer } from '../wallet.ts';
import { ChancellorPanel, EnvoysPanel, OrdersPanel, Proof, RealmList } from '../play/panels.tsx';
import { useGame, type Game } from '../play/useGame.ts';

/** The old address, /play.html?c=7, opens /play/7. */
export function LegacyPlay() {
  const [params] = useSearchParams();
  const c = params.get('c');
  return <Navigate to={c && /^\d+$/.test(c) ? `/play/${c}` : '/play'} replace />;
}

function parseId(raw: string | undefined): number | null {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
}

export function Play() {
  const params = useParams();
  const id = parseId(params.id);
  const navigate = useNavigate();
  const [signer, setSigner] = useState<Signer | null>(null);
  const game = useGame(id, signer);
  const { view: v, selected, orders } = game;

  useEffect(() => {
    let live = true;
    void restoreSigner().then((s) => live && setSigner(s));
    return () => {
      live = false;
    };
  }, []);

  // a new overlay redraws the board, so build it only when the inputs change
  const overlay = useMemo<BoardOverlay | undefined>(() => {
    if (!v) return undefined;
    const s = v.state;
    const army = selected !== undefined && game.armyAt(selected);
    const marched = selected !== undefined && orders.some((o) => o.kind === 'march' && o.from === selected);
    return {
      ...(v.phase !== 'over' ? { visible: visibleProvinces(s, v.human) } : {}),
      focus: s.realms[v.human]!.capital,
      selected,
      targets: army && !marched ? new Set(s.map.provinces[selected]!.neighbors) : new Set<number>(),
      arrows: orders.flatMap((o) => (o.kind === 'march' ? [[o.from, o.to] as [number, number]] : [])),
      marks: new Set(orders.flatMap((o) => ('province' in o ? [o.province] : []))),
    };
    // armyAt reads the view, which is a dependency already
  }, [v, selected, orders]);

  if (params.id !== undefined && id === null) return <Navigate to="/play" replace />;

  const title = !v
    ? 'Start a campaign'
    : v.phase === 'over'
      ? v.winner === v.human
        ? 'Victory: your realm wins'
        : `${v.state.realms[v.winner ?? 0]!.name} wins the campaign`
      : `${seasonTitle(v.state.season)} · campaign #${v.id}`;

  const start = async (realms: number, seasons: number): Promise<void> => {
    const created = await game.newCampaign(realms, seasons);
    if (created !== null) navigate(`/play/${created}`, { replace: id === null });
  };

  return (
    <>
      <title>{v ? `Campaign #${v.id} · Realm Ledger` : 'Play Realm Ledger'}</title>
      <header className="masthead">
        <div className="brand">
          <h1>
            <Link to="/" className="home">
              Realm Ledger
            </Link>
          </h1>
          <p className="tagline">You rule the red realm. The others are AI rulers with their own NEAR accounts. Plan, talk, seal, and see who kept their word.</p>
        </div>
        <div className="header-right">
          <Account game={game} signer={signer} setSigner={setSigner} />
          {(!v || v.phase === 'over') && <StartForm busy={game.busy} onStart={(r, s) => void start(r, s)} />}
        </div>
      </header>

      <main className="layout">
        {v ? (
          <Board
            state={v.state}
            overlay={overlay}
            tipHtml={(p) => provinceTip(v.state, p)}
            onPick={game.clickProvince}
            head={(toggle) => (
              <>
                <h2>{title}</h2>
                <StatusLine game={game} />
                {toggle}
              </>
            )}
            legend={
              <p className="legend">
                Click one of your armies, then a highlighted province to march. Select one of your provinces to build. Hover for details. On the 3D table, drag to turn it and
                scroll to zoom.
              </p>
            }
          />
        ) : (
          <section className="board" aria-label="War table">
            <div className="board-head">
              <h2>{title}</h2>
              <StatusLine game={game} />
            </div>
            <div className="map-wrap empty">
              {id === null ? <Continue signer={signer} /> : <p className="fine">The war table is set when your campaign starts.</p>}
            </div>
          </section>
        )}

        {v && (
          <aside className="side">
            <OrdersPanel game={game} v={v} />
            <ChancellorPanel game={game} v={v} />
            <EnvoysPanel game={game} v={v} />
            <section className="panel">
              <h2>Chronicle</h2>
              <ul className="chronicle">
                {/* names never change, so the current state can label last season's events after a reload */}
                <ChronicleLines before={game.before ?? v.state} events={v.lastEvents} limit={40} empty={v.state.season === 0 ? 'Your realm awaits orders.' : 'A quiet season.'} />
              </ul>
            </section>
          </aside>
        )}
      </main>

      {v && (
        <section className="proof">
          <div className="panel">
            <h2>Realms</h2>
            <RealmList v={v} />
          </div>
          <div className="panel">
            <h2>The proof</h2>
            <Proof v={v} />
          </div>
        </section>
      )}
      <Footer>
        <Link to="/">Watch AI-only campaigns</Link>
      </Footer>
    </>
  );
}

/** Campaigns to pick up again: the ones played in this browser, and the ones your wallet rules. */
function Continue({ signer }: { signer: Signer | null }) {
  const account = signer?.accountId ?? null;
  const [list, setList] = useState<CampaignSummary[] | null>(null);
  useEffect(() => {
    const ids = recentCampaigns();
    if (ids.length === 0 && !account) return setList([]);
    let live = true;
    const q = new URLSearchParams();
    if (ids.length > 0) q.set('ids', ids.join(','));
    if (account) q.set('player', account);
    api<CampaignSummary[]>(`/campaigns?${q}`)
      .then((l) => live && setList(l))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [account]);

  // which sealed seasons this browser can reveal: hashing the stored secrets once per list
  const canReveal = useMemo(() => new Set((list ?? []).filter((c) => c.phase === 'sealed' && findSecret(c.id, c.season, c.yourSeal)).map((c) => c.id)), [list]);

  if (list === null || list.length === 0) return <p className="fine">The war table is set when your campaign starts.</p>;
  return (
    <div className="panel continue">
      <h2>Continue a campaign</h2>
      <ul>
        {list.map((c) => (
          <li key={c.id}>
            <Link to={`/play/${c.id}`}>Campaign #{c.id}</Link>{' '}
            <span className="meta">
              {c.phase === 'over'
                ? // realm 0 is the player's; it's you unless another wallet rules it
                  c.winner === 0 && (c.player === null || c.player === account)
                  ? 'over · you won'
                  : 'over'
                : `season ${c.season + 1} of ${c.maxSeasons} (${seasonTitle(c.season)})${c.phase === 'sealed' ? (canReveal.has(c.id) ? ' · orders sealed, reveal pending' : ' · sealed, but this browser can’t reveal them') : ''}`}
              {c.player ? ` · ruled by ${c.player}` : ' · guest seat'}
            </span>
          </li>
        ))}
      </ul>
      <p className="fine">Campaigns you started or sealed orders in here{account ? ', and the ones your wallet rules' : ''}. Saved on the server; open one to pick up where you left off. Sealed orders can only be revealed from the browser that sealed them.</p>
    </div>
  );
}

function StatusLine({ game }: { game: Game }) {
  return (
    <p className={`status ${game.status.tone}`} role="status">
      {game.status.text}
    </p>
  );
}

function StartForm({ busy, onStart }: { busy: boolean; onStart: (realms: number, seasons: number) => void }) {
  const [realms, setRealms] = useState(4);
  const [seasons, setSeasons] = useState(12);
  return (
    <div className="controls">
      <label>
        Rivals
        <select value={realms} onChange={(e) => setRealms(Number(e.target.value))}>
          <option value={3}>2</option>
          <option value={4}>3</option>
          <option value={5}>4</option>
        </select>
      </label>
      <label>
        Length
        <select value={seasons} onChange={(e) => setSeasons(Number(e.target.value))}>
          <option value={8}>8 seasons</option>
          <option value={12}>12 seasons</option>
          <option value={20}>20 seasons</option>
        </select>
      </label>
      <button type="button" className="primary" disabled={busy} onClick={() => onStart(realms, seasons)}>
        New campaign
      </button>
    </div>
  );
}

function Account({ game, signer, setSigner }: { game: Game; signer: Signer | null; setSigner: (s: Signer | null) => void }) {
  const doSignIn = (): void =>
    void game.withBusy('Opening your wallet; approve the key limited to the realm contract…', async () => {
      const s = await signIn();
      setSigner(s);
      game.say(`Signed in as ${s.accountId}. New campaigns are ruled by your account.`);
    });
  const doSignOut = (): void =>
    void game.withBusy('Signing out…', async () => {
      await signer?.signOut();
      setSigner(null);
      game.say('Signed out. New campaigns use a guest seat.');
    });
  return (
    <div className="account">
      {signer ? (
        <>
          <span className="who-am-i" title="Your NEAR testnet account">
            {signer.accountId}
          </span>{' '}
          <button type="button" onClick={doSignOut}>
            Sign out
          </button>
        </>
      ) : (
        <>
          <button type="button" className="primary" onClick={doSignIn}>
            Sign in with a NEAR wallet
          </button>
          <span className="fine guest">or play as a guest</span>
        </>
      )}
    </div>
  );
}
