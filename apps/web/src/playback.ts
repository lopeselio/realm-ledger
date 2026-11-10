// A settled season, played out on the board: armies march, battles flash, the beaten fall back
// or fall, and captured provinces raise their new colours. The board already shows the season's
// end; this is a short replay over it, timed the same on the 3D table and the flat map, with sound.
import type { GameEvent, GameState } from '@realm-ledger/rules';
import { colorOf, provinceCenter } from './map.ts';
import { captureSound, clashSound, marchSound } from './sound.ts';

export interface SeasonScript {
  moves: { realm: number; from: number; to: number }[];
  battles: number[];
  /** beaten armies falling back after the battles */
  retreats: { realm: number; from: number; to: number }[];
  /** armies destroyed, where they fell */
  losses: { realm: number; province: number }[];
  captures: { realm: number; province: number }[];
}

/** When each part starts and how long it runs, in milliseconds. */
export const TIMING = {
  march: 0,
  marchFor: 900,
  battle: 900,
  battleFor: 700,
  retreat: 1500,
  retreatFor: 700,
  loss: 1500,
  lossFor: 900,
  capture: 1800,
  captureFor: 2200,
} as const;

/** How long after a season settles its playback may still start (a 3D table that loads later skips it). */
export const FRESH_MS = 4000;

/**
 * The season's events as a playback. They come from the server already as your realm saw them
 * (where a rival came from out of the fog is -1: it appears where it arrives). Elements wait
 * hidden until their moment (fill 'forwards', not 'both').
 */
export function scriptFor(events: GameEvent[]): SeasonScript {
  const sc: SeasonScript = { moves: [], battles: [], retreats: [], losses: [], captures: [] };
  const battles = new Set<number>();
  for (const e of events) {
    if (e.kind === 'moved') sc.moves.push({ realm: e.realm, from: e.from < 0 ? e.to : e.from, to: e.to });
    // a border clash (two armies swapping provinces) flashes at the province it was named for
    else if (e.kind === 'battle') battles.add(e.province);
    else if (e.kind === 'retreated') sc.retreats.push({ realm: e.realm, from: e.from < 0 ? e.to : e.from, to: e.to });
    else if (e.kind === 'destroyed') sc.losses.push({ realm: e.realm, province: e.province });
    else if (e.kind === 'captured') sc.captures.push({ realm: e.realm, province: e.province });
  }
  sc.battles = [...battles];
  return sc;
}

export const isEmpty = (sc: SeasonScript): boolean => !sc.moves.length && !sc.battles.length && !sc.retreats.length && !sc.losses.length && !sc.captures.length;

/** The season's sounds, on the same clock as the pictures. */
export function playSounds(sc: SeasonScript): void {
  if (sc.moves.length) marchSound(TIMING.march / 1000);
  if (sc.battles.length) clashSound(TIMING.battle / 1000);
  if (sc.captures.length) captureSound(TIMING.capture / 1000);
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Plays the season over the flat map, in a layer of its own laid over the map, so redrawing the
 * map (a click, an order) doesn't cut it short. Returns a function that stops it.
 */
export function playOnMap(svg: SVGSVGElement, s: GameState, sc: SeasonScript): () => void {
  const layer = document.createElementNS(SVG, 'svg');
  layer.setAttribute('viewBox', svg.getAttribute('viewBox') ?? '');
  layer.setAttribute('class', 'playback');
  layer.setAttribute('aria-hidden', 'true');
  // laid exactly over the map, inside the same positioned wrapper, and kept there each frame while
  // it plays (a reflow, or the map panned or pinched: a transform no observer reports)
  const wrap = svg.parentElement!;
  const place = (): void => {
    const box = svg.getBoundingClientRect();
    const parent = wrap.getBoundingClientRect();
    Object.assign(layer.style, { left: `${box.left - parent.left - wrap.clientLeft}px`, top: `${box.top - parent.top - wrap.clientTop}px`, width: `${box.width}px`, height: `${box.height}px` });
  };
  place();
  // sizes come from an observer; each frame only compares the map's transform string (no layout
  // read), and re-measures when it changed (a pan or pinch)
  const sizes = new ResizeObserver(place);
  sizes.observe(svg);
  sizes.observe(wrap);
  let last = svg.style.transform;
  let frame = requestAnimationFrame(function track() {
    if (svg.style.transform !== last) {
      last = svg.style.transform;
      place();
    }
    frame = requestAnimationFrame(track);
  });
  svg.after(layer);
  const add = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, String(val));
    if (text) el.textContent = text;
    layer.appendChild(el);
    return el;
  };
  const travel = (realm: number, from: number, to: number, delay: number, duration: number): void => {
    const [x1, y1] = provinceCenter(s, from);
    const [x2, y2] = provinceCenter(s, to);
    add('circle', { cx: 0, cy: 0, r: 6, fill: colorOf(realm), stroke: '#efe3c8', 'stroke-width': 1.4, opacity: 0 }).animate(
      [
        { transform: `translate(${x1}px, ${y1 + 5}px)`, opacity: 0.95 },
        { transform: `translate(${(x1 + x2) / 2}px, ${(y1 + y2) / 2 - 6}px)`, opacity: 0.95, offset: 0.5 },
        { transform: `translate(${x2}px, ${y2 + 5}px)`, opacity: 0 },
      ],
      { duration, delay, easing: 'ease-in-out', fill: 'forwards' },
    );
  };
  for (const m of sc.moves) travel(m.realm, m.from, m.to, TIMING.march, TIMING.marchFor);
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
      { duration: TIMING.battleFor, delay: TIMING.battle, easing: 'ease-out', fill: 'forwards' },
    );
    add('text', { x, y: y + 6, 'text-anchor': 'middle', 'font-size': 18, opacity: 0 }, '⚔').animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], {
      duration: TIMING.battleFor + 300,
      delay: TIMING.battle,
      fill: 'forwards',
    });
  }
  for (const r of sc.retreats) travel(r.realm, r.from, r.to, TIMING.retreat, TIMING.retreatFor);
  for (const l of sc.losses) {
    const [x, y] = provinceCenter(s, l.province);
    add('circle', { cx: x, cy: y + 5, r: 7, fill: colorOf(l.realm), stroke: '#2b2118', 'stroke-width': 1.2, opacity: 0 }).animate(
      [
        { opacity: 0.95, transform: 'translateY(0)' },
        { opacity: 0, transform: 'translateY(6px)' },
      ],
      { duration: TIMING.lossFor, delay: TIMING.loss, easing: 'ease-in', fill: 'forwards' },
    );
  }
  for (const c of sc.captures) {
    const [x, y] = provinceCenter(s, c.province);
    add('text', { x: x + 8, y: y - 4, 'text-anchor': 'middle', 'font-size': 16, fill: colorOf(c.realm), stroke: '#2b2118', 'stroke-width': 0.6, opacity: 0 }, '⚑').animate(
      [
        { transform: 'translateY(8px)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1, offset: 0.25 },
        { transform: 'translateY(0)', opacity: 1, offset: 0.8 },
        { transform: 'translateY(0)', opacity: 0 },
      ],
      { duration: TIMING.captureFor, delay: TIMING.capture, easing: 'ease-out', fill: 'forwards' },
    );
  }
  const stop = (): void => {
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    sizes.disconnect();
    layer.remove();
  };
  const timer = window.setTimeout(stop, TIMING.capture + TIMING.captureFor + 100);
  return stop;
}
