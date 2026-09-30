/**
 * WARP-2980 (ADR-059 P5 PR-E, spec §6.18) — `security_explain_pattern`.
 *
 * A thin, read-only hop to A5 (GET /api/security/assistant/patterns): the
 * orchestrator resolves the person, applies DS-005 and builds every field;
 * the handler checks its arguments, sends exactly them, and reads every
 * refusal honestly — "not learned yet" and "no such place" included.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import tool from "../../../src/handlers/security/security-explain-pattern.js";
import type { ToolContext } from "../../../src/types.js";
import { expectErr, expectOk } from "../../helpers/tool-result.js";

function ctxWith(get: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    // Deliberately a username: the handler must never read it (WARP-3099).
    userId: "maria",
    signal: new AbortController().signal,
  };
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ANSWER = {
  timezone: "Europe/London",
  at: { at: "2026-09-23T01:00:00.000Z", local: "2:00 AM" },
  place: { name: "Stock room", kind: "area" },
  learning: { state: "ready", daysObserved: 20, daysNeeded: 14 },
  usual: { seenOnDays: 0, ofDays: 20, around: "2 AM", dayType: "weekdays", typicalPerHour: 0.017, longestUsualVisitSec: null, enoughData: true },
  why: null,
  wouldFlag: { notUsual: true, busierFrom: 3 },
  expected: [],
  moreExpected: 0,
  live: false,
  // Anything the route did not promise is dropped.
  debug: "x",
};

describe("security_explain_pattern", () => {
  it("is read-only: never a write, never a confirmation", () => {
    expect(tool.name).toBe("security_explain_pattern");
    expect(tool.requiresWrite).toBe(false);
    expect(tool.requiresConfirmation).toBe(false);
  });

  it("sends exactly the arguments it was given to A5, and returns the answer under its type", async () => {
    const get = vi.fn().mockResolvedValue(reply(200, ANSWER));
    const ctx = ctxWith(get);
    const out = expectOk(await tool.handler({ area: "Stock room", label: "person", at: "2026-09-23T02:00:00+01:00" }, ctx));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/security/assistant/patterns", {
      params: { area: "Stock room", label: "person", at: "2026-09-23T02:00:00+01:00" },
      headers: { Accept: "application/json" },
      signal: ctx.signal,
    });
    const { debug: _dropped, ...promised } = ANSWER;
    expect(out.data).toEqual({ type: "security_pattern", ...promised });
  });

  it("a camera and a period go through as given; nothing is added", async () => {
    const get = vi.fn().mockResolvedValue(reply(200, ANSWER));
    await tool.handler({ camera: "Front door", period: "last_night" }, ctxWith(get));
    expect(get.mock.calls[0]![1].params).toEqual({ camera: "Front door", period: "last_night" });
  });

  it.each([
    ["404 module_disabled", 404, { error: "module_disabled", module: "security" }, "SECURITY_UNAVAILABLE"],
    ["404 PLACE_NOT_FOUND", 404, { error: { code: "PLACE_NOT_FOUND", message: "There is no such area or camera." } }, "PLACE_NOT_FOUND"],
    ["409 PATTERNS_NOT_READY", 409, { error: { code: "PATTERNS_NOT_READY", message: "Droplet hasn't worked out what's usual yet." } }, "PATTERNS_NOT_READY"],
    ["400 BAD_REQUEST", 400, { error: { code: "BAD_REQUEST", message: "at can be at most 30 days back." } }, "BAD_REQUEST"],
    ["503", 503, { error: { code: "SECURITY_UNAVAILABLE" } }, "SECURITY_UNREACHABLE"],
  ])("%s → %s, never an empty answer", async (_label, status, body, code) => {
    const get = vi.fn().mockResolvedValue(reply(status, body));
    const err = expectErr(await tool.handler({ area: "Stock room" }, ctxWith(get))).error;
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("not learned yet passes the route's own reason through", async () => {
    const get = vi.fn().mockResolvedValue(
      reply(409, { error: { code: "PATTERNS_NOT_READY", message: "Droplet can't learn what's usual until it knows the site's time zone." } }),
    );
    expect(expectErr(await tool.handler({ area: "Stock room" }, ctxWith(get))).error.message).toMatch(/time zone/);
  });

  it("no answer at all → SECURITY_UNREACHABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(expectErr(await tool.handler({ area: "Stock room" }, ctxWith(get))).error.code).toBe("SECURITY_UNREACHABLE");
  });

  it.each([
    ["no place", {}],
    ["both an area and a camera", { area: "Stock room", camera: "Front door" }],
    ["both at and period", { area: "Stock room", at: "2026-09-23T02:00:00+01:00", period: "today" }],
    ["an empty area", { area: "" }],
    ["a period this tool does not take", { area: "Stock room", period: "last_7_days" }],
    ["a label Droplet does not track", { area: "Stock room", label: "bird" }],
    ["an unknown argument", { area: "Stock room", from: "2026-09-23T02:00:00+01:00" }],
  ])("%s → INVALID_ARGS with no call", async (_label, args) => {
    const get = vi.fn();
    expect(expectErr(await tool.handler(args as Record<string, unknown>, ctxWith(get))).error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});
