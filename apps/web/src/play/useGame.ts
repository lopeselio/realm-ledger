// The game against the AI rulers: the campaign view from the server, your draft orders, and
// the flows that seal, reveal, hire and send envoys. Flows run one at a time (`busy`).
import { useCallback, useEffect, useRef, useState } from 'react';
import { canonicalJson, newSalt, sealOrders, type GameEvent, type GameState, type Order, type OrderSet, type Treaty } from '@realm-ledger/rules';
import { api, type ChancellorTask, type Envoy, type View } from '../api.ts';
import { view as chainView } from '../chain.ts';
import { capitalize } from '../format.ts';
import { rememberCampaign } from '../recent.ts';
import { findSecret, keepSecret } from '../secrets.ts';
import type { Signer } from '../wallet.ts';

export type Status = { text: string; tone: 'info' | 'error' };

export interface EnvoyDraft {
  to: number;
  message: string;
  proposal?: { kind: Treaty['kind']; amount?: number };
}

const INTRO = 'Choose how many rivals and how long, then start. Each campaign is created onchain.';

export function useGame(id: number | null, signer: Signer | null) {
  const [view, setViewState] = useState<View | null>(null);
  const [before, setBefore] = useState<GameState | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [busy, setBusyState] = useState(false);
  const [status, setStatusState] = useState<Status>({ text: INTRO, tone: 'info' });

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

  const reveal = async (): Promise<void> => {
    const v = viewRef.current;
    if (!v || v.phase !== 'sealed') return;
    const secret = findSecret(v.id, v.season, v.yourSeal);
    if (!secret) {
      say('Your sealed orders are not stored in this browser, so they cannot be revealed here. Only a browser that still holds them (the one you sealed from, if its storage was kept) can finish this season.', 'error');
      return;
    }
    await withBusy('Revealing every ruler’s orders; the contract checks each against its seal…', async () => {
      setBefore(v.state);
      if (v.player) {
        const rec = await chainView<{ revealed: boolean }>('get_seal', { campaign: v.id, season: v.season, realm: v.human });
        if (!rec?.revealed) await walletFor(v).call('reveal', { campaign: v.id, realm: v.human, orders: canonicalJson(secret.orders), salt: secret.salt });
      }
      let r: { events: GameEvent[]; view: View };
      try {
        r = await api<{ events: GameEvent[]; view: View }>(`/campaigns/${v.id}/reveal`, secret);
      } catch (e) {
        const now = await api<View>(`/campaigns/${v.id}`);
        if (now.season === v.season) throw e;
        r = { events: now.lastEvents, view: now };
      }
      if (!adopt(r.view)) return;
      freshDraft();
      say(r.view.phase === 'over' ? 'The campaign is over. Everything is revealed.' : `The season turned. ${r.view.envoysLeft} envoys available.`);
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
      const salt = newSalt();
      const hash = sealOrders(set, salt);
      // the wallet that must sign, checked before anything is stored
      const wallet = v.player ? walletFor(v) : null;
      keepSecret(v.id, { orders: set, salt });
      // sealing here makes it yours to come back to (opening a link alone doesn't); remembered
      // before the network calls, since the seal may land onchain even if they error
      rememberCampaign(v.id);
      if (wallet) {
        // your own key posts your seal; the server only sees the hash and checks it onchain
        say('Posting your seal onchain from your account…');
        await wallet.call('seal', { campaign: v.id, realm: v.human, seal: hash });
      }
      try {
        adopt(await api<View>(`/campaigns/${v.id}/seal`, { seal: hash }));
      } catch (e) {
        // the connection may drop after the server acted; check before giving up
        const now = await api<View>(`/campaigns/${v.id}`);
        if (now.phase !== 'sealed') throw e;
        adopt(now);
      }
      say(`Sealed ${hash.slice(0, 16)}… Revealing…`);
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
      setOrders((os) => [...os.filter((o) => !(o.kind === 'march' && o.from === from)), { kind: 'march', from, to: p }]);
      setSelected(undefined);
    } else {
      setSelected(selected === p ? undefined : p);
    }
  };

  const addOrder = (o: Order): void => setOrders((os) => [...os, o]);
  /** The Chancellor's advice, added once. */
  const addAdvice = (o: Order): void => setOrders((os) => (os.some((x) => JSON.stringify(x) === JSON.stringify(o)) ? os : [...os, o]));
  const removeOrder = (i: number): void => setOrders((os) => os.filter((_, k) => k !== i));

  return { view, before, orders, selected, busy, status, say, withBusy, armyAt, newCampaign, seal, giveTask, sendEnvoy, clickProvince, addOrder, addAdvice, removeOrder };
}

export type Game = ReturnType<typeof useGame>;
