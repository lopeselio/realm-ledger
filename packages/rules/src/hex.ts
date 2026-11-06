// Axial hex coordinates (pointy-top). See the "axial" section of any hex-grid reference.

export interface Hex {
  q: number;
  r: number;
}

export const HEX_DIRS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const hexKey = (h: Hex): string => `${h.q},${h.r}`;

export const hexAdd = (a: Hex, b: Hex): Hex => ({ q: a.q + b.q, r: a.r + b.r });

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export const hexNeighbors = (h: Hex): Hex[] => HEX_DIRS.map((d) => hexAdd(h, d));

/** All hexes within `radius` of the origin, in a stable order. */
export function hexDisk(radius: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) out.push({ q, r });
  }
  return out;
}

/** Cartesian centre of a hex of unit size (pointy-top). Used by noise and rendering. */
export function hexToXY(h: Hex): { x: number; y: number } {
  return { x: h.q + h.r / 2, y: h.r * 0.8660254037844386 };
}
