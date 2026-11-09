// One board, two ways to see it: the 3D war table (default where the browser can draw it)
// and the 2D hex map (always available, and the fallback). Both draw imperatively; React
// only owns the elements around them.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import type { GameState } from '@realm-ledger/rules';
import { provinceCenter, renderMap, type Overlay } from '../map.ts';
import type { Table3D } from '../table3d.ts';
import { FRESH_MS, isEmpty, playOnMap, playSounds, type SeasonScript } from '../playback.ts';
import { reducedMotion } from '../onboarding/storage.ts';
import { isMuted, onMutedChange, setMuted, unlockSound } from '../sound.ts';

export type BoardOverlay = Overlay & { visible?: Set<number>; focus?: number };
type Mode = '3d' | '2d';

const PREF = 'realm-ledger:board';

// checked here rather than imported from table3d.ts so three.js loads only when shown
function canRender3D(): boolean {
  try {
    return !!(navigator as Navigator & { gpu?: unknown }).gpu || !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

/**
 * A phone or small tablet held by thumb: a narrow screen, or a touch one up to tablet width.
 * style.css repeats this query for the phone layout; change both together.
 */
export const PHONE_QUERY = '(max-width: 640px), (pointer: coarse) and (max-width: 900px)';
export function isPhone(): boolean {
  try {
    return window.matchMedia(PHONE_QUERY).matches;
  } catch {
    return false;
  }
}

/** isPhone, kept up to date as the window turns or resizes. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(PHONE_QUERY);
    } catch {
      return;
    }
    const on = (): void => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
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
  /** a season that just settled (at `at`, ms since epoch), played over the board once per key */
  replay?: { key: string; at: number; script: SeasonScript } | null;
}

// seasons already played back on this page, so a board that remounts doesn't play one twice
const played = new Set<string>();

export function Board({ state, overlay, tipHtml, onPick, head, legend, replay }: BoardProps) {
  const [muted, setMutedState] = useState(isMuted);
  useEffect(() => onMutedChange(setMutedState), []);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [table, setTable] = useState<Table3D | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // ---- the flat map's pinch, pan and zoom buttons ----
  const [zoom, setZoom] = useState<View2D>({ k: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: View2D; dist: number; mid: { x: number; y: number }; at: { x: number; y: number } } | null>(null);
  // a drag that moved the map is not a tap on a province
  const dragged = useRef(false);
  /** Keeps the zoomed map covering the frame (no empty edge pulled into view). */
  const clamp = (z: View2D): View2D => {
    const svg = svgRef.current;
    const w = svg?.clientWidth ?? 0;
    const h = svg?.clientHeight ?? 0;
    const k = Math.min(MAX_ZOOM, Math.max(1, z.k));
    return { k, x: Math.min(0, Math.max(w - w * k, z.x)), y: Math.min(0, Math.max(h - h * k, z.y)) };
  };
  /** Zooms by `factor` about a point of the frame (CSS pixels from its top left). */
  const zoomAbout = (factor: number, px: number, py: number, from = zoomRef.current): void => {
    const k = Math.min(MAX_ZOOM, Math.max(1, from.k * factor));
    const f = k / from.k;
    setZoom(clamp({ k, x: px - (px - from.x) * f, y: py - (py - from.y) * f }));
  };
  const zoomCentre = (factor: number): void => {
    const svg = svgRef.current;
    if (svg) zoomAbout(factor, svg.clientWidth / 2, svg.clientHeight / 2);
  };
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = svgRef.current!.parentElement!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
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
    const mid = ps.length === 2 ? { x: (ps[0]!.x + ps[1]!.x) / 2, y: (ps[0]!.y + ps[1]!.y) / 2 } : ps[0]!;
    gesture.current = { start: zoomRef.current, dist: ps.length === 2 ? Math.hypot(ps[0]!.x - ps[1]!.x, ps[0]!.y - ps[1]!.y) : 0, mid, at: mid };
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
    } else if (ps.length === 1 && g.start.k > 1) {
      const dx = ps[0]!.x - g.at.x;
      const dy = ps[0]!.y - g.at.y;
      if (Math.hypot(dx, dy) > 6) dragged.current = true;
      if (dragged.current) setZoom(clamp({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }));
    }
  };
  const onPointerEnd = (e: PointerEvent): void => {
    pointers.current.delete(e.pointerId);
    const left = [...pointers.current.values()];
    // one finger lifted from a pinch: carry on panning from here with the other
    gesture.current = left.length ? { start: zoomRef.current, dist: 0, mid: left[0]!, at: left[0]! } : null;
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

  // free the GPU when the page goes away
  useEffect(() => (table ? () => table.dispose() : undefined), [table]);

  const mapKey = `${state.seed}:${state.map.provinces.length}`;
  // on a phone, open the flat map zoomed in on your own realm, once per map (done right after
  // the map draws, below, since its viewBox comes from the drawing)
  const focusedFor = useRef<string | null>(null);
  const focus = overlay?.focus;
  const focusOnRealm = (svg: SVGSVGElement): void => {
    if (focusedFor.current === mapKey) return;
    if (focus === undefined || !isPhone()) {
      focusedFor.current = mapKey;
      return setZoom({ k: 1, x: 0, y: 0 });
    }
    const vb = svg.viewBox.baseVal;
    const w = svg.clientWidth;
    const h = svg.clientHeight;
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
    const o = new ResizeObserver(() => setZoom((z) => (z.k > 1 ? clamp(z) : z)));
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
    if (reducedMotion()) return;
    if (three) table!.play(state, replay.script);
    else if (svgRef.current) {
      stopMap.current?.();
      stopMap.current = playOnMap(svgRef.current, state, replay.script);
    }
    // state and overlay are drawn by the effect above; this one only starts the playback
  }, [replay, mode, three, table]);
  // a playback ends with its view: switching view, opening another map, or leaving ends it
  useEffect(
    () => () => {
      stopMap.current?.();
      table?.stopPlayback();
    },
    [mode, mapKey, table],
  );

  const toggleMode = (): void => {
    const next: Mode = mode === '3d' ? '2d' : '3d';
    try {
      localStorage.setItem(PREF, next);
    } catch {
      // the choice just won't be remembered
    }
    setMode(next);
  };

  const provinceAt = (e: MouseEvent): number | null => {
    const g = (e.target as Element).closest('.province');
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
            display: three ? 'none' : 'block',
            transform: zoom.k > 1 ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.k})` : undefined,
            transformOrigin: '0 0',
            // the page scrolls by a finger until the map is zoomed; then a finger pans the map
            touchAction: zoom.k > 1 ? 'none' : 'pan-y',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
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
        <div ref={containerRef} className="table3d" hidden={mode !== '3d'} />
        <div ref={tipRef} className="tip" hidden />
      </div>
      {legend}
    </section>
  );
}
