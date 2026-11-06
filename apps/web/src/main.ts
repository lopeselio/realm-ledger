import './style.css';
import {
  BASE_PRICE,
  GOODS,
  newCampaign,
  resolveSeason,
  runCampaign,
  scores,
  seasonName,
  stateHash,
  type GameState,
  type SeasonRecord,
} from '@realm-ledger/rules';
import { campaigns, CONTRACT } from './chain.ts';
import { chronicle } from './chronicle.ts';
import { provinceTip, REALM_COLORS, renderMap } from './map.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const svg = document.getElementById('map') as unknown as SVGSVGElement;
const tip = $<HTMLDivElement>('tip');
const scrub = $<HTMLInputElement>('scrub');
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let states: GameState[] = [];
let history: SeasonRecord[] = [];
let index = 0;
let timer: number | undefined;

function play(seed: string, realms: number): void {
  const result = runCampaign({ seed, realms });
  history = result.history;
  // rebuild every season's state by replaying the recorded orders: this is what the verifier does
  states = [newCampaign({ seed, realms, human: null })];
  for (const h of history) states.push(resolveSeason(states.at(-1)!, h.orders, { rollSeed: h.rollSeed }).state);
  const replayed = stateHash(states.at(-1)!);
  const original = stateHash(result.state);
  $('state-hash').textContent = original;
  const check = $('replay-check');
  check.className = `check ${replayed === original ? 'ok' : 'bad'}`;
  check.textContent =
    replayed === original
      ? `✓ Replayed ${history.length} seasons from the recorded orders: the same hash.`
      : '✗ Replay diverged. This is a bug; please report it.';
  scrub.max = String(states.length - 1);
  show(0);
}

function show(i: number): void {
  index = Math.max(0, Math.min(states.length - 1, i));
  scrub.value = String(index);
  const s = states[index]!;
  renderMap(svg, s);
  const year = Math.floor(s.season / 4) + 1;
  const name = seasonName(s.season);
  $('season-title').textContent = s.winner !== null ? `The campaign is over` : `${name[0]!.toUpperCase()}${name.slice(1)}, year ${year}`;
  renderRealms(s);
  renderChronicle();
  renderMarket(s);
}

function renderRealms(s: GameState): void {
  const sc = scores(s);
  const land = (id: number): number => s.owner.filter((o) => o === id).length;
  const troops = (id: number): number => s.armies.filter((a) => a.realm === id).reduce((n, a) => n + a.levies + a.regulars + a.mercs, 0);
  const order = [...s.realms].sort((a, b) => sc[b.id]! - sc[a.id]!);
  $('realm-list').innerHTML = order
    .map((r) => {
      const p = r.personality;
      return `<li class="${r.alive ? '' : 'fallen'}">
        <span class="dot" style="background:${REALM_COLORS[r.id]}"></span>
        <span class="name">${esc(r.name)}${s.winner === r.id ? ' ♛' : ''}</span>
        <span class="score">${sc[r.id]}</span>
        <span class="meta">${land(r.id)} provinces · ${troops(r.id)} troops · ${r.purse.crowns} crowns<br>
        greed ${p.greed} · caution ${p.caution} · honour ${p.honour} · ambition ${p.ambition}<br>
        <span class="agenda">secret agenda: ${esc(r.agenda.text)}</span></span>
      </li>`;
    })
    .join('');
}

function renderChronicle(): void {
  const el = $('chronicle');
  if (index === 0) {
    el.innerHTML = `<li class="quiet">The realms take the field. Scrub forward or press ▶ to watch the seasons turn.</li>`;
    return;
  }
  const lines = chronicle(states[index - 1]!, history[index - 1]!.events);
  el.innerHTML = lines.length
    ? lines.slice(0, 60).map((l) => `<li class="${l.tone}">${esc(l.text)}</li>`).join('')
    : `<li class="quiet">A quiet season.</li>`;
}

function renderMarket(s: GameState): void {
  const prev = states[Math.max(0, index - 1)]!;
  const rows = GOODS.map((g) => {
    const p = s.market.price[g];
    const d = p - prev.market.price[g];
    const why = s.market.reasons[g]
      .filter((r) => r.stockDelta !== 0)
      .map((r) => r.text)
      .slice(0, 2)
      .join('; ');
    return `<tr><th>${g}</th><td class="num">${p}</td><td class="num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '+' : ''}${d || ''}</td><td class="num">base ${BASE_PRICE[g]}</td></tr>
      ${index > 0 && why ? `<tr><td colspan="4" class="why">${esc(why)}</td></tr>` : ''}`;
  });
  $('market').innerHTML = `<tbody>${rows.join('')}</tbody>`;
}

async function renderChain(): Promise<void> {
  const el = $('chain');
  try {
    const list = await campaigns();
    if (list.length === 0) {
      el.textContent = 'No campaigns on chain yet.';
      return;
    }
    const c = list[0]!;
    const short = (a: string): string => esc(a.replace(`.${CONTRACT}`, ''));
    el.innerHTML = `<p>${list.length} campaigns recorded. The latest:</p>
      <dl>
        <dt>campaign</dt><dd>#${c.id}, seed <code>${esc(c.map_seed)}</code></dd>
        <dt>phase</dt><dd>${esc(c.phase)}, ${c.season}/${c.max_seasons} seasons settled${c.winner !== null ? `, won by realm ${c.winner}` : ''}</dd>
        <dt>rulers</dt><dd>${c.realms.map((r, i) => `${i}: ${short(r.ruler)} (${r.treasury} crowns)`).join('<br>')}</dd>
        <dt>roll commit</dt><dd class="mono">${esc(c.roll_commit)}</dd>
        <dt>state hashes</dt><dd class="mono">${c.state_hashes.map(esc).join('<br>') || 'none yet'}</dd>
      </dl>
      <p>Rulers are agent accounts whose only key is a function-call key for this contract, so they can seal, reveal, sign treaties and hire, but can't move NEAR.</p>`;
  } catch (err) {
    el.textContent = `Could not read the contract right now (${(err as Error).message}).`;
  }
}

// ---- wiring ----
$<HTMLFormElement>('controls').addEventListener('submit', (e) => {
  e.preventDefault();
  stop();
  const seed = $<HTMLInputElement>('seed').value.trim() || 'ember-pass';
  const realms = Number($<HTMLSelectElement>('realms').value);
  const url = new URL(location.href);
  url.searchParams.set('seed', seed);
  url.searchParams.set('realms', String(realms));
  history_replace(url);
  play(seed, realms);
});
function history_replace(url: URL): void {
  window.history.replaceState(null, '', url);
}
scrub.addEventListener('input', () => {
  stop();
  show(Number(scrub.value));
});
$('prev').addEventListener('click', () => {
  stop();
  show(index - 1);
});
$('next').addEventListener('click', () => {
  stop();
  show(index + 1);
});
$('play').addEventListener('click', () => (timer ? stop() : start()));
function start(): void {
  if (index >= states.length - 1) show(0);
  $('play').textContent = '❚❚';
  timer = window.setInterval(() => {
    if (index >= states.length - 1) stop();
    else show(index + 1);
  }, 900);
}
function stop(): void {
  if (timer) window.clearInterval(timer);
  timer = undefined;
  $('play').textContent = '▶';
}

svg.addEventListener('mousemove', (e) => {
  const g = (e.target as Element).closest('.province');
  if (!g) {
    tip.hidden = true;
    return;
  }
  const wrap = svg.parentElement!.getBoundingClientRect();
  tip.innerHTML = provinceTip(states[index]!, Number(g.getAttribute('data-id')));
  tip.hidden = false;
  const x = e.clientX - wrap.left + 14;
  tip.style.left = `${Math.min(x, wrap.width - 250)}px`;
  tip.style.top = `${e.clientY - wrap.top + 14}px`;
});
svg.addEventListener('mouseleave', () => (tip.hidden = true));

const params = new URLSearchParams(location.search);
const seed = params.get('seed') ?? 'ember-pass';
const realms = Math.min(6, Math.max(3, Number(params.get('realms') ?? 5) || 5));
$<HTMLInputElement>('seed').value = seed;
$<HTMLSelectElement>('realms').value = String(realms);
play(seed, realms);
void renderChain();
