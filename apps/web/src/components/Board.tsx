// One board, two ways to see it: the 3D war table (default where the browser can draw it)
// and the 2D hex map (always available, and the fallback). Both draw imperatively; React
// only owns the elements around them.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { GameState } from '@realm-ledger/rules';
import { provinceCenter, renderMap, type Overlay } from '../map.ts';
import { isPhone } from '../media.ts';
import type { Table3D } from '../table3d.ts';
import { FRESH_MS, isEmpty, playOnMap, playSounds, TIMING, type SeasonScript } from '../playback.ts';
import { reducedMotion } from '../onboarding/storage.ts';
import { isMuted, onMutedChange, setMuted, unlockSound } from '../sound.ts';
import { onBoardFx, type BoardFx } from '../juice.ts';

export type BoardOverlay = Overlay & { visible?: Set<number>; focus?: number };
type Mode = '3d' | '2d';

const PREF = 'realm-ledger:board';
/** Set once the player has turned or zoomed the 3D table (or closed its hint). */
const HINTED = 'realm-ledger:table-hinted';
/** How long the 3D table may take to load before the flat map shows meanwhile. */
const SLOW_MS = 6000;
/** How long a season's playback runs, for its caption. */
const PLAYBACK_MS = TIMING.capture + TIMING.captureFor;

function tableHinted(): boolean {
  try {
    return localStorage.getItem(HINTED) === '1';
  } catch {
    return false;
  }
}

// checked here rather than imported from table3d.ts so three.js loads only when shown
function canRender3D(): boolean {
  try {
    return !!(navigator as Navigator & { gpu?: unknown }).gpu || !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}


/** A touch screen, where the 3D table zooms by pinching. */
function coarse(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function initialMode(): Mode {
  try {
    const saved = localStorage.getItem(PREF);
    if (saved === '3d' || saved === '2d') return saved;
  } catch {
    // no storage: fall through to the default
  }
  // the flat map by default on a phone: lighter, and its hexes take a thumb once zoomed
  return canRender3D() && !isPhone() ? '3d' : '2d';
}

/** The flat map's zoom and pan: scale about the top left, then shift (in CSS pixels). */
type View2D = { k: number; x: number; y: number };
const MAX_ZOOM = 4;

export interface BoardProps {
  state: GameState;
  /** memoize it: a new overlay redraws the board */
  overlay?: BoardOverlay | undefined;
  /** the hover text for a province, as HTML */
  tipHtml: (province: number) => string;
  onPick?: (province: number) => void;
  /** the board's heading row; place `toggle` (the 3D / flat switch) where it belongs */
  head: (toggle: ReactNode) => ReactNode;
  legend: ReactNode;
  /** a season that just settled (at `at`, ms since epoch), played over the board once per key,
   *  with a caption over the table while it plays ("Season 3 plays out…") */
  replay?: { key: string; at: number; script: SeasonScript; caption?: string } | null;
}

// seasons already played back on this page, so a board that remounts doesn't play one twice
const played = new Set<string>();

export function Board({ state, overlay, tipHtml, onPick, head, legend, replay }: BoardProps) {
  const [muted, setMutedState] = useState(isMuted);
  useEffect(() => onMutedChange(setMutedState), []);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [table, setTable] = useState<Table3D | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // the 3D table is taking its time: show the flat map meanwhile
  const [slow, setSlow] = useState(false);
  // the "drag to turn" hint, shown over the 3D table until the player has used it once
  const [hint, setHint] = useState(() => !tableHinted());
  // the caption over the table while a season plays out
  const [caption, setCaption] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // ---- the flat map's pinch, pan and zoom buttons ----
  const [zoom, setZoomState] = useState<View2D>({ k: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  // the ref follows every update at once, not only renders, so a gesture starting between a move
  // and its render starts from where the map really is
  const setZoom = (next: View2D | ((z: View2D) => View2D)): void => {
    const z = typeof next === 'function' ? next(zoomRef.current) : next;
    zoomRef.current = z;
    setZoomState(z);
  };
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: View2D; dist: number; mid: { x: number; y: number }; at: { x: number; y: number } } | null>(null);
  // a drag that moved the map is not a tap on a province
  const dragged = useRef(false);
  /** The map's frame (its clipping wrapper), unscaled. Measured there: an outer svg's clientWidth may read 0. */
  const frame = (): { w: number; h: number } => {
    const r = svgRef.current?.parentElement?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  };
  /** Keeps the zoomed map covering the frame (no empty edge pulled into view). */
  const clamp = (z: View2D): View2D => {
    const { w, h } = frame();
    const k = Math.min(MAX_ZOOM, Math.max(1, z.k));
    return { k, x: Math.min(0, Math.max(w - w * k, z.x)), y: Math.min(0, Math.max(h - h * k, z.y)) };
  };
  /** Zooms by `factor` about a point of the frame (CSS pixels from its top left). */
  const zoomAbout = (factor: number, px: number, py: number): void =>
    // from the latest zoom, so two quick taps make two steps
    setZoom((from) => {
      const k = Math.min(MAX_ZOOM, Math.max(1, from.k * factor));
      const f = k / from.k;
      return clamp({ k, x: px - (px - from.x) * f, y: py - (py - from.y) * f });
    });
  const zoomCentre = (factor: number): void => {
    const { w, h } = frame();
    zoomAbout(factor, w / 2, h / 2);
  };
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = svgRef.current!.parentElement!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  /** A gesture from where these fingers are now: two or more pinch (the first two count), one pans. */
  const startGesture = (ps: { x: number; y: number }[]) => {
    const two = ps.length >= 2;
    const mid = two ? { x: (ps[0]!.x + ps[1]!.x) / 2, y: (ps[0]!.y + ps[1]!.y) / 2 } : ps[0]!;
    return { start: zoomRef.current, dist: two ? Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) : 0, mid, at: mid };
  };
  const onPointerDown = (e: PointerEvent): void => {
    dragged.current = false;
    if (e.pointerType === 'mouse' && zoomRef.current.k === 1) return;
    // keep the gesture's pointer even if it leaves the map before it lifts
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // not capturable: the pointerup/cancel handlers still end it
    }
    pointers.current.set(e.pointerId, local(e));
    const ps = [...pointers.current.values()];
    gesture.current = startGesture(ps);
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    // a mouse with no button down is hovering, not dragging
    if (e.pointerType === 'mouse' && e.buttons === 0) return onPointerEnd(e);
    pointers.current.set(e.pointerId, local(e));
    const ps = [...pointers.current.values()];
    const g = gesture.current;
    if (ps.length >= 2 && g.dist > 0) {
      const mid = { x: (ps[0]!.x + ps[1]!.x) / 2, y: (ps[0]!.y + ps[1]!.y) / 2 };
      const factor = Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) / g.dist;
      const k = Math.min(MAX_ZOOM, Math.max(1, g.start.k * factor));
      const f = k / g.start.k;
      // pinch about the fingers' midpoint, and follow it as it moves
      setZoom(clamp({ k, x: mid.x - (g.mid.x - g.start.x) * f, y: mid.y - (g.mid.y - g.start.y) * f }));
      dragged.current = true;
    } else if (ps.length === 1) {
      const dx = ps[0]!.x - g.at.x;
      const dy = ps[0]!.y - g.at.y;
      // a finger that moved is a swipe, not a tap, zoomed or not
      if (Math.hypot(dx, dy) > 6) dragged.current = true;
      if (dragged.current && g.start.k > 1) setZoom(clamp({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }));
    }
  };
  const onPointerEnd = (e: PointerEvent): void => {
    pointers.current.delete(e.pointerId);
    const left = [...pointers.current.values()];
    // a finger lifted: carry on with the ones still down (a pan with one, a pinch with two or more)
    gesture.current = left.length ? startGesture(left) : null;
  };

  // the 3D table calls back long after it is created: always reach the latest handlers
  const handlers = useRef({ tipHtml, onPick });
  useLayoutEffect(() => {
    handlers.current = { tipHtml, onPick };
  });

  const showTip = (province: number | null, x: number, y: number): void => {
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap) return;
    if (province === null) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = handlers.current.tipHtml(province);
    tip.hidden = false;
    tip.style.left = `${Math.min(x + 14, wrap.getBoundingClientRect().width - 250)}px`;
    tip.style.top = `${y + 14}px`;
  };

  // load the 3D table the first time it is shown; flipping back to flat meanwhile doesn't
  // cancel it, so it loads once
  const mounted = useRef(true);
  const loading = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (mode !== '3d' || table || unavailable || loading.current) return;
    loading.current = true;
    import('../table3d.ts')
      .then(({ createTable3D }) => createTable3D(containerRef.current!))
      .then((t) => {
        loading.current = false;
        if (!mounted.current) return t.dispose();
        t.onPick((p) => handlers.current.onPick?.(p));
        t.onHover(showTip);
        setTable(t);
      })
      .catch((e: unknown) => {
        loading.current = false;
        if (!mounted.current) return;
        console.warn('3D table unavailable, using the 2D map:', e);
        setUnavailable(true);
        setMode('2d');
      });
    // showTip reads only refs, so it need not be a dependency
  }, [mode, table, unavailable]);

  // until the 3D table is ready it shows a placeholder, not a flash of the flat map; if it is slow
  // to load, the flat map shows meanwhile
  useEffect(() => {
    if (mode !== '3d' || table || unavailable || slow) return;
    const t = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => window.clearTimeout(t);
  }, [mode, table, unavailable, slow]);

  // free the GPU when the page goes away
  useEffect(() => (table ? () => table.dispose() : undefined), [table]);

  const mapKey = `${state.seed}:${state.map.provinces.length}`;
  // on a phone, open the flat map zoomed in on your own realm, once per map (done right after
  // the map draws, below, since its viewBox comes from the drawing)
  const focusedFor = useRef<string | null>(null);
  // a new map starts unzoomed, whatever the screen
  const shownMap = useRef<string | null>(null);
  const focus = overlay?.focus;
  const focusOnRealm = (svg: SVGSVGElement): void => {
    if (shownMap.current !== mapKey) {
      shownMap.current = mapKey;
      if (focusedFor.current !== mapKey) setZoom({ k: 1, x: 0, y: 0 });
    }
    // tried again on each draw until it lands, so a window narrowed to phone width later still gets it
    if (focusedFor.current === mapKey || focus === undefined || !isPhone()) return;
    const vb = svg.viewBox.baseVal;
    const { w, h } = frame();
    if (!vb.width || !w || !h) return; // not laid out yet: the next draw tries again
    focusedFor.current = mapKey;
    // the drawing is fitted inside the box (preserveAspectRatio meet), centred in the spare room
    const fit = Math.min(w / vb.width, h / vb.height);
    const [cx, cy] = provinceCenter(state, focus);
    const px = (w - vb.width * fit) / 2 + (cx - vb.x) * fit;
    const py = (h - vb.height * fit) / 2 + (cy - vb.y) * fit;
    const k = 2.4;
    setZoom(clamp({ k, x: w / 2 - px * k, y: h / 2 - py * k }));
  };

  const three = mode === '3d' && !!table;
  const setting = mode === '3d' && !table && !unavailable && !slow;
  useEffect(() => {
    if (three) table!.setState(state, overlay);
    else if (svgRef.current) {
      renderMap(svgRef.current, state, overlay);
      focusOnRealm(svgRef.current);
    }
    // focusOnRealm reads the same state and overlay
  }, [three, table, state, overlay]);

  // a turned or resized phone: keep the zoomed map covering its frame
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // (not while hidden for the 3D table: a 0×0 frame would pin the view to its corner)
    const o = new ResizeObserver(() => setZoom((z) => (z.k > 1 && frame().h > 0 && frame().w > 0 ? clamp(z) : z)));
    o.observe(svg);
    return () => o.disconnect();
  }, []);

  // play a settled season once, after the board shows how it ended. Only while it is fresh: a 3D
  // table that finishes loading seconds later doesn't start it out of the blue

  const stopMap = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!replay || played.has(replay.key) || isEmpty(replay.script)) return;
    if (mode === '3d' && !table) return;
    played.add(replay.key);
    if (Date.now() - replay.at > FRESH_MS) return;
    playSounds(replay.script);
    // bring the table into view for the season, with a caption over it while it plays
    const wrap = wrapRef.current;
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      const seen = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      if (seen < Math.min(r.height, window.innerHeight) * 0.6) wrap.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    if (replay.caption) setCaption(replay.caption);
    if (reducedMotion()) return;
    if (three) table!.play(state, replay.script);
    else if (svgRef.current) {
      stopMap.current?.();
      stopMap.current = playOnMap(svgRef.current, state, replay.script);
    }
    // state and overlay are drawn by the effect above; this one only starts the playback
  }, [replay, mode, three, table]);
  // the caption goes once the season has played out
  useEffect(() => {
    if (!caption) return;
    const t = window.setTimeout(() => setCaption(null), PLAYBACK_MS + 600);
    return () => window.clearTimeout(t);
  }, [caption]);
  // a playback ends with its view: switching view, opening another map, or leaving ends it
  useEffect(
    () => () => {
      stopMap.current?.();
      table?.stopPlayback();
    },
    [mode, mapKey, table],
  );

  // ---- effects over the board (juice.ts): pops, an envoy's ride, banners, flashes ----
  const fxRef = useRef<HTMLDivElement>(null);
  const fxNow = useRef({ state, table: three ? table : null });
  fxNow.current = { state, table: three ? table : null };
  useEffect(() => {
    /** Where a province sits on screen now, in pixels from the board's top left. */
    const spot = (province: number): { x: number; y: number } | null => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const wr = wrap.getBoundingClientRect();
      const { state: s, table: t } = fxNow.current;
      if (t) {
        const p = t.project(province);
        const cr = containerRef.current?.getBoundingClientRect();
        return p && cr ? { x: cr.left - wr.left + p.x, y: cr.top - wr.top + p.y } : null;
      }
      const svg = svgRef.current;
      const m = svg?.getScreenCTM();
      if (!svg || !m || !s.map.provinces[province]) return null;
      const [cx, cy] = provinceCenter(s, province);
      const pt = new DOMPoint(cx, cy).matrixTransform(m);
      return { x: pt.x - wr.left, y: pt.y - wr.top };
    };
    const inView = (p: { x: number; y: number } | null): p is { x: number; y: number } => {
      const layer = fxRef.current;
      return !!p && !!layer && p.x >= 0 && p.y >= 0 && p.x <= layer.clientWidth && p.y <= layer.clientHeight;
    };
    const el = (cls: string, html: string): HTMLDivElement => {
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = html;
      fxRef.current!.appendChild(d);
      return d;
    };
    const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const gone = (d: HTMLElement, ms: number): void => void window.setTimeout(() => d.remove(), ms);
    const run = (e: BoardFx): void => {
      const layer = fxRef.current;
      if (!layer) return;
      const still = reducedMotion();
      if (e.kind === 'pop') {
        const p = spot(e.province);
        if (!inView(p)) return;
        const d = el(`fx-pop tone-${e.tone ?? 'info'}${e.big ? ' big' : ''}`, `<span class="fx-icon">${esc(e.icon)}</span>${e.text ? `<span class="fx-text">${esc(e.text)}</span>` : ''}`);
        d.style.left = `${p.x}px`;
        d.style.top = `${p.y}px`;
        gone(d, 2000);
      } else if (e.kind === 'fly') {
        const a = spot(e.from);
        const b = spot(e.to);
        if (still || !inView(a) || !b) return;
        const d = el('fx-fly', esc(e.icon));
        const lift = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.35);
        d.animate(
          [
            { transform: `translate(${a.x}px, ${a.y}px) translate(-50%, -50%) scale(0.6)`, opacity: 0 },
            { transform: `translate(${a.x}px, ${a.y}px) translate(-50%, -50%) scale(1)`, opacity: 1, offset: 0.1 },
            { transform: `translate(${(a.x + b.x) / 2}px, ${(a.y + b.y) / 2 - lift}px) translate(-50%, -50%) scale(1.15)`, opacity: 1, offset: 0.55 },
            { transform: `translate(${b.x}px, ${b.y}px) translate(-50%, -50%) scale(0.8)`, opacity: 1, offset: 0.92 },
            { transform: `translate(${b.x}px, ${b.y}px) translate(-50%, -50%) scale(0.5)`, opacity: 0 },
          ],
          { duration: e.ms, easing: 'ease-in-out', fill: 'forwards' },
        );
        gone(d, e.ms + 50);
      } else if (e.kind === 'banner') {
        let stack = layer.querySelector<HTMLDivElement>('.fx-banners');
        if (!stack) stack = el('fx-banners', '');
        const d = document.createElement('div');
        d.className = `fx-banner tone-${e.tone}`;
        d.setAttribute('role', 'status');
        d.innerHTML = `<span class="fx-icon">${esc(e.icon)}</span> ${esc(e.text)}`;
        d.style.setProperty('--hold', `${e.ms}ms`);
        stack.appendChild(d);
        gone(d, e.ms + 400);
      } else if (e.kind === 'flash') {
        if (still) return;
        const d = el(`fx-flash ${e.tone}`, '');
        gone(d, 700);
        const wrap = wrapRef.current;
        if (e.shake && wrap) {
          wrap.classList.remove('fx-shake');
          void wrap.offsetWidth; // restart the animation
          wrap.classList.add('fx-shake');
          window.setTimeout(() => wrap.classList.remove('fx-shake'), 520);
        }
      }
    };
    return onBoardFx(run);
  }, []);

  const closeHint = (): void => {
    setHint(false);
    try {
      localStorage.setItem(HINTED, '1');
    } catch {
      // it shows again next visit
    }
  };

  const toggleMode = (): void => {
    const next: Mode = mode === '3d' ? '2d' : '3d';
    try {
      localStorage.setItem(PREF, next);
    } catch {
      // the choice just won't be remembered
    }
    setMode(next);
  };

  // the province under the pointer, found by position: while a gesture holds pointer capture the
  // click's target is the svg itself, not the province under the finger
  const provinceAt = (e: MouseEvent): number | null => {
    const under = document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element);
    const g = under.closest('.province') ?? (e.target as Element).closest('.province');
    return g ? Number(g.getAttribute('data-id')) : null;
  };

  const sound = (
    <button
      type="button"
      className="view-toggle"
      aria-pressed={!muted}
      title={muted ? 'Sound is off: press to turn it on' : 'Sound is on: press to turn it off'}
      // (the board's own click handler wakes the sound)
      onClick={() => setMuted(!muted)}
    >
      <span aria-hidden="true">{muted ? '🔇' : '🔊'}</span> Sound
    </button>
  );
  // the sound switch only where seasons play back (not on Watch)
  const toggle = (
    <span className="board-tools">
      {replay !== undefined && sound}
      {!unavailable && (
        <button type="button" className="view-toggle" aria-pressed={mode === '3d'} onClick={toggleMode}>
          {mode === '3d' ? 'Flat map' : '3D table'}
        </button>
      )}
    </span>
  );

  return (
    // browsers allow sound only after a click or tap (a touch counts once it ends, so not pointerdown)
    <section className="board" aria-label="War table" onClick={unlockSound}>
      <div className="board-head">{head(toggle)}</div>
      <div className="map-wrap" ref={wrapRef} data-tour="map">
        <div className="map-clip">
        <svg
          id="map"
          ref={svgRef}
          role="img"
          aria-label="Hex map"
          style={{
            display: three || setting ? 'none' : 'block',
            transform: zoom.k > 1 ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})` : undefined,
            transformOrigin: '0 0',
            // the map takes every touch: a page scroll that began on it would cancel a pinch before
            // the second finger lands (the page scrolls from anywhere else)
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onClick={(e) => {
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            const p = provinceAt(e);
            if (p !== null) onPick?.(p);
          }}
          onMouseMove={(e) => {
            const r = wrapRef.current!.getBoundingClientRect();
            showTip(provinceAt(e), e.clientX - r.left, e.clientY - r.top);
          }}
          onMouseLeave={() => showTip(null, 0, 0)}
        />
        </div>
        {!three && (
          <div className="zoom-tools" aria-label="Map zoom">
            <button type="button" aria-label="Zoom in" onClick={() => zoomCentre(1.5)} disabled={zoom.k >= MAX_ZOOM}>
              +
            </button>
            <button type="button" aria-label="Zoom out" onClick={() => zoomCentre(1 / 1.5)} disabled={zoom.k <= 1}>
              −
            </button>
            {zoom.k > 1 && (
              <button type="button" aria-label="Show the whole map" onClick={() => setZoom({ k: 1, x: 0, y: 0 })}>
                ⤢
              </button>
            )}
          </div>
        )}
        {setting && (
          <div className="table-setting" role="status">
            Setting out the war table…
          </div>
        )}
        <div
          ref={containerRef}
          className="table3d"
          hidden={mode !== '3d'}
          // the first turn or zoom retires the hint
          onPointerDown={() => hint && closeHint()}
          onWheel={() => hint && closeHint()}
        />
        {three && hint && (
          <div className="table-hint">
            <span>{coarse() ? 'Drag to turn · pinch to zoom' : 'Drag to turn · scroll to zoom'}</span>
            <button type="button" aria-label="Hide this hint" onClick={closeHint}>
              ✕
            </button>
          </div>
        )}
        {caption && (
          <p className="table-caption" aria-live="polite">
            {caption}
          </p>
        )}
        <div ref={fxRef} className="fx-layer" aria-live="polite" />
        <div ref={tipRef} className="tip" hidden />
      </div>
      {legend}
    </section>
  );
}
