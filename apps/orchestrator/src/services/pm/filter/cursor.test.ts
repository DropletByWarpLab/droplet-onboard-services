/**
 * WARP-3522 — the query API's page cursor.
 *
 * Opaque to clients, but not signed: it carries a position (an offset) and a
 * fingerprint of the query it belongs to. The fingerprint is what turns "page 2
 * of a different query" — a client that changed a filter and kept the old
 * cursor — into a 400 instead of a silently wrong page. A forged offset only
 * moves the caller around their own result set, which they could read anyway.
 */
import { describe, it, expect } from "vitest";
import type { PmFilter } from "@droplet/shared-types";
import { decodeCursor, encodeCursor, queryFingerprint } from "./cursor.js";

const filter: PmFilter = { and: [{ field: "priority", op: "is", value: "high" }] };
const base = { scope: "project:p1", filter, sort: [{ field: "sortOrder" as const, dir: "asc" as const }], tz: "UTC" };

describe("queryFingerprint", () => {
  it("is stable for the same query and short enough for a URL", () => {
    const fp = queryFingerprint(base);
    expect(fp).toBe(queryFingerprint({ ...base }));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when anything that changes the result set changes", () => {
    const fp = queryFingerprint(base);
    expect(queryFingerprint({ ...base, scope: "project:p2" })).not.toBe(fp);
    expect(queryFingerprint({ ...base, tz: "Pacific/Auckland" })).not.toBe(fp);
    expect(queryFingerprint({ ...base, sort: [{ field: "dueDate", dir: "asc" }] })).not.toBe(fp);
    expect(queryFingerprint({ ...base, sort: [{ field: "sortOrder", dir: "desc" }] })).not.toBe(fp);
    expect(
      queryFingerprint({ ...base, filter: { and: [{ field: "priority", op: "is", value: "low" }] } }),
    ).not.toBe(fp);
  });

  it("does not change for a filter written differently but meaning the same tree", () => {
    const wrapped: PmFilter = { and: [{ and: [filter] }] };
    expect(queryFingerprint({ ...base, filter: wrapped })).toBe(queryFingerprint(base));
  });
});

describe("encodeCursor / decodeCursor", () => {
  const fp = queryFingerprint(base);

  it("round-trips an offset", () => {
    for (const offset of [0, 1, 100, 99_999]) {
      expect(decodeCursor(encodeCursor(offset, fp), fp)).toBe(offset);
    }
  });

  it("is URL- and JSON-safe (base64url, no padding)", () => {
    expect(encodeCursor(123456, fp)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses a cursor from a different query", () => {
    const other = queryFingerprint({ ...base, scope: "project:p2" });
    expect(() => decodeCursor(encodeCursor(100, other), fp)).toThrow("invalid_cursor");
  });

  const garbage = [
    "",
    "not a cursor",
    "!!!",
    Buffer.from("{}").toString("base64url"),
    Buffer.from("null").toString("base64url"),
    Buffer.from("[1,2]").toString("base64url"),
    Buffer.from('{"o":"100","f":"x"}').toString("base64url"),
    Buffer.from('{"o":-1,"f":"0123456789abcdef"}').toString("base64url"),
    Buffer.from('{"o":1.5,"f":"0123456789abcdef"}').toString("base64url"),
    Buffer.from('{"o":1e12,"f":"0123456789abcdef"}').toString("base64url"),
    Buffer.from("{broken").toString("base64url"),
  ];
  it.each(garbage)("refuses %j", (c) => {
    expect(() => decodeCursor(c, fp)).toThrow("invalid_cursor");
  });
});
