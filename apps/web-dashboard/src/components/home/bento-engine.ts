/**
 * Bento engine — deterministic dense packing + auto gap-fill.
 *
 * Pure, framework-free geometry for the draggable/resizable Home board.
 * Ported faithfully from the Droplet Home design handoff (chat-centered
 * bento dashboard). The drag/resize React glue lives in `BentoBoard.tsx`;
 * everything here is a pure function so it can be unit-tested in isolation.
 *
 * Coordinate model: a `cols`-wide grid of unit cells. Each item declares a
 * width/height in cells; packing assigns an (x, y) origin. Rows are unbounded.
 */

/** A widget instance placed on the board: id + size in grid cells. */
export interface LayoutItem {
  id: string;
  w: number;
  h: number;
}

/** A resolved cell-space rectangle for one item. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Per-widget bounds the engine honors when growing/resizing tiles. */
export interface WidgetBounds {
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/**
 * Dense, order-based packing: place each item (in array order) at the first
 * free cell scanning top→bottom, left→right. Earlier gaps get filled by later
 * items when they fit, which keeps the board tidy after a reorder.
 *
 * Items wider than `cols` are clamped to `cols`. Deterministic: same input →
 * same output, with a safety bail at 400 rows so a pathological input can't
 * spin forever.
 */
export function packLayout(
  items: LayoutItem[],
  cols: number,
): Record<string, CellRect> {
  const occ: boolean[][] = [];

  const fits = (x: number, y: number, w: number, h: number): boolean => {
    if (x + w > cols) return false;
    for (let r = y; r < y + h; r++) {
      const row = occ[r];
      if (row) for (let c = x; c < x + w; c++) if (row[c]) return false;
    }
    return true;
  };
  const fill = (x: number, y: number, w: number, h: number): void => {
    for (let r = y; r < y + h; r++) {
      if (!occ[r]) occ[r] = [];
      for (let c = x; c < x + w; c++) occ[r][c] = true;
    }
  };

  const pos: Record<string, CellRect> = {};
  for (const it of items) {
    const w = Math.min(it.w, cols);
    const h = it.h;
    let done = false;
    for (let y = 0; !done; y++) {
      for (let x = 0; x + w <= cols; x++) {
        if (fits(x, y, w, h)) {
          fill(x, y, w, h);
          pos[it.id] = { x, y, w, h };
          done = true;
          break;
        }
      }
      if (y > 400) {
        // safety: never spin forever on a degenerate input
        pos[it.id] = { x: 0, y, w, h };
        done = true;
      }
    }
  }
  return pos;
}

/** Total row count spanned by a packed layout. */
export function layoutRows(pos: Record<string, CellRect>): number {
  let rows = 0;
  for (const k in pos) rows = Math.max(rows, pos[k].y + pos[k].h);
  return rows;
}

/**
 * Auto-fill empty cells: after packing, grow each tile (in reading order)
 * rightward then downward into adjacent EMPTY cells, bounded by each widget's
 * maxW/maxH. Tiles never extend past the board's existing row count, so a
 * gap-free layout is returned unchanged (idempotent).
 */
export function fillGaps(
  items: LayoutItem[],
  cols: number,
  registry: Record<string, WidgetBounds>,
): LayoutItem[] {
  if (!items.length) return items;

  const pos = packLayout(items, cols);
  const rows = layoutRows(pos);

  const grid: (string | null)[][] = Array.from({ length: rows }, () =>
    new Array<string | null>(cols).fill(null),
  );
  for (const it of items) {
    const p = pos[it.id];
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) grid[y][x] = it.id;
  }

  const sized: Record<string, { w: number; h: number }> = {};
  // Grow in reading order so upper-left tiles claim gaps first.
  const order = items
    .slice()
    .sort(
      (a, b) =>
        pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x,
    );

  for (const it of order) {
    const p = pos[it.id];
    const reg = registry[it.id] || {};
    const maxW = reg.maxW || cols;
    const maxH = reg.maxH || 8;
    let w = p.w;
    let h = p.h;

    // grow right into empty columns
    while (p.x + w < cols && w < maxW) {
      let ok = true;
      for (let y = p.y; y < p.y + h; y++)
        if (grid[y][p.x + w] !== null) {
          ok = false;
          break;
        }
      if (!ok) break;
      for (let y = p.y; y < p.y + h; y++) grid[y][p.x + w] = it.id;
      w++;
    }

    // grow down into empty rows (never past the existing board)
    while (h < maxH && p.y + h < rows) {
      const ny = p.y + h;
      let ok = true;
      for (let x = p.x; x < p.x + w; x++)
        if (grid[ny][x] !== null) {
          ok = false;
          break;
        }
      if (!ok) break;
      for (let x = p.x; x < p.x + w; x++) grid[ny][x] = it.id;
      h++;
    }

    sized[it.id] = { w, h };
  }

  return items.map((it) => ({
    ...it,
    w: sized[it.id].w,
    h: sized[it.id].h,
  }));
}
