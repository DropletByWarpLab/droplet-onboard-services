/**
 * WARP-2977 P2b — the Security audit helpers.
 *
 *   · `securityRefs` refuses anything the chain would not round-trip: a Date
 *     signs as `{}` and breaks audit-verify on that row forever; a BigInt
 *     makes the insert throw; `undefined` vanishes from the signed content; a
 *     number that is not a safe integer is rounded by Prisma's Json write;
 *     nesting past 32 levels fails the write (or the stack).
 *   · `auditSecurityInTx` writes kind system / severity info — never the
 *     network/auth warn/err rows the P2a threat mirror copies into the feed —
 *     and turns any append failure into SecurityAuditUnavailableError.
 *   · `auditSecuritySystem` throws rather than swallowing, for safeRun.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  inTx: vi.fn(),
  recorder: null as null | { record: ReturnType<typeof vi.fn> },
}));

vi.mock("./activity.singleton.js", () => ({
  recordActivityInTx: h.inTx,
  getActivityRecorder: () => h.recorder,
}));

import {
  MAX_SECURITY_REFS_DEPTH,
  SecurityAuditUnavailableError,
  auditSecurityInTx,
  auditSecuritySystem,
  chainSafeText,
  isSecurityAuditUnavailable,
  securityRefs,
} from "./security-audit.js";
import { ActivityChainPreconditionError } from "./activity.service.js";

const TX = { marker: "tx" } as never;
const REQ = { user: { id: "11111111-1111-4111-8111-111111111111", role: "family" } };

beforeEach(() => {
  h.inTx.mockReset();
  h.recorder = null;
});

describe("securityRefs", () => {
  it("passes JSON-faithful values through as a deep copy", () => {
    const input = { zoneId: "z1", added: ["a"], removed: [], n: 3, ok: true, none: null, nested: { until: "2026-09-25T08:00:00.000Z" } };
    const out = securityRefs(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });

  it.each([
    ["a Date", { at: new Date() }, /Date at at/],
    ["a BigInt", { id: 5n }, /BigInt at id/],
    ["undefined", { gone: undefined }, /undefined at gone/],
    ["a function", { f: () => 1 }, /function at f/],
    ["a symbol", { s: Symbol("x") }, /symbol at s/],
    ["NaN", { n: Number.NaN }, /non-finite number at n/],
    ["Infinity", { n: Number.POSITIVE_INFINITY }, /non-finite number at n/],
    ["a Map", { m: new Map() }, /non-plain object at m/],
    ["a nested Date", { modeEffect: { from: "open", at: new Date() } }, /Date at modeEffect\.at/],
    ["a Date inside an array", { list: ["a", new Date()] }, /Date at list\[1\]/],
    ["a BigInt deep in an array of objects", { rows: [{ id: "1" }, { id: 2n }] }, /BigInt at rows\[1\]\.id/],
    ["undefined inside an array", { list: [undefined] }, /undefined at list\[0\]/],
  ])("rejects %s", (_name, input, message) => {
    expect(() => securityRefs(input as Record<string, unknown>)).toThrow(message);
  });

  it("rejects a cycle instead of overflowing the stack", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => securityRefs(a)).toThrow(/cycle at self/);
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { k: "v" };
    expect(securityRefs({ a: shared, b: shared })).toEqual({ a: { k: "v" }, b: { k: "v" } });
  });

  // An own "__proto__" key — what JSON.parse (so express.json()) makes of any
  // body carrying one. Copied into `{}` it would call the prototype SETTER:
  // signed without it (own keys only), stored with it (Prisma serialises
  // inherited enumerable props) → audit-verify fails on that row forever.
  it.each([
    ["at the top level", '{"a":1,"__proto__":{"zoneId":"z1"}}', (b: unknown) => b, /__proto__ key at __proto__$/],
    ["nested", '{"__proto__":{"zoneId":"z1"}}', (b: unknown) => ({ nested: b }), /__proto__ key at nested\.__proto__$/],
    ["inside an array", '{"ok":1,"__proto__":{}}', (b: unknown) => ({ list: ["x", b] }), /__proto__ key at list\[1\]\.__proto__$/],
  ])("rejects a JSON.parse'd own __proto__ key %s", (_name, json, wrap, message) => {
    const body = JSON.parse(json) as unknown;
    expect(Object.prototype.hasOwnProperty.call(body, "__proto__")).toBe(true); // the fixture is real
    expect(() => securityRefs(wrap(body) as Record<string, unknown>)).toThrow(TypeError);
    expect(() => securityRefs(wrap(body) as Record<string, unknown>)).toThrow(message);
  });

  it("keeps ordinary keys that merely look special as plain own properties", () => {
    const out = securityRefs(JSON.parse('{"constructor":"c","prototype":{"x":1}}') as Record<string, unknown>);
    expect(Object.keys(out)).toEqual(["constructor", "prototype"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out).toEqual({ constructor: "c", prototype: { x: 1 } });
  });

  it.each([
    ["U+0000 in a value", { note: "a\u0000b" }, /U\+0000 in refs at note/],
    ["U+0000 deep in an array", { rows: [{ n: ["ok", "\u0000"] }] }, /U\+0000 in refs at rows\[0\]\.n\[1\]/],
    ["U+0000 in a key", { ["bad\u0000key"]: 1 }, /U\+0000 in a refs key/],
    ["a lone high surrogate", { note: "x\uD800" }, /lone UTF-16 surrogate in refs at note/],
    ["a lone low surrogate, nested", { nested: { note: "\uDC00y" } }, /lone UTF-16 surrogate in refs at nested\.note/],
    ["an array hole", { list: [1, , 3] }, /undefined at list\[1\]/],
  ])("rejects %s (Postgres would refuse the insert: a 503 for what is bad input)", (_name, input, message) => {
    expect(() => securityRefs(input as Record<string, unknown>)).toThrow(message);
  });

  it("keeps well-formed non-ASCII text, surrogate pairs included", () => {
    const input = { name: "İstanbul — café 😀", list: ["ΟΔΟΣ"] };
    expect(securityRefs(input)).toEqual(input);
  });

  // Prisma's Json WRITE keeps 16 significant digits: a double whose shortest
  // form needs 17 is stored as a different number (or null) while the signer
  // signed the original — audit-verify broken on that row forever. Security
  // numbers are minutes, versions and counts: safe integers only.
  it.each([
    ["0.1 + 0.2", { n: 0.1 + 0.2 }, "n"],
    ["the largest double", { n: 1.7976931348623157e308 }, "n"],
    ["the smallest normal double, negative", { n: -2.2250738585072014e-308 }, "n"],
    ["a plain fraction", { minutes: 1.5 }, "minutes"],
    ["2^53 (past the safe range)", { n: Number.MAX_SAFE_INTEGER + 1 }, "n"],
    ["-(2^53)", { n: Number.MIN_SAFE_INTEGER - 1 }, "n"],
    ["a fraction nested in an array", { rows: [{ n: [1, 2.5] }] }, "rows\\[0\\]\\.n\\[1\\]"],
  ])("rejects %s — not a safe integer — naming the path", (_name, input, path) => {
    expect(() => securityRefs(input as Record<string, unknown>)).toThrow(TypeError);
    expect(() => securityRefs(input as Record<string, unknown>)).toThrow(new RegExp(` at ${path} is not a safe integer`));
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s as non-finite", (_name, n) => {
    expect(() => securityRefs({ deep: { n } })).toThrow(/non-finite number at deep\.n/);
  });

  it("keeps safe integers exactly, at both ends of the range", () => {
    const input = { zero: 0, one: 1, neg: -42, max: Number.MAX_SAFE_INTEGER, min: Number.MIN_SAFE_INTEGER, list: [3, -7] };
    expect(securityRefs(input)).toEqual(input);
  });

  it("normalises -0 to 0 rather than refusing it (JSON has no negative zero; it signs and stores as 0)", () => {
    const out = securityRefs({ z: -0, list: [-0] });
    expect(Object.is(out.z, 0)).toBe(true);
    expect(Object.is((out.list as number[])[0], 0)).toBe(true);
    expect(JSON.stringify(out)).toBe('{"z":0,"list":[0]}');
  });

  function nested(depth: number, wrap: (inner: unknown) => unknown): Record<string, unknown> {
    let v: unknown = {};
    for (let i = 0; i < depth; i++) v = wrap(v);
    return v as Record<string, unknown>;
  }

  it("accepts nesting down to MAX_SECURITY_REFS_DEPTH below the top level", () => {
    expect(MAX_SECURITY_REFS_DEPTH).toBe(32);
    expect(() => securityRefs(nested(32, (x) => ({ a: x })))).not.toThrow();
    expect(() => securityRefs({ list: nested(31, (x) => [x]) })).not.toThrow();
  });

  it.each([
    ["objects", nested(33, (x) => ({ a: x })), new RegExp(`nesting deeper than 32 at ${Array(33).fill("a").join("\\.")}$`)],
    ["arrays", { list: nested(32, (x) => [x]) }, new RegExp(`nesting deeper than 32 at list${"\\[0\\]".repeat(32)}$`)],
  ])("refuses %s nested one level deeper, naming the path", (_name, input, message) => {
    expect(() => securityRefs(input)).toThrow(TypeError);
    expect(() => securityRefs(input)).toThrow(message);
  });

  it("refuses 10 000 levels with a TypeError, not a stack overflow (a 500, never a 503)", () => {
    const deep = nested(10_000, (x) => ({ a: x }));
    expect(() => securityRefs(deep)).toThrow(TypeError);
    expect(() => securityRefs(deep)).toThrow(/nesting deeper than 32/);
  });
});

describe("chainSafeText", () => {
  it("accepts storable text and refuses U+0000 and lone surrogates", () => {
    expect(chainSafeText("Front door 😀")).toBe(true);
    expect(chainSafeText("")).toBe(true);
    expect(chainSafeText("a\u0000")).toBe(false);
    expect(chainSafeText("\uD83D")).toBe(false);
    expect(chainSafeText("\uDE00\uD83D")).toBe(false);
  });
});

describe("isSecurityAuditUnavailable", () => {
  it("is true for the wrapped append failure and for Prisma P2028 (the tx expired waiting for the chain lock)", () => {
    expect(isSecurityAuditUnavailable(new SecurityAuditUnavailableError(new Error("x")))).toBe(true);
    const p2028 = Object.assign(new Error("Transaction already closed"), { code: "P2028", name: "PrismaClientKnownRequestError" });
    expect(isSecurityAuditUnavailable(p2028)).toBe(true);
  });

  it("is false for everything else — a 500, not a 503", () => {
    expect(isSecurityAuditUnavailable(Object.assign(new Error("conflict"), { code: "P2034" }))).toBe(false);
    expect(isSecurityAuditUnavailable(new TypeError("security audit refs: Date at at"))).toBe(false);
    expect(isSecurityAuditUnavailable(new ActivityChainPreconditionError("needs READ COMMITTED"))).toBe(false);
    expect(isSecurityAuditUnavailable(null)).toBe(false);
    expect(isSecurityAuditUnavailable(undefined)).toBe(false);
    expect(isSecurityAuditUnavailable("P2028")).toBe(false);
  });
});

describe("auditSecurityInTx", () => {
  it("writes a system/info/shield row in the caller's transaction, attributed to the person", async () => {
    h.inTx.mockResolvedValue({ id: 1n });
    await auditSecurityInTx(TX, REQ, {
      action: "mode.close",
      what: "Security: closed up",
      refs: { until: "2026-09-25T08:00:00.000Z" },
    });
    expect(h.inTx).toHaveBeenCalledTimes(1);
    const [tx, params] = h.inTx.mock.calls[0]!;
    expect(tx).toBe(TX);
    expect(params).toEqual({
      kind: "system",
      severity: "info",
      sourceIcon: "shield",
      what: "Security: closed up",
      sub: null,
      refs: { until: "2026-09-25T08:00:00.000Z", surface: "security", action: "mode.close" },
      actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("surface and action cannot be overridden by the caller's refs", async () => {
    h.inTx.mockResolvedValue({ id: 1n });
    await auditSecurityInTx(TX, REQ, {
      action: "zone.links",
      what: "Security: area links changed",
      refs: { surface: "network", action: "mode.close", zoneId: "z1" },
    });
    expect(h.inTx.mock.calls[0]![1].refs).toEqual({ surface: "security", action: "zone.links", zoneId: "z1" });
  });

  it("an append failure becomes SecurityAuditUnavailableError (the route's 503)", async () => {
    h.inTx.mockRejectedValue(new Error("activity recorder not initialised"));
    const p = auditSecurityInTx(TX, REQ, { action: "hours.set", what: "Security: opening hours changed" });
    await expect(p).rejects.toBeInstanceOf(SecurityAuditUnavailableError);
    await expect(p).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
  });

  it("bad refs throw BEFORE the append — a programming error, not an outage", async () => {
    await expect(
      auditSecurityInTx(TX, REQ, { action: "mode.open", what: "x", refs: { until: new Date() } }),
    ).rejects.toThrow(TypeError);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("a JSON.parse'd __proto__ in the caller's refs is refused, even though the merge spreads it", async () => {
    const refs = JSON.parse('{"__proto__":{"zoneId":"z1"}}') as Record<string, unknown>;
    const p = auditSecurityInTx(TX, REQ, { action: "zone.update", what: "Security: area changed", refs });
    await expect(p).rejects.toThrow(/__proto__ key at __proto__/);
    await expect(p).rejects.not.toBeInstanceOf(SecurityAuditUnavailableError);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it.each([
    ["U+0000 in what", { what: "Security: area \u0000renamed" }, /U\+0000 in what/],
    ["a lone surrogate in what", { what: "Security: \uD800" }, /lone UTF-16 surrogate in what/],
    ["U+0000 in sub", { what: "Security: area renamed", sub: "note\u0000" }, /U\+0000 in sub/],
    ["a lone surrogate in sub", { what: "Security: area renamed", sub: "\uDC00" }, /lone UTF-16 surrogate in sub/],
  ])("%s is refused before the append (a TypeError, never AUDIT_UNAVAILABLE)", async (_name, fields, message) => {
    const p = auditSecurityInTx(TX, REQ, { action: "zone.update", ...fields });
    await expect(p).rejects.toThrow(message);
    await expect(p).rejects.toBeInstanceOf(TypeError);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("an invalid actor (a blank user id) is a programming error thrown BEFORE the append, not AUDIT_UNAVAILABLE", async () => {
    const p = auditSecurityInTx(TX, { user: { id: "   ", role: "owner" } }, { action: "mode.close", what: "Security: closed up" });
    await expect(p).rejects.toThrow(/requires a non-empty id/);
    await expect(p).rejects.not.toBeInstanceOf(SecurityAuditUnavailableError);
    expect(h.inTx).not.toHaveBeenCalled();
  });

  it("a broken append precondition (bare client / wrong isolation) propagates as is — a 500, not a 503", async () => {
    const pre = new ActivityChainPreconditionError("activity chain append needs a READ COMMITTED transaction");
    h.inTx.mockRejectedValue(pre);
    const p = auditSecurityInTx(TX, REQ, { action: "hours.set", what: "Security: opening hours changed" });
    await expect(p).rejects.toBe(pre);
    await expect(p).rejects.not.toBeInstanceOf(SecurityAuditUnavailableError);
  });
});

describe("auditSecuritySystem", () => {
  it("records through the bound recorder as the system actor", async () => {
    const record = vi.fn().mockResolvedValue({ id: 2n });
    h.recorder = { record };
    await auditSecuritySystem({ action: "mode.expire", what: "Security: opening hours took over from a manual Close up" });
    expect(record).toHaveBeenCalledWith({
      kind: "system",
      severity: "info",
      sourceIcon: "shield",
      what: "Security: opening hours took over from a manual Close up",
      sub: null,
      refs: { surface: "security", action: "mode.expire" },
      actor: { type: "system", id: null },
    });
  });

  it("throws when the recorder is not initialised (safeRun's canary sees it)", async () => {
    h.recorder = null;
    await expect(auditSecuritySystem({ action: "mode.expire", what: "x" })).rejects.toThrow(/not initialised/);
  });

  it("validates what/refs before touching the recorder", async () => {
    const record = vi.fn();
    h.recorder = { record };
    await expect(auditSecuritySystem({ action: "mode.expire", what: "x\u0000" })).rejects.toThrow(/U\+0000 in what/);
    await expect(
      auditSecuritySystem({ action: "mode.expire", what: "x", refs: JSON.parse('{"__proto__":{}}') as Record<string, unknown> }),
    ).rejects.toThrow(/__proto__/);
    expect(record).not.toHaveBeenCalled();
  });

  it("propagates a recorder failure instead of swallowing it", async () => {
    h.recorder = { record: vi.fn().mockRejectedValue(new Error("chain lock timeout")) };
    await expect(auditSecuritySystem({ action: "mode.expire", what: "x" })).rejects.toThrow("chain lock timeout");
  });
});
