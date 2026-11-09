// The game against the AI rulers: the campaign view from the server, your draft orders, and
// the flows that seal, reveal, hire and send envoys. Flows run one at a time (`busy`).
import { useCallback, useEffect, useRef, useState } from 'react';
import { canonicalJson, newSalt, sealOrders, type GameEvent, type GameState, type Order, type OrderSet, type Treaty, revealable, forfeitOpensAt, ORDERS_REFUSED } from '@realm-ledger/rules';
import { api, type ChancellorTask, type Envoy, type View } from '../api.ts';
import { view as chainView } from '../chain.ts';
import { capitalize } from '../format.ts';
import { rememberCampaign } from '../recent.ts';
import { findSecret, isRefused, keepSecret, markRefused } from '../secrets.ts';
import type { Signer } from '../wallet.ts';

export type Status = { text: string; tone: 'info' | 'error' };

export interface EnvoyDraft {
  to: number;
  message: string;
  proposal?: { kind: Treaty['kind']; amount?: number };
}

const INTRO = 'Choose how many rivals and how long, then start. Each campaign is created onchain.';

/** Whether two orders are the same order. */
const sameOrder = (a: Order, b: Order): boolean => canonicalJson(a) === canonicalJson(b);

export function useGame(id: number | null, signer: Signer | null) {
  const [view, setViewState] = useState<View | null>(null);
  const [before, setBefore] = useState<GameState | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  // orders the player added or changed (never a reset or a removal): for the walkthrough
  const [orderEdits, setOrderEdits] = useState(0);
  const [marches, setMarches] = useState(0);
  // the player's own selections and seals, counted the same way (for the walkthrough)
  const [selections, setSelections] = useState(0);
  const [seals, setSeals] = useState(0);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [busy, setBusyState] = useState(false);
  const [status, setStatusState] = useState<Status>({ text: INTRO, tone: 'info' });
  // a sealed season this browser can't reveal: when the contract lets it settle without your orders
  const [forfeitAt, setForfeitAt] = useState<number | null>(null);

  // flows await the server and the chain: they read the latest values through refs
  const viewRef = useRef<View | null>(null);
  const busyRef = useRef(false);
  // the campaign in the URL: a flow that finishes after you navigated away must not bring its campaign back
  const routeRef = useRef(id);
  const triedRef = useRef<number | null>(null);
  const signerRef = useRef(signer);
  signerRef.current = signer;
  const setView = (v: View | null): void => {
    viewRef.current = v;
    setViewState(v);
  };
  const setBusy = (b: boolean): void => {
    busyRef.current = b;
    setBusyState(b);
  };
  /** Shows a campaign the server returned, if it is still the one in the URL. */
  const adopt = (v: View, route: number | null = v.id): boolean => {
    if (routeRef.current !== route) return false;
    setView(v);
    // a forfeit offer belongs to one sealed season
    if (v.phase !== 'sealed') setForfeitAt(null);
    return true;
  };
  // the URL a running flow started on: its messages are dropped once you navigate away
  const flowRouteRef = useRef<number | null>(null);
  const say = (text: string, tone: Status['tone'] = 'info'): void => {
    if (busyRef.current && flowRouteRef.current !== routeRef.current) return;
    setStatusState({ text, tone });
  };
  const freshDraft = (): void => {
    setOrders([]);
    setSelected(undefined);
  };

  useEffect(() => {
    document.body.classList.toggle('busy', busy);
  }, [busy]);

  const withBusy = useCallback(async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    flowRouteRef.current = routeRef.current;
    setBusy(true);
    say(label);
    try {
      await fn();
    } catch (e) {
      say((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }, []);

  /** The wallet that must sign for this campaign, or an explanation of why it can't. */
  const walletFor = (v: View): Signer => {
    const s = signerRef.current;
    if (!s) throw new Error(`This campaign is ruled by ${v.player}. Sign in with that wallet to play it.`);
    if (s.accountId !== v.player) throw new Error(`This campaign is ruled by ${v.player}, but you are signed in as ${s.accountId}.`);
    return s;
  };

  /** The fresh campaign, for checking what the server did after a call failed; keeps that call's error if this fails too. */
  const recheck = (v: View, e: unknown): Promise<View> =>
    api<View>(`/campaigns/${v.id}`).catch(() => {
      throw e;
    });

  /** POSTs /reveal and resolves to the settled season, also when the connection dropped after the server settled. */
  const settle = async (v: View, body: object): Promise<{ events: GameEvent[]; view: View }> => {
    try {
      return await api<{ events: GameEvent[]; view: View }>(`/campaigns/${v.id}/reveal`, body);
    } catch (e) {
      const now = await recheck(v, e);
      if (now.season === v.season) throw e;
      // settled, maybe by another browser: lastForfeited says whether your orders counted,
      // but only if nothing settled since
      return { events: now.lastEvents, view: now.season === v.season + 1 ? now : { ...now, lastForfeited: false } };
    }
  };

  /**
   * This season onchain for your realm. A view that fails reads as false, and `known` says
   * whether all three were read, so a decision is never taken on a failed read alone.
   */
  const onChain = (v: View) => {
    const where = { campaign: v.id, season: v.season, realm: v.human };
    const FAILED = Symbol('failed');
    const read = <T,>(p: Promise<T>) => p.catch((): typeof FAILED => FAILED);
    return Promise.all([
      read(chainView<{ seal_deadline_ms: number; season_ms: number; season: number }>('get_campaign', { campaign: v.id })),
      read(chainView<{ revealed: boolean }>('get_seal', where)),
      // only a wallet ruler can forfeit; a guest seat's mark is always false
      v.player ? read(chainView<boolean>('get_forfeit', where)) : Promise.resolve(false),
    ]).then(([c0, rec, declared]) => {
      const c = c0 === FAILED ? null : c0;
      return {
        c,
        revealed: rec !== FAILED && !!rec?.revealed,
        declared: declared === true,
        moved: !!c && c.season > v.season,
        known: c0 !== FAILED && rec !== FAILED && declared !== FAILED,
      };
    });
  };
  const unreadable = (e: unknown) => new Error(`${(e as Error).message} (and the chain could not be read to see why; try again in a moment)`);

  /** Shows the season a settle produced: the new view, a fresh draft, no forfeit offer, and what happened. */
  const showSettled = (r: { view: View }, forfeitedElsewhere = false): void => {
    if (!adopt(r.view)) return;
    setForfeitAt(null);
    freshDraft();
    const over = r.view.phase === 'over' ? ' The campaign is over. Everything is revealed.' : '';
    say(
      r.view.lastForfeited
        ? `${forfeitedElsewhere ? 'Your wallet forfeited these orders, so the season settled without them.' : 'The season turned without your orders, so your realm did nothing in it.'}${over || ' Plan the next one.'}`
        : over
          ? over.trim()
          : `The season turned. ${r.view.envoysLeft} envoys available.`,
    );
  };

  const reveal = async (): Promise<void> => {
    const v = viewRef.current;
    if (!v || v.phase !== 'sealed') return;
    const found = findSecret(v.id, v.season, v.yourSeal);
    // orders the contract won't accept as a reveal (sealed before that was checked, or refused
    // by it already) are as good as lost: offer to settle without them, and don't resend them
    const secret = found && revealable(found.orders, found.salt) && !isRefused(v.id, v.season) ? found : null;
    if (!secret) {
      const { c, revealed, declared, known } = await onChain(v);
      // still the same sealed season once the chain answered
      const cur = viewRef.current;
      if (cur?.id !== v.id || cur.season !== v.season || cur.phase !== 'sealed') return;
      if (!known) {
        say('Your sealed orders are not here, and the chain could not be read to see what can be done. Reload to try again.', 'error');
        return;
      }
      if (declared && !revealed) {
        // your wallet already forfeited (from another browser): finish settling without them
        await withBusy('Your wallet forfeited these orders; settling the season without them…', async () => {
          setBefore(v.state);
          showSettled(await settle(v, { forfeit: true }), true);
        });
        return;
      }
      if (revealed) {
        // revealed onchain from another browser: the contract keeps those orders until the
        // season settles, so the server can finish it without them being here
        await withBusy('Your orders are revealed onchain; settling the season with them…', async () => {
          setBefore(v.state);
          showSettled(await settle(v, {}));
        });
        return;
      }
      // a wallet gives up its own orders at once; a guest seat's settle without them once the
      // contract's reveal window closes (or now, if the chain already settled this season)
      const at = !c ? null : v.player || c.season > v.season ? Date.now() : forfeitOpensAt(c);
      setForfeitAt(at);
      say(
        `${found ? 'The contract cannot accept your sealed orders as a reveal' : 'Your sealed orders are not stored in this browser, so they cannot be revealed here. Reveal from a browser that still holds them'}${
          at
            ? `${found ? '. Settle' : ', or settle'} the season without them (your realm does nothing this season) ${at <= Date.now() ? (v.player ? 'now, from your wallet' : 'now') : `from ${new Date(at).toLocaleString()}`}`
            : ''
        }.`,
        'error',
      );
      return;
    }
    await withBusy('Revealing every ruler’s orders; the contract checks each against its seal…', async () => {
      setBefore(v.state);
      let forfeited = false;
      if (v.player) {
        let state = await onChain(v);
        // forfeited from another browser: the contract refuses a reveal, so settle as forfeited;
        // past this season onchain already: the server settles it as it stands
        if (!state.revealed && !state.declared && !state.moved) {
          try {
            await walletFor(v).call('reveal', { campaign: v.id, realm: v.human, orders: canonicalJson(secret.orders), salt: secret.salt });
          } catch (e) {
            // a forfeit from another browser may have landed first: decide from the chain
            state = await onChain(v);
            if (!state.revealed && !state.declared && !state.moved) {
              // still unrevealed because the contract refused these orders themselves (not a
              // cancelled popup, a network error or running out of gas): offer to give them up
              if (state.known && ORDERS_REFUSED.test(String((e as Error)?.message ?? e))) {
                markRefused(v.id, v.season);
                setForfeitAt(Date.now());
              }
              throw state.known ? e : unreadable(e);
            }
          }
        }
        forfeited = state.declared && !state.revealed;
      }
      let r: Awaited<ReturnType<typeof settle>>;
      try {
        r = await settle(v, forfeited ? { forfeit: true } : secret);
      } catch (e) {
        // the contract refused these orders: they can't be revealed, so stop sending them and
        // offer to settle without them
        if (/settle the season without them/.test((e as Error).message)) {
          markRefused(v.id, v.season);
          const { c } = await onChain(v);
          if (c) setForfeitAt(v.player ? Date.now() : forfeitOpensAt(c));
        }
        throw e;
      }
      showSettled(r, forfeited);
    });
  };

  /** Settles a sealed season without your orders, once the contract allows it. */
  const forfeit = async (): Promise<void> => {
    const v = viewRef.current;
    if (!v || v.phase !== 'sealed') return;
    await withBusy('Settling the season without your orders; every AI ruler reveals…', async () => {
      setBefore(v.state);
      let revealedElsewhere = false;
      if (v.player) {
        // only your wallet can give up your orders; the contract then blocks their reveal.
        // Every decision here comes from the chain, not from error wording.
        // nothing to sign if it's forfeited or revealed already, or the season moved on
        const settled = (x: Awaited<ReturnType<typeof onChain>>) => x.declared || x.revealed || x.moved;
        let state = await onChain(v);
        // a forfeit can't be undone: never sign one without knowing the chain's state
        if (!state.known) throw new Error('The chain could not be read to check your orders; try again in a moment.');
        if (!settled(state)) {
          say('Giving up your sealed orders onchain from your account…');
          try {
            await walletFor(v).call('forfeit', { campaign: v.id, realm: v.human, season: v.season });
          } catch (e) {
            state = await onChain(v);
            if (!settled(state)) {
              if (!state.known) throw unreadable(e);
              const msg = (e as Error).message;
              if (/does not allow method|MethodNameMismatch|MethodNotAllowed|method name is not allowed|not allowed to call/i.test(msg)) {
                throw new Error(`${msg} Your wallet key predates this action: sign out and sign in again (Refresh key at the top does both), then try again.`);
              }
              throw e;
            }
          }
        }
        // revealed from another browser meanwhile: those orders count, so settle with them
        revealedElsewhere = state.revealed;
      }
      showSettled(await settle(v, revealedElsewhere ? {} : { forfeit: true }));
    });
  };

  // a new URL: drop whatever campaign was on screen unless it is the one asked for
  useEffect(() => {
    routeRef.current = id;
    triedRef.current = null;
    if (viewRef.current && viewRef.current.id !== id) {
      setView(null);
      setBefore(null);
      freshDraft();
    }
    setForfeitAt(null);
    if (id === null) setStatusState({ text: INTRO, tone: 'info' });
  }, [id]);

  // load the campaign in the URL once nothing else is running (a flow may still be finishing)
  useEffect(() => {
    if (id === null || busy || viewRef.current?.id === id || triedRef.current === id) return;
    triedRef.current = id;
    void withBusy('Loading campaign…', async () => {
      const v = await api<View>(`/campaigns/${id}`);
      if (!adopt(v, id)) return;
      setBefore(null);
      freshDraft();
      say(v.phase === 'over' ? 'This campaign is over. Everything is revealed.' : `Campaign ${v.id}: plan your orders, then seal them.`);
    }).then(() => {
      // a sealed season whose reveal was interrupted: finish it
      if (viewRef.current?.id === id && viewRef.current.phase === 'sealed') return reveal();
    });
    // reveal and withBusy read only refs
  }, [id, busy]);

  /** Creates a campaign onchain; resolves to its id, or null if it failed. */
  const newCampaign = async (realms: number, seasons: number): Promise<number | null> => {
    let created: number | null = null;
    const route = routeRef.current;
    await withBusy('Creating the campaign onchain and fetching the model attestation…', async () => {
      const s = signerRef.current;
      const v = await api<View>('/campaigns', {
        realms,
        seasons,
        // signed in: your own account rules realm 0 onchain
        ...(s ? { player: s.accountId } : {}),
      });
      if (!adopt(v, route)) return;
      setBefore(null);
      freshDraft();
      created = v.id;
      rememberCampaign(v.id);
      say(`Campaign ${v.id} is onchain. Plan your first season.`);
    });
    return created;
  };

  const seal = async (): Promise<void> => {
    const v = viewRef.current;
    if (!v) return;
    await withBusy('Sealing: posting your hash and every AI ruler’s onchain…', async () => {
      const set: OrderSet = { realm: v.human, season: v.season, orders };
      // a seal the contract couldn't accept as a reveal would leave the season stuck
      if (!revealable(set)) throw new Error('The contract could not accept these orders as a reveal: they are too large, or hold a value it cannot store. Change them and seal again.');
      // the wallet that must sign, checked before anything is stored
      const wallet = v.player ? walletFor(v) : null;
      // an earlier attempt's seal may already be onchain (the contract takes one per season):
      // then that seal stands and the server is told about it, not a new one
      const posted = wallet
        ? ((await chainView<{ seal: string }>('get_seal', { campaign: v.id, season: v.season, realm: v.human }).catch(() => null))?.seal ?? undefined)
        : undefined;
      const salt = newSalt();
      const hash = posted ?? sealOrders(set, salt);
      if (!posted) keepSecret(v.id, { orders: set, salt });
      // sealing here makes it yours to come back to (opening a link alone doesn't); remembered
      // before the network calls, since the seal may land onchain even if they error
      rememberCampaign(v.id);
      if (wallet && !posted) {
        // your own key posts your seal; the server only sees the hash and checks it onchain
        say('Posting your seal onchain from your account…');
        await wallet.call('seal', { campaign: v.id, realm: v.human, seal: hash });
      }
      let after: View;
      try {
        after = await api<View>(`/campaigns/${v.id}/seal`, { seal: hash });
      } catch (e) {
        // the connection may drop after the server acted; check before giving up
        after = await recheck(v, e);
        if (after.phase !== 'sealed') throw e;
      }
      // (counted only for the campaign on screen)
      if (adopt(after)) setSeals((n) => n + 1);
      // the server keeps a seal an earlier attempt already put onchain
      if (posted || (after.yourSeal && after.yourSeal !== hash)) say('Your seal from an earlier attempt was already onchain, so the orders you sealed then stand, not the ones on screen. Revealing…');
      else say(`Sealed ${hash.slice(0, 16)}… Revealing…`);
    });
    // reveals only if the season is sealed, even when the seal call itself errored
    await reveal();
  };

  /** Gives the Chancellor a task; resolves to true if it was accepted. */
  const giveTask = async (task: string, budget: number): Promise<boolean> => {
    const v = viewRef.current;
    if (!v) return false;
    let ok = false;
    await withBusy('The Chancellor reads your task, asks for quotes and haggles…', async () => {
      if (v.player) {
        // you set your Chancellor's spending cap onchain; the contract enforces it on every hire
        const p = await chainView<{ season_cap: number; campaign_cap: number; spent_season: number; season: number; spent_total: number }>('get_policy', {
          campaign: v.id,
          spender: v.chancellor,
        });
        const spentSeason = p && p.season === v.season ? p.spent_season : 0;
        const spentTotal = p?.spent_total ?? 0;
        say('Setting the Chancellor’s cap onchain from your account…');
        await walletFor(v).call('set_policy', { campaign: v.id, realm: v.human, spender: v.chancellor, season_cap: spentSeason + budget, campaign_cap: spentTotal + budget });
      }
      const r = await api<{ task: ChancellorTask; view: View }>(`/campaigns/${v.id}/chancellor`, { task, budget });
      ok = adopt(r.view);
      say(r.task.jobs.length ? `Hired ${r.task.jobs.length}; ${r.task.plan.spent} crowns in escrow until the season turns.` : 'The Chancellor bought nothing this time.');
    });
    return ok;
  };

  /** Sends an envoy; resolves to true if it rode out. */
  const sendEnvoy = async (draft: EnvoyDraft): Promise<boolean> => {
    const v = viewRef.current;
    if (!v) return false;
    let ok = false;
    await withBusy('Your envoy rides out…', async () => {
      const r = await api<{ envoy: Envoy; view: View }>(`/campaigns/${v.id}/envoy`, draft);
      if (!adopt(r.view)) return;
      const t = r.view.proposeTreaty;
      if (t && v.player) {
        // the envoy agreed: propose the treaty from your own account, then the rival accepts onchain
        say('Proposing the treaty onchain from your account…');
        const treaty = await walletFor(v).call<number>('propose_treaty', { campaign: v.id, from: t.from, to: t.to, kind: capitalize(t.kind), amount: t.amount });
        adopt(await api<View>(`/campaigns/${v.id}/treaty`, { treaty }));
      }
      ok = true;
      say(r.envoy.accepted === undefined ? 'The envoy returns.' : r.envoy.accepted ? 'Treaty signed onchain by both rulers.' : 'Refused.');
    });
    return ok;
  };

  // ---- draft orders ----

  const armyAt = (p: number) => view?.state.armies.find((a) => a.realm === view.human && a.province === p);

  const clickProvince = (p: number): void => {
    if (!view || view.phase !== 'planning' || busyRef.current) return;
    if (selected !== undefined && armyAt(selected) && view.state.map.provinces[selected]!.neighbors.includes(p)) {
      const from = selected;
      // the same march again changes nothing, and isn't an edit
      if (!orders.some((o) => o.kind === 'march' && o.from === from && o.to === p)) {
        setOrderEdits((n) => n + 1);
        setMarches((n) => n + 1);
      }
      setOrders((os) => [...os.filter((o) => !(o.kind === 'march' && o.from === from)), { kind: 'march', from, to: p }]);
      setSelected(undefined);
    } else {
      const next = selected === p ? undefined : p;
      // (the player's own province or army: what the walkthrough asks them to pick)
      if (next !== undefined && (view.state.owner[p] === view.human || armyAt(p))) setSelections((n) => n + 1);
      setSelected(next);
    }
  };

  const addOrder = (o: Order): void => {
    // (the same order again adds a copy, but isn't a change the walkthrough counts)
    if (!orders.some((x) => sameOrder(x, o))) setOrderEdits((n) => n + 1);
    setOrders((os) => [...os, o]);
  };
  /** The Chancellor's advice, added once. */
  const addAdvice = (o: Order): void => {
    const same = (x: Order): boolean => sameOrder(x, o);
    // advice already in the list adds nothing, and isn't an edit; an advised march is a march
    if (!orders.some(same)) {
      setOrderEdits((n) => n + 1);
      if (o.kind === 'march') setMarches((n) => n + 1);
    }
    setOrders((os) => (os.some(same) ? os : [...os, o]));
  };
  const removeOrder = (i: number): void => setOrders((os) => os.filter((_, k) => k !== i));

  return { view, before, orders, orderEdits, marches, selections, seals, selected, busy, status, say, withBusy, armyAt, newCampaign, seal, forfeit, forfeitAt, giveTask, sendEnvoy, clickProvince, addOrder, addAdvice, removeOrder };
}

export type Game = ReturnType<typeof useGame>;
