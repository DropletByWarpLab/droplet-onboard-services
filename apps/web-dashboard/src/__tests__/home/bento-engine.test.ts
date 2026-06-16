import { describe, it, expect } from "vitest";
import {
  packLayout,
  fillGaps,
  layoutRows,
  clamp,
  type LayoutItem,
  type WidgetBounds,
} from "@/components/home/bento-engine";

const COLS = 12;

/** Assert no two placed rects overlap and none escapes the column count. */
function assertNoOverlap(items: LayoutItem[], cols: number) {
  const pos = packLayout(items, cols);
  const occ = new Set<string>();
  for (const it of items) {
    const p = pos[it.id];
    expect(p.x + p.w).toBeLessThanOrEqual(cols);
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) {
        const key = `${x}:${y}`;
        expect(occ.has(key)).toBe(false);
        occ.add(key);
      }
  }
}

/** Count empty cells inside the bounding box of a packed layout. */
function gapCount(items: LayoutItem[], cols: number): number {
  const pos = packLayout(items, cols);
  const rows = layoutRows(pos);
  const filled = new Set<string>();
  for (const it of items) {
    const p = pos[it.id];
    for (let y = p.y; y < p.y + p.h; y++)
      for (let x = p.x; x < p.x + p.w; x++) filled.add(`${x}:${y}`);
  }
  let gaps = 0;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) if (!filled.has(`${x}:${y}`)) gaps++;
  return gaps;
}

describe("clamp", () => {
  it("bounds a value into [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("packLayout", () => {
  it("places the first item at the origin", () => {
    const pos = packLayout([{ id: "a", w: 4, h: 2 }], COLS);
    expect(pos.a).toEqual({ x: 0, y: 0, w: 4, h: 2 });
  });

  it("flows items left→right then wraps to the next row", () => {
    const pos = packLayout(
      [
        { id: "a", w: 8, h: 2 },
        { id: "b", w: 4, h: 2 },
        { id: "c", w: 6, h: 2 },
      ],
      COLS,
    );
    expect(pos.a).toMatchObject({ x: 0, y: 0 });
    expect(pos.b).toMatchObject({ x: 8, y: 0 }); // fills the row
    expect(pos.c.y).toBe(2); // wraps below
  });

  it("clamps items wider than the grid to the column count", () => {
    const pos = packLayout([{ id: "wide", w: 99, h: 1 }], COLS);
    expect(pos.wide.w).toBe(COLS);
    expect(pos.wide.x).toBe(0);
  });

  it("never produces overlapping rectangles", () => {
    assertNoOverlap(
      [
        { id: "chat", w: 8, h: 5 },
        { id: "calendar", w: 4, h: 3 },
        { id: "status", w: 4, h: 3 },
        { id: "activity", w: 4, h: 3 },
        { id: "files", w: 4, h: 3 },
        { id: "cameras", w: 4, h: 3 },
        { id: "notes", w: 12, h: 2 },
      ],
      COLS,
    );
  });

  it("is deterministic — same input, same output", () => {
    const items: LayoutItem[] = [
      { id: "a", w: 3, h: 3 },
      { id: "b", w: 5, h: 2 },
      { id: "c", w: 4, h: 4 },
    ];
    expect(packLayout(items, COLS)).toEqual(packLayout(items, COLS));
  });
});

describe("fillGaps", () => {
  const registry: Record<string, WidgetBounds> = {
    a: { maxW: 12, maxH: 8 },
    b: { maxW: 12, maxH: 8 },
    c: { maxW: 12, maxH: 8 },
  };

  it("grows tiles to consume empty cells, leaving zero gaps", () => {
    // A 3-wide tile in a 12-col grid leaves a big gap; fill should close it.
    const items: LayoutItem[] = [{ id: "a", w: 3, h: 2 }];
    const filled = fillGaps(items, COLS, registry);
    expect(gapCount(filled, COLS)).toBe(0);
  });

  it("is idempotent — a gap-free layout is returned unchanged", () => {
    const items: LayoutItem[] = [
      { id: "a", w: 6, h: 2 },
      { id: "b", w: 6, h: 2 },
    ];
    const once = fillGaps(items, COLS, registry);
    const twice = fillGaps(once, COLS, registry);
    expect(twice).toEqual(once);
  });

  it("respects each widget's maxW when growing", () => {
    const bounded: Record<string, WidgetBounds> = { a: { maxW: 4, maxH: 8 } };
    const items: LayoutItem[] = [{ id: "a", w: 3, h: 2 }];
    const filled = fillGaps(items, COLS, bounded);
    expect(filled[0].w).toBeLessThanOrEqual(4);
  });

  it("preserves item identity and order", () => {
    const items: LayoutItem[] = [
      { id: "a", w: 3, h: 2 },
      { id: "b", w: 3, h: 2 },
    ];
    const filled = fillGaps(items, COLS, registry);
    expect(filled.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list unchanged", () => {
    expect(fillGaps([], COLS, registry)).toEqual([]);
  });
});
