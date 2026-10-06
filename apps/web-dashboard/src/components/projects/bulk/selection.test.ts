/**
 * WARP-3537 — the table's selection: a set of work-item ids, at most as many as one
 * bulk request may carry. Pure functions (the hook is a thin state holder over
 * them), because the cap, the shift-range and the pruning are the rules.
 */
import { describe, it, expect } from "vitest";
import { PM_BULK_MAX_IDS } from "@droplet/shared-types";
import { addMany, prune, rangeBetween, toggle } from "./selection";

const ids = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("toggle", () => {
  it("selects what is not selected and unselects what is", () => {
    const a = toggle(new Set<string>(), "w1");
    expect([...a.next]).toEqual(["w1"]);
    expect(a.capped).toBe(false);
    const b = toggle(a.next, "w1");
    expect([...b.next]).toEqual([]);
  });

  it("does not mutate what it was given", () => {
    const before = new Set(["w1"]);
    toggle(before, "w2");
    expect([...before]).toEqual(["w1"]);
  });

  it("refuses the 501st item, and says it was capped — 500 is what one request may change", () => {
    const full = new Set(ids(PM_BULK_MAX_IDS));
    const r = toggle(full, "extra");
    expect(r.next.size).toBe(PM_BULK_MAX_IDS);
    expect(r.next.has("extra")).toBe(false);
    expect(r.capped).toBe(true);
  });

  it("still lets a full selection shrink", () => {
    const full = new Set(ids(PM_BULK_MAX_IDS));
    const r = toggle(full, "w3");
    expect(r.next.size).toBe(PM_BULK_MAX_IDS - 1);
    expect(r.capped).toBe(false);
  });
});

describe("addMany", () => {
  it("adds in order and keeps what was there", () => {
    const r = addMany(new Set(["a"]), ["b", "c"]);
    expect([...r.next]).toEqual(["a", "b", "c"]);
    expect(r.capped).toBe(false);
  });

  it("stops at the cap, taking the FIRST ones in the order given, and says so", () => {
    const r = addMany(new Set<string>(), ids(PM_BULK_MAX_IDS + 40));
    expect(r.next.size).toBe(PM_BULK_MAX_IDS);
    expect(r.next.has(`w${PM_BULK_MAX_IDS - 1}`)).toBe(true);
    expect(r.next.has(`w${PM_BULK_MAX_IDS}`)).toBe(false);
    expect(r.capped).toBe(true);
  });

  it("is not capped just because some ids were already selected", () => {
    const r = addMany(new Set(ids(PM_BULK_MAX_IDS)), ids(PM_BULK_MAX_IDS));
    expect(r.next.size).toBe(PM_BULK_MAX_IDS);
    expect(r.capped).toBe(false);
  });
});

describe("rangeBetween (shift-click)", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("is every id from one to the other, inclusive, whichever is first", () => {
    expect(rangeBetween(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "c", "c")).toEqual(["c"]);
  });

  it("is just the clicked row when the anchor is not on screen any more (filtered away, collapsed)", () => {
    expect(rangeBetween(order, "gone", "c")).toEqual(["c"]);
  });

  it("is empty when the clicked row itself is not in the order", () => {
    expect(rangeBetween(order, "a", "gone")).toEqual([]);
  });
});

describe("prune", () => {
  it("drops ids that are no longer in the list — a filter, an archive, a delete", () => {
    const r = prune(new Set(["a", "b", "c"]), new Set(["a", "c", "z"]));
    expect([...r]).toEqual(["a", "c"]);
  });

  it("returns the SAME set when nothing was dropped, so a re-render does not become a state change", () => {
    const sel = new Set(["a"]);
    expect(prune(sel, new Set(["a", "b"]))).toBe(sel);
  });
});
