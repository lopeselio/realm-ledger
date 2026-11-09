// A settled season, played out on the board: armies march, battles flash, captured provinces
// raise their new colours. The board already shows the season's end; this is a short replay
// over it, timed the same on the 3D table and the flat map, with sound.
import { NEUTRAL, type GameEvent, type GameState } from '@realm-ledger/rules';
import { REALM_COLORS, provinceCenter } from './map.ts';
import { captureSound, clashSound, marchSound } from './sound.ts';

export interface SeasonScript {
  moves: { realm: number; from: number; to: number }[];
  battles: number[];
  captures: { realm: number; province: number }[];
}

/** When each part starts and how long it runs, in milliseconds. */
export const TIMING = { march: 0, marchFor: 900, battle: 900, battleFor: 700, capture: 1500, captureFor: 2200 } as const;

export const colorOf = (realm: number): string => (realm === NEUTRAL ? '#8a8073' : REALM_COLORS[realm % REALM_COLORS.length]!);

export function scriptFor(events: GameEvent[]): SeasonScript {
  const moves: SeasonScript['moves'] = [];
  const battles = new Set<number>();
  const captures: SeasonScript['captures'] = [];
  for (const e of events) {
    if (e.kind === 'moved') moves.push({ realm: e.realm, from: e.from, to: e.to });
    // a border clash (two armies swapping provinces) flashes at the province it was named for
    else if (e.kind === 'battle') battles.add(e.province);
    else if (e.kind === 'captured') captures.push({ realm: e.realm, province: e.province });
  }
  return { moves, battles: [...battles], captures };
}

export const isEmpty = (sc: SeasonScript): boolean => !sc.moves.length && !sc.battles.length && !sc.captures.length;

export function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The season's sounds, on the same clock as the pictures. */
export function playSounds(sc: SeasonScript): void {
  if (sc.moves.length) marchSound(TIMING.march / 1000);
  if (sc.battles.length) clashSound(TIMING.battle / 1000);
  if (sc.captures.length) captureSound(TIMING.capture / 1000);
}

const SVG = 'http://www.w3.org/2000/svg';

/** Plays the season over the flat map; the map's next redraw clears it. */
export function playOnMap(svg: SVGSVGElement, s: GameState, sc: SeasonScript): void {
  const layer = document.createElementNS(SVG, 'g');
  layer.setAttribute('pointer-events', 'none');
  layer.setAttribute('class', 'playback');
  svg.appendChild(layer);
  const add = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, String(val));
    layer.appendChild(el);
    return el;
  };
  for (const m of sc.moves) {
    const [x1, y1] = provinceCenter(s, m.from);
    const [x2, y2] = provinceCenter(s, m.to);
    const dot = add('circle', { cx: 0, cy: 0, r: 6, fill: colorOf(m.realm), stroke: '#efe3c8', 'stroke-width': 1.4, opacity: 0 });
    dot.animate(
      [
        { transform: `translate(${x1}px, ${y1 + 5}px)`, opacity: 0.95 },
        { transform: `translate(${(x1 + x2) / 2}px, ${(y1 + y2) / 2 - 6}px)`, opacity: 0.95, offset: 0.5 },
        { transform: `translate(${x2}px, ${y2 + 5}px)`, opacity: 0 },
      ],
      { duration: TIMING.marchFor, delay: TIMING.march, easing: 'ease-in-out', fill: 'both' },
    );
  }
  for (const p of sc.battles) {
    const [x, y] = provinceCenter(s, p);
    const ring = add('circle', { cx: x, cy: y, r: 16, fill: 'none', stroke: '#f5d76e', 'stroke-width': 3, opacity: 0 });
    ring.style.transformBox = 'fill-box';
    ring.style.transformOrigin = 'center';
    ring.animate(
      [
        { transform: 'scale(0.3)', opacity: 1 },
        { transform: 'scale(1.6)', opacity: 0 },
      ],
      { duration: TIMING.battleFor, delay: TIMING.battle, easing: 'ease-out', fill: 'both' },
    );
    const spark = add('text', { x, y: y + 6, 'text-anchor': 'middle', 'font-size': 18, opacity: 0 });
    spark.textContent = '⚔';
    spark.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: TIMING.battleFor + 300, delay: TIMING.battle, fill: 'both' });
  }
  for (const c of sc.captures) {
    const [x, y] = provinceCenter(s, c.province);
    const flag = add('text', { x: x + 8, y: y - 4, 'text-anchor': 'middle', 'font-size': 16, fill: colorOf(c.realm), stroke: '#2b2118', 'stroke-width': 0.6, opacity: 0 });
    flag.textContent = '⚑';
    flag.animate(
      [
        { transform: 'translateY(8px)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1, offset: 0.25 },
        { transform: 'translateY(0)', opacity: 1, offset: 0.8 },
        { transform: 'translateY(0)', opacity: 0 },
      ],
      { duration: TIMING.captureFor, delay: TIMING.capture, easing: 'ease-out', fill: 'both' },
    );
  }
  window.setTimeout(() => layer.remove(), TIMING.capture + TIMING.captureFor + 100);
}
