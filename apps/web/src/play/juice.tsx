// Feedback for what the player does and what comes back: a toast and a province icon for each
// order queued, the treasury ticking, an envoy's sealed letter, the season's battles and gains, a
// summary of each season and a closing screen. Every effect comes from a real change (an order
// added, a server reply, a settled season) and changes nothing in the game.
import { useEffect, useRef, useState } from 'react';
import { canonicalJson, COST, GOODS, NEUTRAL, troopCount, type GameEvent, type GameState, type Order, type Purse } from '@realm-ledger/rules';
import type { Envoy, View } from '../api.ts';
import { colorOf } from '../map.ts';
import { describeOrder, seasonTitle } from '../format.ts';
import { boardFx, dismissToast, later, toast, useToasts, type Tone } from '../juice.ts';
import { FRESH_MS, TIMING } from '../playback.ts';
import { reducedMotion } from '../onboarding/storage.ts';
import {
  chimeSound,
  drumSound,
  fanfareSound,
  hammerSound,
  hornSound,
  quillSound,
  sealCrackSound,
  somberSound,
  sparkleSound,
  stoneSound,
} from '../sound.ts';
import { shownScores } from './turn.tsx';

// ---------- costs, icons and the treasury ----------

type Res = keyof Purse;
const RES: Res[] = ['crowns', ...GOODS];
export const RES_ICON: Record<Res, string> = { crowns: '🪙', grain: '🌾', timber: '🪵', iron: '⛏', gold: '✨' };

/** What an order would take from the treasury (negative: what it brings in), as the rules price it now. */
export function orderCost(s: GameState, o: Order): Partial<Record<Res, number>> {
  switch (o.kind) {
    case 'fortify':
      return { ...COST.fortify };
    case 'levy':
      return { ...COST.levy };
    case 'recruit':
      return { crowns: COST.regular.crowns * o.count, iron: COST.regular.iron * o.count };
    case 'build':
      return { ...COST.town };
    case 'trade': {
      const price = s.market.price[o.good];
      return o.side === 'buy' ? { crowns: price * o.qty, [o.good]: -o.qty } : { [o.good]: o.qty, crowns: -Math.floor(price * 0.8) * o.qty };
    }
    case 'march':
      return {};
  }
}

/** "−4🪙 −3🪵 −2⛏" (and "+12🪙" for what a sale brings in). */
export function costText(c: Partial<Record<Res, number>>): string {
  return RES.filter((r) => c[r])
    .map((r) => `${c[r]! > 0 ? '−' : '+'}${Math.abs(c[r]!)}${RES_ICON[r]}`)
    .join(' ');
}

/** The treasury once every queued order is paid for. */
function afterOrders(s: GameState, purse: Purse, orders: Order[]): Purse {
  const out = { ...purse };
  for (const o of orders) for (const [r, n] of Object.entries(orderCost(s, o)) as [Res, number][]) out[r] -= n;
  return out;
}

/** Icons for the queued orders, by province: 🏰 a fort, ⚔ troops, 🏠 a town. */
export function orderIcons(orders: Order[]): Map<number, string> {
  const icons = new Map<number, string>();
  for (const o of orders) {
    const i = o.kind === 'fortify' ? '🏰' : o.kind === 'levy' || o.kind === 'recruit' ? '⚔' : o.kind === 'build' ? '🏠' : null;
    if (i === null || !('province' in o)) continue;
    const had = icons.get(o.province) ?? '';
    if (!had.includes(i)) icons.set(o.province, had + i);
  }
  return icons;
}

/** One figure of the treasury: counts down (or up) to its new value, with the change floating off it. */
function Figure({ res, value, base }: { res: Res; value: number; base: number }) {
  const [shown, setShown] = useState(value);
  const [delta, setDelta] = useState<{ n: number; key: number } | null>(null);
  const last = useRef(value);
  useEffect(() => {
    const from = last.current;
    last.current = value;
    if (from === value) return;
    setDelta({ n: value - from, key: Date.now() });
    if (reducedMotion()) return setShown(value);
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const k = Math.min(1, (now - start) / 450);
      setShown(Math.round(from + (value - from) * k));
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return (
    <span className={`res${value < base ? ' spent' : ''}${value < 0 ? ' short' : ''}`} title={value !== base ? `${base} ${res} now; ${value} after your orders` : undefined}>
      <span aria-hidden="true">{RES_ICON[res]}</span> {shown} {res}
      {delta && (
        <span key={delta.key} className={`res-delta ${delta.n < 0 ? 'down' : 'up'}`} aria-hidden="true">
          {delta.n > 0 ? '+' : '−'}
          {Math.abs(delta.n)}
        </span>
      )}
    </span>
  );
}

/** "Treasury: 🪙 36 crowns · 🌾 8 grain …", after the queued orders, each figure ticking as they change. */
export function PurseLine({ v, orders }: { v: View; orders: Order[] }) {
  const purse = v.state.realms[v.human]!.purse;
  const after = v.phase === 'planning' ? afterOrders(v.state, purse, orders) : purse;
  const changed = RES.some((r) => after[r] !== purse[r]);
  return (
    <p className="purse" data-tour="purse">
      Treasury:{' '}
      {RES.map((r, i) => (
        <span key={r}>
          {i > 0 && ' · '}
          <Figure res={r} value={after[r]} base={purse[r]} />
        </span>
      ))}
      {changed && <span className="fine"> (after your orders)</span>}
    </p>
  );
}

// ---------- orders queued ----------

function orderFx(s: GameState, o: Order): { icon: string; text: string; sound: () => void; at?: number; pop?: string } {
  const name = (id: number): string => s.map.provinces[id]?.name ?? '?';
  switch (o.kind) {
    case 'march':
      return { icon: '➜', text: `March ordered: ${name(o.from)} → ${name(o.to)}`, sound: drumSound, at: o.to, pop: 'march' };
    case 'fortify':
      return { icon: '🏰', text: `Fort ordered in ${name(o.province)}`, sound: hammerSound, at: o.province, pop: 'fort' };
    case 'levy':
      return { icon: '⚔', text: `Levies ordered in ${name(o.province)}`, sound: drumSound, at: o.province, pop: `+${COST.levyTroops}` };
    case 'recruit':
      return { icon: '⚔', text: `${o.count} regulars ordered in ${name(o.province)}`, sound: drumSound, at: o.province, pop: `+${o.count}` };
    case 'build':
      return { icon: '🏠', text: `Town ordered in ${name(o.province)}`, sound: hammerSound, at: o.province, pop: 'town' };
    case 'trade':
      return { icon: '⚖', text: describeOrder(s, o), sound: quillSound };
  }
}

/** Watches the draft: each order added gets a toast, a sound and an icon rising from its province. */
export function useOrderFx(v: View | null, orders: Order[]): void {
  const prev = useRef<{ id: number; keys: string[] } | null>(null);
  useEffect(() => {
    const keys = orders.map((o) => canonicalJson(o));
    const was = prev.current;
    prev.current = v ? { id: v.id, keys } : null;
    if (!v || !was || was.id !== v.id || v.phase !== 'planning') return;
    // the orders not in the last draft (a copy counts as new)
    const left = [...was.keys];
    const added = orders.filter((_, i) => {
      const at = left.indexOf(keys[i]!);
      if (at < 0) return true;
      left.splice(at, 1);
      return false;
    });
    added.slice(-2).forEach((o, i) => {
      const fx = orderFx(v.state, o);
      const cost = costText(orderCost(v.state, o));
      toast({ icon: fx.icon, text: fx.text, ...(cost ? { detail: cost } : {}), tone: 'info' }, 2800);
      if (i === 0) fx.sound();
      if (fx.at !== undefined) boardFx({ kind: 'pop', province: fx.at, icon: fx.icon, ...(fx.pop ? { text: fx.pop } : {}), tone: 'gold' });
    });
  }, [v?.id, orders]);
}

export function ToastStack() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast tone-${t.tone}`} onClick={() => dismissToast(t.id)}>
          <span className="toast-icon" aria-hidden="true">
            {t.icon}
          </span>
          <span className="toast-text">{t.text}</span>
          {t.detail && <span className="toast-detail">{t.detail}</span>}
        </div>
      ))}
    </div>
  );
}

// ---------- envoys ----------

/** The envoy's reply as a sealed letter: the seal breaks, the reply, the verdict stamped, the TEE badge. */
export function EnvoyLetter({ v }: { v: View }) {
  const seen = useRef<{ id: number; n: number } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const n = v.envoys.length;
    const was = seen.current;
    seen.current = { id: v.id, n };
    if (!was || was.id !== v.id || n <= was.n) return;
    const e = v.envoys[n - 1]!;
    setOpen(n - 1);
    sealCrackSound(0.25);
    if (e.proposal) {
      if (e.accepted) chimeSound(0.95);
      else hornSound(0.95);
    } else chimeSound(0.7);
  }, [v.id, v.envoys.length]);
  useEffect(() => {
    if (open === null) return;
    const close = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', close);
    const t = window.setTimeout(() => setOpen(null), 16000);
    return () => {
      window.removeEventListener('keydown', close);
      window.clearTimeout(t);
    };
  }, [open]);
  // (read live: a treaty signed after the reply updates it)
  const e: Envoy | undefined = open !== null ? v.envoys[open] : undefined;
  if (!e) return null;
  const from = v.state.realms[e.to];
  return (
    <div className="letter" role="dialog" aria-label={`A letter from ${from?.name ?? 'a rival'}`}>
      <div className="letter-seal" aria-hidden="true" style={{ ['--wax' as string]: colorOf(e.to) }}>
        <span className="half l" />
        <span className="half r" />
      </div>
      <p className="letter-from">
        From <strong style={{ color: colorOf(e.to) }}>{from?.name}</strong>
      </p>
      <p className="letter-reply">“{e.reply}”</p>
      <div className="letter-foot">
        {e.proposal && (
          <span className={`letter-stamp ${e.accepted ? 'yes' : 'no'}`}>
            {e.accepted ? '✅' : '❌'} {e.proposal.kind} {e.accepted ? 'accepted' : 'refused'}
          </span>
        )}
        {e.verified && <span className="tag tee">TEE-signed ✓</span>}
        <button type="button" className="letter-close" onClick={() => setOpen(null)}>
          Close
        </button>
      </div>
    </div>
  );
}

// ---------- the season turns ----------

export interface SeasonSummaryData {
  key: string;
  season: number;
  land: [number, number];
  crowns: [number, number];
  won: number;
  lost: number;
  paid: number;
  refunded: number;
  over: boolean;
}

const nameOf = (s: GameState, realm: number, human: number): string => (realm === human ? 'you' : realm === NEUTRAL || realm < 0 ? 'militia' : (s.realms[realm]?.name ?? '?'));

/** "⚔ Battle at Normoor: you 12→5 vs Vey 10→9 · rolled 3" */
export function battleLine(s: GameState, e: Extract<GameEvent, { kind: 'battle' }>, human: number): string {
  const place = s.map.provinces[e.province]?.name ?? '?';
  const sides = [...e.sides].sort((a, b) => (a.realm === human ? -1 : b.realm === human ? 1 : 0));
  const roll = (sides.find((x) => x.realm === human) ?? sides.find((x) => x.realm === e.winner))?.roll;
  const parts = sides.map((x) => `${nameOf(s, x.realm, human)} ${troopCount(x.troopsBefore)}→${troopCount(x.troopsAfter)}`).join(' vs ');
  return `Battle at ${place}: ${parts}${roll !== undefined ? ` · rolled ${roll}` : ''}`;
}

/**
 * The settled season's moments, on the playback's clock: a banner and a flash for each battle, a
 * fanfare for a province taken, stone for a fort, a sparkle for a new city; then the summary.
 */
export function useSeasonFx(v: View | null, before: GameState | null, replay: { key: string; at: number } | null, onDone: (d: SeasonSummaryData) => void): void {
  const done = useRef(onDone);
  done.current = onDone;
  const started = useRef(new Set<string>());
  useEffect(() => {
    if (!v || !before || !replay || started.current.has(replay.key) || Date.now() - replay.at > FRESH_MS) return;
    started.current.add(replay.key);
    const key = replay.key;
    const bag: (() => void)[] = [];
    const s = v.state;
    const me = v.human;
    const place = (id: number): string => s.map.provinces[id]?.name ?? '?';
    let battles = 0;
    let won = 0;
    let lost = 0;
    let captures = 0;
    let builds = 0;
    let moved = false;
    for (const e of v.lastEvents) {
      if (e.kind === 'moved' || e.kind === 'retreated' || e.kind === 'destroyed') moved = true;
      if (e.kind === 'battle') {
        const mine = e.sides.some((x) => x.realm === me);
        const win = e.winner === me;
        if (mine) win ? won++ : lost++;
        const tone: Tone = !mine ? 'info' : win ? 'gold' : 'bad';
        later(bag, TIMING.battle + battles * 1300, () => {
          boardFx({ kind: 'banner', icon: '⚔', text: battleLine(s, e, me), tone, ms: 2300 });
          if (mine) boardFx({ kind: 'flash', tone: win ? 'gold' : 'red', shake: !win });
        });
        battles++;
      } else if (e.kind === 'captured' && (e.realm === me || e.from === me)) {
        const ours = e.realm === me;
        later(bag, TIMING.capture + battles * 400 + captures * 500, () => {
          boardFx({ kind: 'banner', icon: '⚑', text: ours ? `${place(e.province)} is yours!` : `${place(e.province)} falls to ${nameOf(s, e.realm, me)}`, tone: ours ? 'gold' : 'bad', ms: 2200 });
          boardFx({ kind: 'pop', province: e.province, icon: '⚑', tone: ours ? 'gold' : 'bad', big: true });
          if (ours) fanfareSound();
          else hornSound();
        });
        captures++;
      } else if (e.kind === 'built' && e.realm === me) {
        const at = TIMING.capture + 500 + builds * 350;
        builds++;
        later(bag, at, () => {
          if (e.what === 'fort') {
            boardFx({ kind: 'pop', province: e.province, icon: '🏰', text: `fort ${s.forts[e.province] ?? ''}`.trim(), tone: 'gold', big: true });
            stoneSound();
          } else if (e.what === 'town') {
            boardFx({ kind: 'pop', province: e.province, icon: '🏠', text: 'town', tone: 'gold', big: true });
            toast({ icon: '🏠', text: `A town rises in ${place(e.province)}`, tone: 'good' });
            stoneSound();
          } else boardFx({ kind: 'pop', province: e.province, icon: '⚔', text: `+${e.count ?? ''}`, tone: 'info' });
        });
      } else if (e.kind === 'grew' && e.realm === me) {
        later(bag, TIMING.capture + 900, () => {
          toast({ icon: '🏙', text: `${place(e.province)} is now a city!`, tone: 'gold' }, 4200);
          boardFx({ kind: 'pop', province: e.province, icon: '🏙', text: '✨', tone: 'gold', big: true });
          sparkleSound();
        });
      } else if (e.kind === 'rejected' && e.realm === me) {
        later(bag, 500, () => toast({ icon: '✗', text: `${describeOrder(before, e.order)}: refused`, detail: e.reason, tone: 'bad' }, 5000));
      } else if (e.kind === 'fallen') {
        later(bag, TIMING.capture + 1200, () => boardFx({ kind: 'banner', icon: '☠', text: `${nameOf(s, e.realm, me)} has fallen`, tone: e.realm === me ? 'bad' : 'gold', ms: 2600 }));
      }
    }
    const land = (st: GameState): number => st.owner.filter((o) => o === me).length;
    const receipts = v.receipts.filter((r) => r.season === before.season);
    const summary: SeasonSummaryData = {
      key,
      season: before.season,
      land: [land(before), land(s)],
      crowns: [before.realms[me]!.purse.crowns, s.realms[me]!.purse.crowns],
      won,
      lost,
      paid: receipts.filter((r) => r.passed).length,
      refunded: receipts.filter((r) => !r.passed).length,
      over: v.phase === 'over',
    };
    const quiet = !moved && battles === 0 && captures === 0;
    later(bag, quiet ? 700 : Math.max(TIMING.capture + TIMING.captureFor, TIMING.battle + battles * 1300 + 1200) + 500, () => done.current(summary));
    return () => {
      for (const c of bag) c();
      // (so a remount in development, or a quick return, can run it again while it's fresh)
      started.current.delete(key);
    };
    // the season's key decides; later views of the same season (an envoy's reply) don't restart it
  }, [replay?.key]);
}

const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

/** After each season: land, crowns, battles and receipts, and a button to plan the next. */
export function SeasonSummary({ d, onClose }: { d: SeasonSummaryData; onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const dl = d.land[1] - d.land[0];
  const dc = d.crowns[1] - d.crowns[0];
  return (
    <div className="season-card" role="dialog" aria-label="Season summary">
      <h3>{seasonTitle(d.season)} is done</h3>
      <ul>
        <li className={dl > 0 ? 'up' : dl < 0 ? 'down' : ''}>
          <span>🗺 Land</span> {d.land[0]} → {d.land[1]} <strong>({signed(dl)})</strong>
        </li>
        <li className={dc > 0 ? 'up' : dc < 0 ? 'down' : ''}>
          <span>🪙 Crowns</span> {d.crowns[0]} → {d.crowns[1]} <strong>({signed(dc)})</strong>
        </li>
        {d.won + d.lost > 0 && (
          <li>
            <span>⚔ Battles</span> won {d.won}, lost {d.lost}
          </li>
        )}
        {d.paid + d.refunded > 0 && (
          <li>
            <span>🧾 Receipts</span> {d.paid} paid, {d.refunded} refunded
          </li>
        )}
      </ul>
      <button type="button" className="primary" ref={ref} onClick={onClose}>
        Next season
      </button>
    </div>
  );
}

// ---------- the campaign ends ----------

const CONFETTI = ['#c9a227', '#f5d76e', '#b23a3a', '#2f5fa8', '#2e8b7a', '#efe3c8'];

/** The closing screen: victory with confetti and a fanfare, or a somber defeat; the scores, then the agendas revealed. */
export function CampaignEnd({ v, onClose }: { v: View; onClose: () => void }) {
  const won = v.winner === v.human;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (won) fanfareSound(0.1, true);
    else somberSound(0.1);
    closeRef.current?.focus({ preventScroll: true });
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const s = v.state;
  const scores = shownScores(v);
  const ranked = s.realms.map((r) => ({ r, score: scores[r.id] ?? 0 })).sort((a, b) => b.score - a.score || a.r.id - b.r.id);
  const [pieces] = useState(() =>
    won && !reducedMotion()
      ? Array.from({ length: 70 }, (_, i) => ({ left: Math.random() * 100, delay: Math.random() * 1.6, dur: 2.4 + Math.random() * 1.8, color: CONFETTI[i % CONFETTI.length]!, spin: Math.random() * 720 - 360 }))
      : [],
  );
  return (
    <div className={`end-screen ${won ? 'won' : 'lost'}`} role="dialog" aria-modal="true" aria-label={won ? 'Victory' : 'Defeat'}>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti"
          aria-hidden="true"
          style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s`, ['--spin' as string]: `${p.spin}deg` }}
        />
      ))}
      <div className="end-card">
        <p className="end-kicker">{won ? '♛ The campaign is won' : 'The campaign is over'}</p>
        <h2>{won ? 'Your realm wins' : `${s.realms[v.winner ?? 0]?.name ?? 'A rival'} wins the campaign`}</h2>
        <ol className="end-scores">
          {ranked.map(({ r, score }, i) => (
            <li key={r.id} className={r.id === v.human ? 'you' : ''}>
              <span className="rank">{i + 1}</span>
              <span className="chip" style={{ background: colorOf(r.id) }} aria-hidden="true" />
              <span className="end-name">{r.id === v.human ? `${r.name} (you)` : r.name}</span>
              <strong>{score}</strong>
            </li>
          ))}
        </ol>
        <h3>The secret agendas, revealed</h3>
        <ul className="end-agendas">
          {s.realms
            .filter((r) => r.agenda.text && r.agenda.text !== 'unknown')
            .map((r) => (
              <li key={r.id}>
                <strong style={{ color: colorOf(r.id) }}>{r.name}</strong>: {r.agenda.text}
              </li>
            ))}
        </ul>
        <button type="button" className="primary" ref={closeRef} onClick={onClose}>
          See the board
        </button>
      </div>
    </div>
  );
}
