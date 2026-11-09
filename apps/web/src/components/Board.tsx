// One board, two ways to see it: the 3D war table (default where the browser can draw it)
// and the 2D hex map (always available, and the fallback). Both draw imperatively; React
// only owns the elements around them.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { GameState } from '@realm-ledger/rules';
import { renderMap, type Overlay } from '../map.ts';
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

function initialMode(): Mode {
  try {
    const saved = localStorage.getItem(PREF);
    if (saved === '3d' || saved === '2d') return saved;
  } catch {
    // no storage: fall through to the default
  }
  return canRender3D() ? '3d' : '2d';
}

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

  const three = mode === '3d' && !!table;
  useEffect(() => {
    if (three) table!.setState(state, overlay);
    else if (svgRef.current) renderMap(svgRef.current, state, overlay);
  }, [three, table, state, overlay]);

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
  // the flat map's playback goes with it: switching to the 3D table or leaving ends it
  useEffect(() => () => stopMap.current?.(), [mode]);

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
  const toggle = (
    <span className="board-tools">
      {sound}
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
        <svg
          id="map"
          ref={svgRef}
          role="img"
          aria-label="Hex map"
          style={{ display: three ? 'none' : 'block' }}
          onClick={(e) => {
            const p = provinceAt(e);
            if (p !== null) onPick?.(p);
          }}
          onMouseMove={(e) => {
            const r = wrapRef.current!.getBoundingClientRect();
            showTip(provinceAt(e), e.clientX - r.left, e.clientY - r.top);
          }}
          onMouseLeave={() => showTip(null, 0, 0)}
        />
        <div ref={containerRef} className="table3d" hidden={mode !== '3d'} />
        <div ref={tipRef} className="tip" hidden />
      </div>
      {legend}
    </section>
  );
}
