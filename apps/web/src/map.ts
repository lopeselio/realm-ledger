import { CITY_AFTER, CITY_BONUS, NEUTRAL, SCORE, troopCount, type GameState } from '@realm-ledger/rules';

export const REALM_COLORS = ['#b23a3a', '#2f5fa8', '#c9a227', '#2e8b7a', '#7a4fa3', '#c96f2b', '#5c6b7a', '#b5577b'];

/** A realm's colour on the board; neutral militias are grey. */
export const colorOf = (realm: number): string => (realm === NEUTRAL ? '#8a8073' : REALM_COLORS[realm % REALM_COLORS.length]!);

const TERRAIN: Record<string, string> = {
  sea: '#1f3c46',
  mountains: '#5f5852',
  plains: '#8d9c5c',
  forest: '#4a6a3c',
  hills: '#a0814f',
  pass: '#857a6b',
};

const SIZE = 20;
const SQRT3 = Math.sqrt(3);
const center = (q: number, r: number): [number, number] => [SIZE * SQRT3 * (q + r / 2), SIZE * 1.5 * r];
const corners = (cx: number, cy: number, s = SIZE): string =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return `${(cx + s * Math.cos(a)).toFixed(1)},${(cy + s * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

/** Lightens a hex colour toward white (for winter frost). */
function frost(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number): number => Math.round(c + (255 - c) * amount);
  const r = mix(n >> 16), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface Overlay {
  /** the province the player has selected */
  selected?: number;
  /** provinces the selection can march to */
  targets?: Set<number>;
  /** planned marches, drawn as arrows */
  arrows?: [number, number][];
  /** provinces with planned builds */
  marks?: Set<number>;
}

/** Where a province sits on the flat map, in SVG units. */
export function provinceCenter(s: GameState, id: number): [number, number] {
  const p = s.map.provinces[id]!;
  return center(p.q, p.r);
}

/** Renders the board for one state as SVG markup. */
export function renderMap(svg: SVGSVGElement, s: GameState, overlay: Overlay = {}): void {
  const winter = s.season % 4 === 3 ? 0.35 : s.season % 4 === 2 ? 0.08 : 0;
  const pts = s.map.tiles.map((t) => center(t.q, t.r));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = SIZE * 1.2;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  svg.setAttribute('viewBox', `${minX.toFixed(0)} ${minY.toFixed(0)} ${(Math.max(...xs) - minX + pad).toFixed(0)} ${(Math.max(...ys) - minY + pad).toFixed(0)}`);

  const capitals = new Map(s.realms.filter((r) => r.alive).map((r) => [r.capital, r.id]));
  const parts: string[] = [];
  const shrineMarks: string[] = [];
  // terrain
  for (const t of s.map.tiles) {
    if (t.province >= 0) continue;
    const [x, y] = center(t.q, t.r);
    const fill = t.kind === 'sea' ? TERRAIN.sea! : frost(TERRAIN.mountains!, 0.15 + winter);
    parts.push(`<polygon points="${corners(x, y)}" fill="${fill}" stroke="${t.kind === 'sea' ? '#24434d' : '#4c4641'}" stroke-width="1"/>`);
    if (t.kind === 'mountains') parts.push(`<path d="M${x - 9},${y + 6} L${x - 2},${y - 7} L${x + 4},${y + 2} L${x + 7},${y - 3} L${x + 11},${y + 6}Z" fill="${frost('#3f3a36', winter)}" opacity="0.8"/>`);
  }
  // provinces
  for (const p of s.map.provinces) {
    const [x, y] = center(p.q, p.r);
    const owner = s.owner[p.id]!;
    const base = frost(TERRAIN[p.terrain]!, winter);
    const color = owner >= 0 ? colorOf(owner) : 'none';
    parts.push(`<g class="province" data-id="${p.id}">`);
    parts.push(`<polygon points="${corners(x, y)}" fill="${base}" stroke="#2b2118" stroke-opacity="0.35" stroke-width="1"/>`);
    if (owner >= 0) parts.push(`<polygon class="owner" points="${corners(x, y, SIZE - 2.5)}" fill="${color}" fill-opacity="0.38" stroke="${color}" stroke-width="2.2"/>`);
    if (p.river) parts.push(`<path d="M${x - 12},${y + 4} q6,-8 12,0 t12,0" fill="none" stroke="#4f8fa8" stroke-width="2.4" opacity="0.85"/>`);
    if (p.terrain === 'forest') parts.push(`<path d="M${x - 8},${y + 7} l3,-8 l3,8z M${x + 3},${y + 8} l3,-9 l3,9z" fill="#2c4424" opacity="0.7"/>`);
    if (s.towns[p.id]) parts.push(`<rect x="${x - 5}" y="${y - 13}" width="10" height="8" fill="#efe3c8" stroke="#2b2118" stroke-width="1"/><path d="M${x - 6},${y - 13} l6,-5 l6,5z" fill="#7a3b2c"/>`);
    // a city: a second, taller house to the left of the town's (clear of a capital's crown above it)
    if (s.cities?.[p.id]) parts.push(`<rect x="${x - 13}" y="${y - 15}" width="7" height="11" fill="#efe3c8" stroke="#2b2118" stroke-width="1"/><path d="M${x - 14},${y - 15} l4.5,-5 l4.5,5z" fill="#7a3b2c"/>`);
    if (s.forts[p.id]! > 0) parts.push(`<circle cx="${x}" cy="${y}" r="${12 + s.forts[p.id]!}" fill="none" stroke="#c9a227" stroke-width="${1 + s.forts[p.id]!}" stroke-dasharray="3 2" opacity="0.9"/>`);
    // a shrine: a brass star, added after the armies (below)
    if (s.shrines?.[p.id]) shrineMarks.push(`<text x="${x + 11}" y="${y - 3}" text-anchor="middle" font-size="12" fill="#f5d76e" stroke="#2b2118" stroke-width="0.6" pointer-events="none">✦</text>`);
    if (capitals.has(p.id)) parts.push(`<text x="${x}" y="${y - 14}" text-anchor="middle" font-size="12" fill="#f5d76e" stroke="#2b2118" stroke-width="0.6">♛</text>`);
    parts.push('</g>');
  }
  // selection and legal targets
  for (const id of overlay.targets ?? []) {
    const p = s.map.provinces[id]!;
    const [x, y] = center(p.q, p.r);
    parts.push(`<polygon points="${corners(x, y, SIZE - 4)}" fill="#f5d76e" fill-opacity="0.18" stroke="#f5d76e" stroke-width="1.5" stroke-dasharray="4 3" pointer-events="none"/>`);
  }
  if (overlay.selected !== undefined) {
    const p = s.map.provinces[overlay.selected]!;
    const [x, y] = center(p.q, p.r);
    parts.push(`<polygon points="${corners(x, y, SIZE - 1)}" fill="none" stroke="#fff4c2" stroke-width="3" pointer-events="none"/>`);
  }
  for (const id of overlay.marks ?? []) {
    const p = s.map.provinces[id]!;
    const [x, y] = center(p.q, p.r);
    parts.push(`<text x="${x + 11}" y="${y - 6}" font-size="11" text-anchor="middle" pointer-events="none">⚒</text>`);
  }
  // armies
  const byProvince = new Map<number, typeof s.armies>();
  for (const a of s.armies) byProvince.set(a.province, [...(byProvince.get(a.province) ?? []), a]);
  for (const [pid, armies] of byProvince) {
    const p = s.map.provinces[pid]!;
    const [x, y] = center(p.q, p.r);
    armies.forEach((a, i) => {
      const ox = (i - (armies.length - 1) / 2) * 13;
      const fill = colorOf(a.realm);
      const n = troopCount(a);
      parts.push(
        `<g pointer-events="none"><circle cx="${x + ox}" cy="${y + 5}" r="7.5" fill="${fill}" stroke="#efe3c8" stroke-width="1.4"/>` +
          `<text x="${x + ox}" y="${y + 8.3}" text-anchor="middle" font-size="${n > 99 ? 6.5 : 8.5}" font-family="Alegreya Sans, sans-serif" font-weight="700" fill="#fff">${n}</text></g>`,
      );
    });
  }
  // shrines: drawn over the armies, so a shrine being fought over still shows
  parts.push(...shrineMarks);
  // planned marches
  for (const [from, to] of overlay.arrows ?? []) {
    const a = s.map.provinces[from]!;
    const b = s.map.provinces[to]!;
    const [x1, y1] = center(a.q, a.r);
    const [x2, y2] = center(b.q, b.r);
    const mx = x1 + (x2 - x1) * 0.78;
    const my = y1 + (y2 - y1) * 0.78;
    parts.push(
      `<g pointer-events="none"><line x1="${x1}" y1="${y1 + 5}" x2="${mx}" y2="${my + 5}" stroke="#fff4c2" stroke-width="3" stroke-linecap="round"/>` +
        `<circle cx="${mx}" cy="${my + 5}" r="3.5" fill="#fff4c2"/></g>`,
    );
  }
  svg.innerHTML = parts.join('');
}

/** How far a held town is from growing (a harvest lost to fighting there doesn't count). */
const growsText = (left: number): string => `grows into a city after ${left} more harvest${left === 1 ? '' : 's'} held in peace`;

/**
 * Rules version 4 notes on a province, for places without a hover (the orders panel, the phone
 * dock): a city, how near a held town is to growing into one, a shrine and what it is worth.
 */
export function provinceNotes(s: GameState, id: number): string[] {
  const notes: string[] = [];
  if (s.cities?.[id]) notes.push(`a city (+${CITY_BONUS} crowns a harvest, +${SCORE.city} points)`);
  // (a capital is its realm's seat, and doesn't grow)
  else if (s.held && s.towns[id] && s.owner[id]! >= 0 && s.realms[s.owner[id]!]!.capital !== id) notes.push(`a town; ${growsText(Math.max(1, CITY_AFTER - s.held[id]!))}`);
  if (s.shrines?.[id]) notes.push(`a shrine: ${SCORE.shrine} points to whoever holds it at the end`);
  return notes;
}

/** Hover text for one province. */
export function provinceTip(s: GameState, id: number): string {
  const p = s.map.provinces[id]!;
  const owner = s.owner[id]!;
  const y = p.yields;
  const yields = (['grain', 'timber', 'iron', 'gold'] as const).filter((g) => y[g] > 0).map((g) => `${y[g]} ${g}`).join(', ');
  const armies = s.armies
    .filter((a) => a.province === id)
    .map((a) => `${a.realm === NEUTRAL ? 'militia' : esc(s.realms[a.realm]!.name)}: ${a.levies} levies, ${a.regulars} regulars${a.mercs ? `, ${a.mercs} mercs` : ''}`);
  return [
    `<strong>${esc(p.name)}</strong>`,
    `${p.terrain}${p.coast ? ', coast' : ''}${p.river ? ', river' : ''}${s.cities?.[id] ? '' : s.towns[id] ? ', town' : ''}${s.forts[id] ? `, fort ${s.forts[id]}` : ''}`,
    // a city, how near a held town is to growing, a shrine (the same notes as the selection's)
    ...provinceNotes(s, id),
    `yields ${yields || 'nothing'}`,
    owner >= 0 ? `held by ${esc(s.realms[owner]!.name)}` : 'unclaimed',
    ...armies,
  ].join('<br>');
}
