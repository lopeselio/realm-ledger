import './style.css';
import {
  COST,
  GOODS,
  newSalt,
  sealOrders,
  seasonName,
  type GameEvent,
  type GameState,
  type Good,
  type Order,
  type OrderSet,
  type Treaty,
} from '@realm-ledger/rules';
import { chronicle } from './chronicle.ts';
import { provinceTip, REALM_COLORS, renderMap } from './map.ts';

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'https://realm-ledger-api.azurewebsites.net';

interface Envoy {
  season: number;
  to: number;
  message: string;
  proposal?: { kind: Treaty['kind']; amount?: number };
  accepted?: boolean;
  reply: string;
  signed?: number;
  verified?: boolean;
}
interface View {
  id: number;
  contract: string;
  phase: 'planning' | 'sealed' | 'over';
  season: number;
  human: number;
  state: GameState;
  lastEvents: GameEvent[];
  envoys: Envoy[];
  envoysLeft: number;
  attested: { model: string; nonce: string } | null;
  winner: number | null;
  scores: number[];
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const svg = document.getElementById('map') as unknown as SVGSVGElement;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let view: View | null = null;
let before: GameState | null = null;
let orders: Order[] = [];
let selected: number | undefined;
let busy = false;

// ---------- api ----------

async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(`${API}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function status(text: string, tone: 'info' | 'error' = 'info'): void {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${tone}`;
}

async function withBusy(label: string, fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  status(label);
  document.body.classList.add('busy');
  try {
    await fn();
  } catch (e) {
    status((e as Error).message, 'error');
  } finally {
    busy = false;
    document.body.classList.remove('busy');
    refreshControls();
  }
}

// ---------- local secrets: orders and salt stay in this browser until reveal ----------

const secretKey = (id: number, season: number): string => `realm-ledger:${id}:${season}`;
function keepSecret(id: number, set: OrderSet, salt: string): void {
  try {
    localStorage.setItem(secretKey(id, set.season), JSON.stringify({ orders: set, salt }));
  } catch {
    // private mode: the reveal still works in this tab
  }
}
function readSecret(id: number, season: number): { orders: OrderSet; salt: string } | null {
  try {
    const v = localStorage.getItem(secretKey(id, season));
    return v ? (JSON.parse(v) as { orders: OrderSet; salt: string }) : null;
  } catch {
    return null;
  }
}
let memorySecret: { orders: OrderSet; salt: string } | null = null;

// ---------- game flow ----------

async function load(id: number): Promise<void> {
  view = await api<View>(`/campaigns/${id}`);
  orders = [];
  selected = undefined;
  render();
  status(view.phase === 'over' ? 'This campaign is over. Everything is revealed.' : `Campaign ${view.id}: plan your orders, then seal them.`);
  // a sealed season whose reveal was interrupted: finish it
  if (view.phase === 'sealed') {
    busy = false;
    await reveal();
  }
}

async function newCampaign(): Promise<void> {
  await withBusy('Creating the campaign onchain and fetching the model attestation…', async () => {
    const v = await api<View>('/campaigns', { realms: Number($<HTMLSelectElement>('realms').value), seasons: Number($<HTMLSelectElement>('seasons').value) });
    history.replaceState(null, '', `?c=${v.id}`);
    view = v;
    before = null;
    orders = [];
    selected = undefined;
    render();
    status(`Campaign ${v.id} is onchain. Plan your first season.`);
  });
}

async function seal(): Promise<void> {
  if (!view) return;
  const v = view;
  await withBusy('Sealing: posting your hash and every AI ruler’s onchain…', async () => {
    const set: OrderSet = { realm: v.human, season: v.season, orders };
    const salt = newSalt();
    const hash = sealOrders(set, salt);
    keepSecret(v.id, set, salt);
    memorySecret = { orders: set, salt };
    try {
      view = await api<View>(`/campaigns/${v.id}/seal`, { seal: hash });
    } catch (e) {
      // the connection may drop after the server acted; check before giving up
      const now = await api<View>(`/campaigns/${v.id}`);
      if (now.phase !== 'sealed') throw e;
      view = now;
    }
    status(`Sealed ${hash.slice(0, 16)}… Revealing…`);
  });
  await reveal();
}

async function reveal(): Promise<void> {
  if (!view || view.phase !== 'sealed') return;
  const v = view;
  const secret = readSecret(v.id, v.season) ?? memorySecret;
  if (!secret) {
    status('Your sealed orders are not stored in this browser, so they cannot be revealed here. The season will pass without them.', 'error');
    return;
  }
  await withBusy('Revealing every ruler’s orders; the contract checks each against its seal…', async () => {
    before = v.state;
    let r: { events: GameEvent[]; view: View };
    try {
      r = await api<{ events: GameEvent[]; view: View }>(`/campaigns/${v.id}/reveal`, secret);
    } catch (e) {
      const now = await api<View>(`/campaigns/${v.id}`);
      if (now.season === v.season) throw e;
      r = { events: now.lastEvents, view: now };
    }
    view = r.view;
    orders = [];
    selected = undefined;
    memorySecret = null;
    render();
    status(view.phase === 'over' ? 'The campaign is over. Everything is revealed.' : `The season turned. ${view.envoysLeft} envoys available.`);
  });
}

async function sendEnvoy(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  if (!view) return;
  const v = view;
  const kind = $<HTMLSelectElement>('envoy-treaty').value as Treaty['kind'] | '';
  const body = {
    to: Number($<HTMLSelectElement>('envoy-to').value),
    message: $<HTMLTextAreaElement>('envoy-msg').value,
    ...(kind ? { proposal: { kind, ...(kind === 'tribute' ? { amount: Number($<HTMLInputElement>('envoy-amount').value) } : {}) } } : {}),
  };
  await withBusy('Your envoy rides out…', async () => {
    const r = await api<{ envoy: Envoy; view: View }>(`/campaigns/${v.id}/envoy`, body);
    view = r.view;
    $<HTMLTextAreaElement>('envoy-msg').value = '';
    render();
    status(r.envoy.accepted === undefined ? 'The envoy returns.' : r.envoy.accepted ? 'Treaty signed onchain by both rulers.' : 'Refused.');
  });
}

// ---------- orders ----------

const mine = (p: number): boolean => !!view && view.state.owner[p] === view.human;
const armyAt = (p: number) => view?.state.armies.find((a) => a.realm === view!.human && a.province === p);
const marchedFrom = (p: number): boolean => orders.some((o) => o.kind === 'march' && o.from === p);

function clickProvince(p: number): void {
  if (!view || view.phase !== 'planning' || busy) return;
  const s = view.state;
  if (selected !== undefined && armyAt(selected) && s.map.provinces[selected]!.neighbors.includes(p)) {
    orders = orders.filter((o) => !(o.kind === 'march' && o.from === selected));
    orders.push({ kind: 'march', from: selected, to: p });
    selected = undefined;
  } else {
    selected = selected === p ? undefined : p;
  }
  render();
}

function addOrder(o: Order): void {
  orders.push(o);
  render();
}

function selectionPanel(): string {
  if (!view || selected === undefined) return '<p class="fine">Select a province on the map.</p>';
  const s = view.state;
  const p = s.map.provinces[selected]!;
  const army = armyAt(selected);
  const buttons: string[] = [];
  if (mine(selected)) {
    if (s.forts[selected]! < 3) buttons.push(`<button data-act="fortify">Fortify (${COST.fortify.crowns}c ${COST.fortify.timber}t ${COST.fortify.iron}i)</button>`);
    buttons.push(`<button data-act="levy">Raise ${COST.levyTroops} levies (${COST.levy.crowns}c ${COST.levy.grain}g)</button>`);
    if (s.towns[selected]) buttons.push(`<button data-act="recruit">Recruit 2 regulars (${2 * COST.regular.crowns}c 2i)</button>`);
    else if (p.terrain !== 'pass') buttons.push(`<button data-act="build">Build a town (${COST.town.crowns}c ${COST.town.timber}t)</button>`);
  }
  const what = army ? `Your army: ${army.levies} levies, ${army.regulars} regulars. Click a highlighted province to march.` : mine(selected) ? 'Your province.' : '';
  return `<p><strong>${esc(p.name)}</strong> ${what}</p><div class="actions">${buttons.join('')}</div>`;
}

function describe(o: Order): string {
  const s = view!.state;
  const name = (id: number): string => s.map.provinces[id]!.name;
  switch (o.kind) {
    case 'march':
      return `March ${name(o.from)} → ${name(o.to)}`;
    case 'fortify':
      return `Fortify ${name(o.province)}`;
    case 'levy':
      return `Raise levies in ${name(o.province)}`;
    case 'recruit':
      return `Recruit ${o.count} regulars in ${name(o.province)}`;
    case 'build':
      return `Build a town in ${name(o.province)}`;
    case 'trade':
      return `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty} ${o.good} at ~${o.side === 'buy' ? s.market.price[o.good] : Math.floor(s.market.price[o.good] * 0.8)}`;
  }
}

// ---------- rendering ----------

function render(): void {
  const v = view;
  $('start').hidden = !!v && v.phase !== 'over';
  if (!v) {
    svg.innerHTML = '';
    return;
  }
  const s = v.state;
  const year = Math.floor(s.season / 4) + 1;
  $('season-title').textContent =
    v.phase === 'over'
      ? v.winner === v.human
        ? 'Victory: your realm wins'
        : `${s.realms[v.winner ?? 0]!.name} wins the campaign`
      : `${seasonName(s.season)[0]!.toUpperCase()}${seasonName(s.season).slice(1)}, year ${year} · campaign #${v.id}`;

  const targets = selected !== undefined && armyAt(selected) && !marchedFrom(selected) ? new Set(s.map.provinces[selected]!.neighbors) : new Set<number>();
  renderMap(svg, s, {
    selected,
    targets,
    arrows: orders.flatMap((o) => (o.kind === 'march' ? [[o.from, o.to] as [number, number]] : [])),
    marks: new Set(orders.flatMap((o) => ('province' in o ? [o.province] : []))),
  });

  $('selection').innerHTML = v.phase === 'planning' ? selectionPanel() : '';
  $('orders').innerHTML = orders.length
    ? orders.map((o, i) => `<li>${esc(describe(o))} <button class="x" data-remove="${i}" aria-label="Remove">✕</button></li>`).join('')
    : `<li class="fine">${v.phase === 'planning' ? 'No orders yet. Sealing with none is allowed.' : 'Waiting…'}</li>`;
  const me = s.realms[v.human]!;
  $('purse').textContent = `Treasury: ${me.purse.crowns} crowns · ${GOODS.map((g) => `${me.purse[g]} ${g}`).join(' · ')}`;

  // envoys
  const rivals = s.realms.filter((r) => r.id !== v.human && r.alive);
  const to = $<HTMLSelectElement>('envoy-to');
  const prev = to.value;
  to.innerHTML = rivals.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  if (rivals.some((r) => String(r.id) === prev)) to.value = prev;
  $('envoys').innerHTML = [...v.envoys]
    .reverse()
    .map(
      (e) => `<li><span class="who" style="color:${REALM_COLORS[e.to]}">${esc(s.realms[e.to]!.name)}</span>
        ${e.proposal ? `<span class="tag ${e.accepted ? 'yes' : 'no'}">${e.proposal.kind} ${e.accepted ? 'signed' : 'refused'}</span>` : ''}
        ${e.verified ? '<span class="tag tee" title="Reply signed inside a TEE; checked against the attested key">TEE-signed ✓</span>' : ''}
        <p class="said">“${esc(e.message)}”</p><p class="reply">${esc(e.reply)}</p></li>`,
    )
    .join('');

  // chronicle
  // names never change, so the current state can label last season's events after a reload
  const lines = chronicle(before ?? s, v.lastEvents);
  $('chronicle').innerHTML = lines.length
    ? lines.slice(0, 40).map((l) => `<li class="${l.tone}">${esc(l.text)}</li>`).join('')
    : `<li class="quiet">${s.season === 0 ? 'Your realm awaits orders.' : 'A quiet season.'}</li>`;

  // realms
  const land = (id: number): number => s.owner.filter((o) => o === id).length;
  $('realm-list').innerHTML = s.realms
    .map((r) => {
      const secret = v.phase === 'over' || r.id === v.human;
      const treaties = s.treaties.filter((t) => t.realms.includes(r.id) && t.realms.includes(v.human)).map((t) => t.kind);
      return `<li class="${r.alive ? '' : 'fallen'}"><span class="dot" style="background:${REALM_COLORS[r.id]}"></span>
        <span class="name">${esc(r.name)}${r.id === v.human ? ' (you)' : ''}</span><span class="score">${v.scores[r.id] ?? ''}</span>
        <span class="meta">${land(r.id)} provinces${treaties.length && r.id !== v.human ? ` · with you: ${treaties.join(', ')}` : ''}${
          secret && r.agenda.text !== 'unknown' ? `<br><span class="agenda">secret agenda: ${esc(r.agenda.text)}</span>` : ''
        }</span></li>`;
    })
    .join('');

  // proof
  $('proof').innerHTML = `<dl>
      <dt>contract</dt><dd><a href="https://testnet.nearblocks.io/address/${esc(v.contract)}" target="_blank" rel="noopener">${esc(v.contract)}</a>, campaign #${v.id}</dd>
      <dt>AI diplomacy</dt><dd>${v.attested ? `${esc(v.attested.model)} in a TEE; attestation fetched with nonce <code>${esc(v.attested.nonce.slice(0, 12))}…</code>` : 'model unavailable'}</dd>
      <dt>proof bundle</dt><dd><a href="${API}/api/campaigns/${v.id}/proof" target="_blank" rel="noopener">download</a></dd>
      <dt>check it</dt><dd><code>pnpm verify:campaign ${API}/api/campaigns/${v.id}/proof</code></dd>
    </dl>${v.phase === 'over' ? '<p>The battle-roll secret and every ruler’s agenda are now revealed and checked onchain against their commitments.</p>' : '<p>The battle-roll secret and the rulers’ agendas are revealed when the campaign ends.</p>'}`;
  refreshControls();
}

function refreshControls(): void {
  const planning = !!view && view.phase === 'planning' && !busy;
  $<HTMLButtonElement>('seal').disabled = !planning;
  $<HTMLButtonElement>('trade-add').disabled = !planning;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#envoy button')) b.disabled = !planning || (view?.envoysLeft ?? 0) === 0;
  $<HTMLButtonElement>('new').disabled = busy;
}

// ---------- wiring ----------

$('new').addEventListener('click', () => void newCampaign());
$('seal').addEventListener('click', () => void seal());
$<HTMLFormElement>('envoy').addEventListener('submit', (e) => void sendEnvoy(e));
$('envoy-treaty').addEventListener('change', () => {
  $('envoy-amount').hidden = $<HTMLSelectElement>('envoy-treaty').value !== 'tribute';
});
$('trade-add').addEventListener('click', () => {
  const qty = Math.floor(Number($<HTMLInputElement>('trade-qty').value));
  if (qty > 0) addOrder({ kind: 'trade', good: $<HTMLSelectElement>('trade-good').value as Good, side: $<HTMLSelectElement>('trade-side').value as 'buy' | 'sell', qty });
});
$('orders').addEventListener('click', (e) => {
  const i = (e.target as HTMLElement).getAttribute('data-remove');
  if (i !== null) {
    orders.splice(Number(i), 1);
    render();
  }
});
$('selection').addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).getAttribute('data-act');
  if (!act || selected === undefined) return;
  if (act === 'recruit') addOrder({ kind: 'recruit', province: selected, count: 2 });
  else addOrder({ kind: act as 'fortify' | 'levy' | 'build', province: selected });
});
svg.addEventListener('click', (e) => {
  const g = (e.target as Element).closest('.province');
  if (g) clickProvince(Number(g.getAttribute('data-id')));
});
const tip = $<HTMLDivElement>('tip');
svg.addEventListener('mousemove', (e) => {
  const g = (e.target as Element).closest('.province');
  if (!g || !view) {
    tip.hidden = true;
    return;
  }
  const wrap = svg.parentElement!.getBoundingClientRect();
  tip.innerHTML = provinceTip(view.state, Number(g.getAttribute('data-id')));
  tip.hidden = false;
  tip.style.left = `${Math.min(e.clientX - wrap.left + 14, wrap.width - 250)}px`;
  tip.style.top = `${e.clientY - wrap.top + 14}px`;
});
svg.addEventListener('mouseleave', () => (tip.hidden = true));

const id = Number(new URLSearchParams(location.search).get('c'));
if (Number.isInteger(id) && id >= 0 && new URLSearchParams(location.search).has('c')) {
  void withBusy('Loading campaign…', () => load(id));
} else {
  status('Choose how many rivals and how long, then start. Each campaign is created onchain.');
  render();
}
