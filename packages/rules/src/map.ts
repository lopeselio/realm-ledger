import { hexDisk, hexDistance, hexKey, hexNeighbors, hexToXY, type Hex } from './hex.ts';
import { provinceName } from './names.ts';
import { fbm } from './noise.ts';
import { rng } from './rng.ts';
import type { GameMap, Province, Terrain, Tile } from './types.ts';

export interface MapOptions {
  radius?: number;
  minProvinces?: number;
  maxProvinces?: number;
}

const SEA_LEVEL = 0.4;
const HILLS = 0.6;
const MOUNTAINS = 0.7;
const MAX_PASS_LENGTH = 3;

type Kind = Tile['kind'];
interface Cell extends Hex {
  kind: Kind;
  elevation: number;
  moisture: number;
  river: boolean;
}

const passable = (k: Kind): boolean => k !== 'sea' && k !== 'mountains';

/**
 * Generates a campaign map from a seed. Same seed and options, same map, everywhere.
 * Mountains are impassable except where a pass joins two lands; sea is impassable.
 * Every province is reachable from every other.
 */
export function generateMap(seed: string, opts: MapOptions = {}): GameMap {
  const radius = opts.radius ?? 8;
  const min = opts.minProvinces ?? 60;
  const max = opts.maxProvinces ?? 120;
  for (let attempt = 0; attempt < 64; attempt++) {
    const s = attempt === 0 ? seed : `${seed}#${attempt}`;
    const map = tryMap(seed, s, radius);
    if (map.provinces.length >= min && map.provinces.length <= max) return map;
  }
  throw new Error(`no map with ${min}-${max} provinces for seed ${seed} at radius ${radius}`);
}

function tryMap(seed: string, s: string, radius: number): GameMap {
  const r = rng(s, 'map');
  const cells = new Map<string, Cell>();
  for (const h of hexDisk(radius)) {
    const { x, y } = hexToXY(h);
    const d = hexDistance(h, { q: 0, r: 0 }) / radius;
    const elevation = 0.95 * fbm(`${s}:elev`, x, y, 4, 0.24) + 0.4 * (1 - d * d) - 0.22;
    const moisture = fbm(`${s}:moist`, x, y, 3, 0.25);
    let kind: Kind;
    if (elevation < SEA_LEVEL || d >= 1) kind = 'sea';
    else if (elevation > MOUNTAINS) kind = 'mountains';
    else if (elevation > HILLS) kind = 'hills';
    else kind = moisture > 0.55 ? 'forest' : 'plains';
    cells.set(hexKey(h), { ...h, kind, elevation, moisture, river: false });
  }
  const at = (h: Hex): Cell | undefined => cells.get(hexKey(h));
  const nbrs = (c: Cell): Cell[] => hexNeighbors(c).map(at).filter((n): n is Cell => n !== undefined);

  carveRivers(r, [...cells.values()], nbrs);
  joinLands([...cells.values()], nbrs);

  // number provinces in stable tile order
  const provinces: Province[] = [];
  const ids = new Map<string, number>();
  const names = new Set<string>();
  for (const c of cells.values()) {
    if (!passable(c.kind)) continue;
    const id = provinces.length;
    ids.set(hexKey(c), id);
    const terrain = c.kind as Terrain;
    const coast = nbrs(c).some((n) => n.kind === 'sea');
    provinces.push({
      id,
      name: provinceName(r, names),
      q: c.q,
      r: c.r,
      terrain,
      coast,
      river: c.river,
      yields: baseYields(terrain, coast, c.river, r.int(3) === 0),
      neighbors: [],
    });
  }
  for (const p of provinces) {
    p.neighbors = hexNeighbors(p)
      .map((h) => ids.get(hexKey(h)))
      .filter((id): id is number => id !== undefined)
      .sort((a, b) => a - b);
  }
  const tiles: Tile[] = [...cells.values()].map((c) => ({
    q: c.q,
    r: c.r,
    kind: c.kind,
    province: ids.get(hexKey(c)) ?? -1,
    elevation: Math.round(c.elevation * 1000) / 1000,
  }));
  return { seed, radius, tiles, provinces };
}

function baseYields(t: Terrain, coast: boolean, river: boolean, rich: boolean): Province['yields'] {
  const y = { grain: 0, timber: 0, iron: 0, gold: 0 };
  switch (t) {
    case 'plains':
      y.grain = 3;
      break;
    case 'forest':
      y.timber = 2;
      y.grain = 1;
      break;
    case 'hills':
      y.iron = 2;
      y.grain = 1;
      if (rich) y.gold = 1;
      break;
    case 'pass':
      y.iron = 1;
      y.gold = 1;
      break;
  }
  if (river) y.grain += 1;
  if (coast) y.gold += 1;
  return y;
}

/** A few rivers run downhill from high ground to the sea. */
function carveRivers(r: ReturnType<typeof rng>, cells: Cell[], nbrs: (c: Cell) => Cell[]): void {
  const sources = cells.filter((c) => c.kind === 'hills');
  const count = Math.min(sources.length, 3 + r.int(2));
  r.shuffle(sources);
  for (let i = 0; i < count; i++) {
    let c = sources[i]!;
    for (let step = 0; step < 30; step++) {
      if (c.kind === 'sea') break;
      if (passable(c.kind)) c.river = true;
      const lower = nbrs(c)
        .filter((n) => n.elevation < c.elevation)
        .sort((a, b) => a.elevation - b.elevation)[0];
      if (!lower) break;
      c = lower;
    }
  }
}

/**
 * Joins every land mass to the largest one through short mountain passes.
 * Land that can't be reached that way sinks into the sea.
 */
function joinLands(cells: Cell[], nbrs: (c: Cell) => Cell[]): void {
  const components = (): Cell[][] => {
    const seen = new Set<Cell>();
    const out: Cell[][] = [];
    for (const c of cells) {
      if (!passable(c.kind) || seen.has(c)) continue;
      const comp: Cell[] = [];
      const stack = [c];
      seen.add(c);
      while (stack.length) {
        const x = stack.pop()!;
        comp.push(x);
        for (const n of nbrs(x)) {
          if (passable(n.kind) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      out.push(comp);
    }
    // largest first; ties broken by first tile order
    return out.sort((a, b) => b.length - a.length);
  };

  for (let guard = 0; guard < 100; guard++) {
    const comps = components();
    if (comps.length <= 1) return;
    const main = new Set(comps[0]);
    // BFS from the main land through mountains only
    const prev = new Map<Cell, Cell | null>();
    let frontier: Cell[] = [...main];
    for (const c of frontier) prev.set(c, null);
    let found: { end: Cell; via: Cell } | null = null;
    for (let depth = 0; depth <= MAX_PASS_LENGTH && !found; depth++) {
      const next: Cell[] = [];
      for (const c of frontier) {
        for (const n of nbrs(c)) {
          if (prev.has(n)) continue;
          if (passable(n.kind) && !main.has(n) && depth > 0) {
            found = { end: n, via: c };
            break;
          }
          if (n.kind === 'mountains') {
            prev.set(n, c);
            next.push(n);
          }
        }
        if (found) break;
      }
      frontier = next;
    }
    if (found) {
      for (let c: Cell | null | undefined = found.via; c && !main.has(c); c = prev.get(c)) c.kind = 'pass';
    } else {
      // nothing reachable: sink every other land mass
      for (const comp of comps.slice(1)) for (const c of comp) c.kind = 'sea';
      return;
    }
  }
}
