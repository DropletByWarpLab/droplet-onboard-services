/**
 * WARP-3371 — the keyset cursor every PM list pages with.
 *
 * Pure functions, so these tests pin the contract the SQL-level suite
 * (`__tests__/pm-list-paging.pg.test.ts`) and the route suites build on: what a
 * cursor round-trips, what it refuses, and which rows "after" means.
 */
import { describe, it, expect } from "vitest";
import {
  INVALID_CURSOR,
  ORDER_ACTIVITY,
  ORDER_BOARD,
  ORDER_COMMENTS,
  ORDER_SEARCH,
  PM_PAGE_DEFAULT,
  PM_PAGE_MAX,
  clampLimit,
  decodeCursor,
  encodeCursor,
  keysetAfter,
  sliceToPage,
} from "./pm-paging.js";

describe("pm-paging constants", () => {
  it("defaults to 100 and tops out at 500", () => {
    expect(PM_PAGE_DEFAULT).toBe(100);
    expect(PM_PAGE_MAX).toBe(500);
  });
});

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a numeric sort key and the id", () => {
    const c = encodeCursor(ORDER_BOARD, 42, "wi-1");
    expect(decodeCursor(ORDER_BOARD, c)).toEqual({ key: 42, id: "wi-1" });
  });

  it.each([0, -0.5, 0.1 + 0.2, 1e21, 123456789.123456789, Number.MIN_VALUE])(
    "round-trips the float %s exactly (sortOrder is a Float column)",
    (n) => {
      const out = decodeCursor(ORDER_BOARD, encodeCursor(ORDER_BOARD, n, "x"));
      expect(out.key).toBe(n);
    },
  );

  it("round-trips a date key to the millisecond", () => {
    const at = new Date("2026-10-03T17:45:12.345Z");
    const out = decodeCursor(ORDER_SEARCH, encodeCursor(ORDER_SEARCH, at, "wi-9"));
    expect(out.id).toBe("wi-9");
    expect(out.key).toBeInstanceOf(Date);
    expect((out.key as Date).toISOString()).toBe("2026-10-03T17:45:12.345Z");
  });

  it("is opaque: URL-safe base64, no raw JSON", () => {
    const c = encodeCursor(ORDER_BOARD, 7, "wi-1");
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c).not.toContain("wi-1");
  });

  it("refuses a cursor minted for a different ordering", () => {
    const comments = encodeCursor(ORDER_COMMENTS, new Date("2026-10-03T00:00:00.000Z"), "c-1");
    expect(() => decodeCursor(ORDER_ACTIVITY, comments)).toThrow(INVALID_CURSOR);
    expect(() => decodeCursor(ORDER_BOARD, comments)).toThrow(INVALID_CURSOR);
  });

  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

  it.each([
    ["empty", ""],
    ["not base64 json", "!!!not-a-cursor!!!"],
    ["json but not an object", b64("hello")],
    ["unknown version", b64({ v: 2, o: "board", k: 1, i: "x" })],
    ["missing id", b64({ v: 1, o: "board", k: 1 })],
    ["empty id", b64({ v: 1, o: "board", k: 1, i: "" })],
    ["oversized id", b64({ v: 1, o: "board", k: 1, i: "x".repeat(129) })],
    ["string key on a numeric ordering", b64({ v: 1, o: "board", k: "1", i: "x" })],
    ["null key (what JSON.stringify makes of Infinity)", b64({ v: 1, o: "board", k: null, i: "x" })],
  ])("rejects a malformed numeric cursor: %s", (_label, cursor) => {
    expect(() => decodeCursor(ORDER_BOARD, cursor)).toThrow(INVALID_CURSOR);
  });

  it.each([
    ["a number where an ISO instant belongs", { v: 1, o: "search", k: 1700000000000, i: "x" }],
    ["a date-only string", { v: 1, o: "search", k: "2026-10-03", i: "x" }],
    ["free text", { v: 1, o: "search", k: "next tuesday", i: "x" }],
    ["an offset instead of Z", { v: 1, o: "search", k: "2026-10-03T00:00:00.000+02:00", i: "x" }],
    ["a calendar-impossible instant", { v: 1, o: "search", k: "2026-02-31T00:00:00.000Z", i: "x" }],
  ])("rejects a malformed date cursor: %s", (_label, payload) => {
    expect(() => decodeCursor(ORDER_SEARCH, b64(payload))).toThrow(INVALID_CURSOR);
  });
});

describe("keysetAfter", () => {
  it("ascending: strictly greater key, or equal key and greater id", () => {
    expect(keysetAfter("sortOrder", "asc", { key: 5, id: "m" })).toEqual({
      OR: [{ sortOrder: { gt: 5 } }, { sortOrder: 5, id: { gt: "m" } }],
    });
  });

  it("descending: strictly smaller key, or equal key and smaller id", () => {
    const at = new Date("2026-10-03T00:00:00.000Z");
    expect(keysetAfter("updatedAt", "desc", { key: at, id: "m" })).toEqual({
      OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: "m" } }],
    });
  });
});

describe("clampLimit", () => {
  it("defaults when absent or not a number", () => {
    expect(clampLimit(undefined)).toBe(100);
    expect(clampLimit(Number.NaN)).toBe(100);
  });
  it("clamps into 1..500 and floors fractions", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(501)).toBe(500);
    expect(clampLimit(1000)).toBe(500);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(250)).toBe(250);
  });
});

describe("sliceToPage", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
  const cursorOf = (r: { id: string }) => `after-${r.id}`;

  it("fewer than limit + 1 rows is the last page: no cursor", () => {
    expect(sliceToPage(rows(3), 5, cursorOf)).toEqual({ items: rows(3), nextCursor: null });
  });

  it("exactly `limit` rows is ALSO the last page — the extra row is the only proof of more", () => {
    expect(sliceToPage(rows(5), 5, cursorOf)).toEqual({ items: rows(5), nextCursor: null });
  });

  it("limit + 1 rows drops the extra and points the cursor at the last KEPT row", () => {
    const out = sliceToPage(rows(6), 5, cursorOf);
    expect(out.items).toEqual(rows(5));
    expect(out.nextCursor).toBe("after-r4");
  });

  it("an empty fetch is an empty last page", () => {
    expect(sliceToPage([], 5, cursorOf)).toEqual({ items: [], nextCursor: null });
  });
});
