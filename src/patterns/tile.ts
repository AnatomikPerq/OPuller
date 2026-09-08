/**
 * Pattern tiling geometry (pure): the size of one repeating cell for a tile
 * layout and the positions of the tile copies inside that cell.
 */
import type { PatternDef, PatternLayout, Vec } from '@/model/types';

export interface PatternCell {
  width: number;
  height: number;
  /** tile origins inside the cell (wrap-around copies included) */
  tiles: Vec[];
}

export const LAYOUTS: Array<{ id: PatternLayout; label: string }> = [
  { id: 'grid', label: 'Grid' },
  { id: 'brick-row', label: 'Brick by Row' },
  { id: 'brick-col', label: 'Brick by Column' },
  { id: 'hex-row', label: 'Hex by Row' },
  { id: 'hex-col', label: 'Hex by Column' },
];

/** Pitch of the tiles = tile size + spacing (never below a small epsilon). */
export function tilePitch(def: Pick<PatternDef, 'width' | 'height' | 'spacing'>): Vec {
  const sx = def.spacing?.x ?? 0;
  const sy = def.spacing?.y ?? 0;
  return { x: Math.max(0.01, def.width + sx), y: Math.max(0.01, def.height + sy) };
}

export function patternCell(def: Pick<PatternDef, 'width' | 'height' | 'spacing' | 'layout' | 'offset'>): PatternCell {
  const p = tilePitch(def);
  const layout = def.layout ?? 'grid';
  const off = def.offset ?? 0.5;
  switch (layout) {
    case 'grid':
      return { width: p.x, height: p.y, tiles: [{ x: 0, y: 0 }] };
    case 'brick-row': {
      const dx = off * p.x;
      return { width: p.x, height: p.y * 2, tiles: [{ x: 0, y: 0 }, { x: dx, y: p.y }, { x: dx - p.x, y: p.y }] };
    }
    case 'brick-col': {
      const dy = off * p.y;
      return { width: p.x * 2, height: p.y, tiles: [{ x: 0, y: 0 }, { x: p.x, y: dy }, { x: p.x, y: dy - p.y }] };
    }
    case 'hex-row': {
      // rows shifted by half a tile and packed at 0.866 of the height
      const rowH = p.y * 0.866;
      const dx = 0.5 * p.x;
      return { width: p.x, height: rowH * 2, tiles: [{ x: 0, y: 0 }, { x: dx, y: rowH }, { x: dx - p.x, y: rowH }, { x: 0, y: rowH * 2 }, { x: dx, y: -rowH }, { x: dx - p.x, y: -rowH }] };
    }
    case 'hex-col': {
      const colW = p.x * 0.866;
      const dy = 0.5 * p.y;
      return { width: colW * 2, height: p.y, tiles: [{ x: 0, y: 0 }, { x: colW, y: dy }, { x: colW, y: dy - p.y }, { x: colW * 2, y: 0 }, { x: -colW, y: dy }, { x: -colW, y: dy - p.y }] };
    }
  }
}

/** Number of tiles needed to cover a rectangle (for expanding a pattern fill). */
export function tilesCovering(def: Pick<PatternDef, 'width' | 'height' | 'spacing' | 'layout' | 'offset'>, bounds: { x: number; y: number; width: number; height: number }, scale = 1): Vec[] {
  const cell = patternCell(def);
  const cw = cell.width * scale;
  const ch = cell.height * scale;
  const out: Vec[] = [];
  const c0 = Math.floor(bounds.x / cw) - 1;
  const c1 = Math.ceil((bounds.x + bounds.width) / cw) + 1;
  const r0 = Math.floor(bounds.y / ch) - 1;
  const r1 = Math.ceil((bounds.y + bounds.height) / ch) + 1;
  if ((c1 - c0) * (r1 - r0) * cell.tiles.length > 20000) return out; // guard against absurd counts
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) for (const t of cell.tiles) out.push({ x: c * cw + t.x * scale, y: r * ch + t.y * scale });
  return out;
}
