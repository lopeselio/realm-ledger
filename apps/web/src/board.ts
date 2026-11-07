// One board, two ways to see it: the 3D war table (default where the browser can draw it)
// and the 2D hex map (always available, and the fallback).
import type { GameState } from '@realm-ledger/rules';
import { renderMap, type Overlay } from './map.ts';
import type { Table3D } from './table3d.ts';

// the 3D table (three.js) loads only when it is shown
const canRender3D = (): boolean => {
  try {
    return !!(navigator as Navigator & { gpu?: unknown }).gpu || !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
};

type Mode = '3d' | '2d';
export type BoardOverlay = Overlay & { visible?: Set<number>; focus?: number };

export interface BoardOptions {
  svg: SVGSVGElement;
  container: HTMLElement;
  toggle: HTMLButtonElement;
  tip: HTMLDivElement;
  tipHtml: (province: number) => string;
  onPick?: (province: number) => void;
}

const PREF = 'realm-ledger:board';

export function createBoard(o: BoardOptions): { render(s: GameState, overlay?: BoardOverlay): void } {
  let mode: Mode = '2d';
  try {
    mode = (localStorage.getItem(PREF) as Mode | null) ?? (canRender3D() ? '3d' : '2d');
  } catch {
    mode = canRender3D() ? '3d' : '2d';
  }
  let table: Table3D | null = null;
  let loading: Promise<void> | null = null;
  let last: [GameState, BoardOverlay | undefined] | null = null;

  const showTip = (province: number | null, x: number, y: number): void => {
    if (province === null) {
      o.tip.hidden = true;
      return;
    }
    o.tip.innerHTML = o.tipHtml(province);
    o.tip.hidden = false;
    const w = o.container.getBoundingClientRect().width;
    o.tip.style.left = `${Math.min(x + 14, w - 250)}px`;
    o.tip.style.top = `${y + 14}px`;
  };

  async function ensureTable(): Promise<void> {
    if (table || loading) return loading ?? undefined;
    loading = import('./table3d.ts')
      .then(({ createTable3D }) => createTable3D(o.container))
      .then((t) => {
        table = t;
        t.onPick((p) => o.onPick?.(p));
        t.onHover(showTip);
      })
      .catch((e: unknown) => {
        console.warn('3D table unavailable, using the 2D map:', e);
        mode = '2d';
        o.toggle.hidden = true;
      })
      .finally(() => {
        loading = null;
        apply();
      });
    return loading;
  }

  function apply(): void {
    const three = mode === '3d' && !!table;
    o.svg.style.display = three ? 'none' : 'block';
    o.container.hidden = mode !== '3d';
    o.toggle.textContent = mode === '3d' ? 'Flat map' : '3D table';
    o.toggle.setAttribute('aria-pressed', String(mode === '3d'));
    if (!last) return;
    if (three) table!.setState(last[0], last[1]);
    else renderMap(o.svg, last[0], last[1]);
  }

  o.toggle.addEventListener('click', () => {
    mode = mode === '3d' ? '2d' : '3d';
    try {
      localStorage.setItem(PREF, mode);
    } catch {
      // the choice just won't be remembered
    }
    if (mode === '3d') void ensureTable();
    apply();
  });
  if (mode === '3d') void ensureTable();

  return {
    render(s, overlay) {
      last = [s, overlay];
      apply();
    },
  };
}
