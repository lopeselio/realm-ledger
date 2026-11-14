// "/play" and "/play/:id": rule one realm against the AI rulers.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { challengeCode, dailyDate, isChallengeCode, QUICK_MATCH, visibleProvinces } from '@realm-ledger/rules';
import { provinceTip } from '../map.ts';
import { Board, type BoardOverlay } from '../components/Board.tsx';
import { usePhone } from '../media.ts';
import { ChronicleLines } from '../components/ChronicleLines.tsx';
import { Footer } from '../components/Footer.tsx';
import { api, type CampaignSummary } from '../api.ts';
import { seasonTitle } from '../format.ts';
import { recentCampaigns } from '../recent.ts';
import { findSecret } from '../secrets.ts';
import { keyIsCurrent, restoreSigner, signIn, type Signer } from '../wallet.ts';
import { ChancellorPanel, EnvoysPanel, OrdersPanel, Proof, RealmList, Selection } from '../play/panels.tsx';
import { useGame, type Game } from '../play/useGame.ts';
import { ChallengeBoard, DailyBoard } from '../play/daily.tsx';
import { PhoneDock, StandingBar, TurnSteps } from '../play/turn.tsx';
import { scriptFor } from '../playback.ts';
import { Guide } from '../onboarding/Guide.tsx';
import { useFirstSeason } from '../onboarding/FirstSeason.tsx';
import { Fold } from '../components/Fold.tsx';

/** A shared challenge, /challenge/abc123, opens the play page ready to accept it. */
/** A challenge code as pasted, forgiven its case and a stray character at either end from a chat message. */
const cleanCode = (raw: string): string => raw.toLowerCase().replace(/^[^0-9a-f]+|[^0-9a-f]+$/g, '');

export function ChallengeLink() {
  const { code } = useParams();
  const clean = cleanCode(code ?? '');
  return <Navigate to={`/play?challenge=${encodeURIComponent(isChallengeCode(clean) ? clean : (code ?? ''))}`} replace />;
}

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
  // a challenge a friend shared (/challenge/:code lands here with ?challenge=code)
  const [search] = useSearchParams();
  const asked = search.get('challenge');
  const askedCode = asked !== null ? cleanCode(asked) : null;
  const accepting = id === null && askedCode && isChallengeCode(askedCode) ? askedCode : null;
  const badLink = id === null && asked !== null && !accepting;
  // a code that leads to no challenge: no Accept button (for this code; another one starts afresh)
  const [deadCode, setDeadCode] = useState<string | null>(null);
  const dead = deadCode !== null && deadCode === accepting;
  const [signer, setSigner] = useState<Signer | null>(null);
  const game = useGame(id, signer);
  // the thumb dock exists only on a phone (on wider screens the orders panel sits by the map)
  const phone = usePhone();
  const { view: v, selected, orders } = game;
  // the first campaign's checklist above the table, and what it asks the table to point at
  const guide = useFirstSeason(game);
  const beacon = v?.phase === 'planning' ? guide.beacon : undefined;

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
      // the camera (and a phone's flat map) starts on your army, or your capital if it has none
      focus: s.armies.find((a) => a.realm === v.human)?.province ?? s.realms[v.human]!.capital,
      selected,
      targets: army && !marched ? new Set(s.map.provinces[selected]!.neighbors) : new Set<number>(),
      arrows: orders.flatMap((o) => (o.kind === 'march' ? [[o.from, o.to] as [number, number]] : [])),
      marks: new Set(orders.flatMap((o) => ('province' in o ? [o.province] : []))),
      ...(beacon !== undefined ? { beacon } : {}),
    };
    // armyAt reads the view, which is a dependency already
  }, [v, selected, orders, beacon]);

  // the season that just settled here (not one read on load): played over the board once
  const before = game.before;
  // when each season was first seen settled, so a later view (an envoy's reply) doesn't make it fresh again
  const seenAt = useRef(new Map<string, number>());
  // built when the season or the before-state changes, not on every later view (an envoy's reply)
  const replayKey = v && before && before.season === v.state.season - 1 ? `${v.id}:${v.state.season}` : null;
  const replay = useMemo(() => {
    if (!v || !before || !replayKey) return null;
    if (!seenAt.current.has(replayKey)) seenAt.current.set(replayKey, Date.now());
    // the server sends the season as your realm saw it (the whole of it once the campaign is over)
    // (the season that settled, counted from 1, is the number of seasons now played)
    return { key: replayKey, at: seenAt.current.get(replayKey)!, script: scriptFor(v.lastEvents), caption: `Season ${v.state.season} plays out…` };
    // v is read for the season it settled; later views of the same season don't change the replay
  }, [replayKey, before]);

  // what the walkthrough watches, rebuilt only when one of them changes
  const guideSignals = useMemo(
    () => ({ campaign: v?.id ?? null, orderEdits: game.orderEdits, marches: game.marches, selections: game.selections, seals: game.seals }),
    [v?.id, game.orderEdits, game.marches, game.selections, game.seals],
  );

  if (params.id !== undefined && id === null) return <Navigate to="/play" replace />;
  // a daily challenge's day, or a challenge's code, for its board under the proof
  const day = v ? dailyDate(v.state.seed) : null;
  const code = v ? challengeCode(v.state.seed) : null;

  const title = !v
    ? 'Start a campaign'
    : v.phase === 'over'
      ? v.winner === v.human
        ? 'Victory: your realm wins'
        : `${v.state.realms[v.winner ?? 0]!.name} wins the campaign`
      : `${seasonTitle(v.state.season)} · campaign #${v.id}`;

  const start = async (realms: number, seasons: number, quick: boolean, daily: boolean, challenge?: string | true): Promise<void> => {
    const created = await game.newCampaign(realms, seasons, quick, daily, challenge);
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
          <div className="header-tools">
            <Guide signals={guideSignals} quiet={id !== null && !v && (game.busy || game.status.tone !== 'error')} hold={v?.phase === 'over'} onFirstSeason={guide.restore} />
            <Account game={game} signer={signer} setSigner={setSigner} />
          </div>
          {(!v || v.phase === 'over') && <StartForm busy={game.busy} onStart={(r, s, q, d, c) => void start(r, s, q, d, c)} />}
        </div>
      </header>

      <main className="layout">
        {v ? (
          <Board
            state={v.state}
            overlay={overlay}
            tipHtml={(p) => provinceTip(v.state, p)}
            onPick={game.clickProvince}
            replay={replay}
            head={(toggle) => (
              <>
                <h2>{title}</h2>
                <StandingBar v={v} />
                <TurnSteps game={game} v={v} />
                <StatusLine game={game} />
                {toggle}
                {guide.strip}
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
              {id === null ? (
                <>
                  {badLink && (
                    <div className="panel continue">
                      <h2>That challenge link isn’t right</h2>
                      <p className="fine">A challenge link ends in a 6-character code, like /challenge/a1b2c3. Check it with whoever sent it, or start your own below.</p>
                    </div>
                  )}
                  {accepting && (
                    <div className="panel continue">
                      <h2>You are challenged</h2>
                      <p className="fine">
                        A friend sent you challenge {accepting}: the same map they played, against {QUICK_MATCH.realms - 1} AI rulers for {QUICK_MATCH.maxSeasons} seasons. Your results go
                        on the challenge's board.
                      </p>
                      {!dead && (
                        <button type="button" className="primary" disabled={game.busy} onClick={() => void start(QUICK_MATCH.realms, QUICK_MATCH.maxSeasons, true, false, accepting)}>
                          Accept: play this map
                        </button>
                      )}
                      <ChallengeBoard code={accepting} onMissing={() => setDeadCode(accepting)} />
                    </div>
                  )}
                  <Continue signer={signer} />
                  <div className="panel continue">
                    <DailyBoard />
                  </div>
                </>
              ) : (
                <p className="fine">The war table is set when your campaign starts.</p>
              )}
            </div>
          </section>
        )}

        {v && (
          <aside className="side">
            <OrdersPanel game={game} v={v} />
            <ChancellorPanel game={game} v={v} />
            <EnvoysPanel game={game} v={v} />
            {/* a first campaign starts with it folded, and it opens once the first season has turned */}
            <Fold title="Chronicle" note="what everyone did last season" open={!guide.active || v.state.season > 0}>
              <ul className="chronicle">
                {/* names never change, so the current state can label last season's events after a reload */}
                <ChronicleLines before={game.before ?? v.state} events={v.lastEvents} limit={40} empty={v.state.season === 0 ? 'Your realm awaits orders.' : 'A quiet season.'} />
              </ul>
            </Fold>
          </aside>
        )}
      </main>

      {v && (
        <section className="proof">
          {/* folded in a first campaign, to keep the essentials in front; a click on the heading opens them */}
          <Fold title="Realms" note="every realm's land, treaties and secret agenda" open={!guide.active || guide.finished} data-tour="realms">
            <RealmList v={v} />
          </Fold>
          <Fold title="The proof" note="the contract, the proof bundle and the command to check it" open={!guide.active || guide.finished} data-tour="proof">
            <Proof v={v} />
          </Fold>
          {code && (
            <div className="panel">
              <ChallengeBoard code={code} mine={v.id} progress={`${v.season}:${v.phase}`} />
            </div>
          )}
          {day && (
            <div className="panel">
              <DailyBoard date={day} mine={v.id} progress={`${v.season}:${v.phase}`} />
            </div>
          )}
        </section>
      )}
      <Footer>
        <Link to="/">Watch AI-only campaigns</Link>
      </Footer>
      {v && phone && <PhoneDock game={game} v={v} selection={<Selection game={game} v={v} />} guide={guide.dockLine} />}
      {guide.spotlight}
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
    <p className={`status ${game.status.tone}`} role="status" data-tour="status">
      {game.status.text}
    </p>
  );
}

/** The lengths on offer, in the menu's order: the quick match (fixed: 2 rivals, 6 seasons, a small map), today's daily, a challenge, or a full map. */
const LENGTHS = [
  { key: 'quick', label: `Quick · ${QUICK_MATCH.realms - 1} rivals, ${QUICK_MATCH.maxSeasons} seasons, small map (~15 min)`, seasons: QUICK_MATCH.maxSeasons, quick: true, daily: false, challenge: false },
  { key: 'daily', label: `Daily challenge · today's map, the same for everyone (${QUICK_MATCH.maxSeasons} seasons)`, seasons: QUICK_MATCH.maxSeasons, quick: true, daily: true, challenge: false },
  { key: 'challenge', label: `Challenge a friend · a new map to share by link (${QUICK_MATCH.maxSeasons} seasons)`, seasons: QUICK_MATCH.maxSeasons, quick: true, daily: false, challenge: true },
  { key: '8', label: '8 seasons', seasons: 8, quick: false, daily: false, challenge: false },
  { key: '12', label: '12 seasons', seasons: 12, quick: false, daily: false, challenge: false },
  { key: '20', label: '20 seasons', seasons: 20, quick: false, daily: false, challenge: false },
] as const;
type Length = (typeof LENGTHS)[number]['key'];

function StartForm({ busy, onStart }: { busy: boolean; onStart: (realms: number, seasons: number, quick: boolean, daily: boolean, challenge?: true) => void }) {
  const [length, setLength] = useState<Length>('quick');
  // rivals for a full-size map; the quick match always has 2
  const [realms, setRealms] = useState(4);
  const pick = LENGTHS.find((l) => l.key === length)!;
  return (
    <div className="controls" data-tour="start">
      <label>
        Length
        <select value={length} onChange={(e) => setLength(e.target.value as Length)}>
          {LENGTHS.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      {!pick.quick && (
        <label>
          Rivals
          <select value={realms} onChange={(e) => setRealms(Number(e.target.value))}>
            <option value={3}>2</option>
            <option value={4}>3</option>
            <option value={5}>4</option>
          </select>
        </label>
      )}
      <button type="button" className="primary" disabled={busy} onClick={() => onStart(pick.quick ? QUICK_MATCH.realms : realms, pick.seasons, pick.quick, pick.daily, pick.challenge ? true : undefined)}>
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
  // a key from an earlier sign-in that lacks a newer move: sign in again to refresh it
  const doRefreshKey = (): void =>
    void game.withBusy('Refreshing your key: sign in again and approve the key limited to the realm contract…', async () => {
      await signer?.signOut();
      setSigner(null);
      try {
        const s = await signIn();
        setSigner(s);
        game.say(`Signed in as ${s.accountId} with a current key.`);
      } catch (e) {
        throw new Error(`${(e as Error).message}. You are signed out: sign in again to keep playing with your wallet.`);
      }
    });
  const doSignOut = (): void =>
    void game.withBusy('Signing out…', async () => {
      await signer?.signOut();
      setSigner(null);
      game.say('Signed out. New campaigns use a guest seat.');
    });
  return (
    <div className="account" data-tour="account">
      {signer ? (
        <>
          <span className="who-am-i" title="Your NEAR testnet account">
            {signer.accountId}
          </span>{' '}
          <button type="button" onClick={doSignOut}>
            Sign out
          </button>
          {!keyIsCurrent(signer) && (
            <span className="fine stale-key">
              Your wallet key is missing or predates a newer move, so the wallet may ask you to approve moves.{' '}
              <button type="button" onClick={doRefreshKey}>
                Refresh key
              </button>
            </span>
          )}
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
