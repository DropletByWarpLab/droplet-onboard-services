/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_list_incidents`.
 *
 * A thin, read-only hop to A1 (GET /api/security/assistant/incidents): the
 * orchestrator resolves the person and applies DS-005; the handler checks
 * its arguments, sends exactly them, and reads every refusal honestly.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { SecurityIncidentState as PrismaIncidentState, SecuritySeverity as PrismaSeverity } from "@prisma/client";
import tool from "../../../src/handlers/security/security-list-incidents.js";
import {
  SECURITY_SEVERITY_ARGS,
  SECURITY_STATE_ARGS,
  type SecurityIncidentStateName,
  type SecuritySeverityName,
} from "../../../src/handlers/security/common.js";
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

const PAGE = {
  period: null,
  timezone: "Europe/London",
  incidents: [{ id: "a", title: "Shop floor" }],
  nextCursor: "1.a",
  // Anything the route did not promise is dropped.
  debug: "x",
};

describe("security_list_incidents", () => {
  it("is read-only: never a write, never a confirmation", () => {
    expect(tool.name).toBe("security_list_incidents");
    expect(tool.requiresWrite).toBe(false);
    expect(tool.requiresConfirmation).toBe(false);
  });

  it("sends exactly the arguments it was given to A1, and returns the page under its type", async () => {
    const get = vi.fn().mockResolvedValue(reply(200, PAGE));
    const ctx = ctxWith(get);
    const out = expectOk(
      await tool.handler({ period: "last_night", area: "Stock room", severity: "alert", state: "open", limit: 5, cursor: "1.a" }, ctx),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/security/assistant/incidents", {
      params: { period: "last_night", area: "Stock room", severity: "alert", state: "open", limit: "5", cursor: "1.a" },
      headers: { Accept: "application/json" },
      signal: ctx.signal,
    });
    expect(out.data).toEqual({ type: "security_incidents", period: null, timezone: "Europe/London", incidents: PAGE.incidents, nextCursor: "1.a" });
  });

  it("from/to go as given; no arguments send no params", async () => {
    const get = vi.fn().mockResolvedValue(reply(200, PAGE));
    await tool.handler({ from: "2026-09-22T21:00:00+01:00", to: "2026-09-23T08:00:00+01:00" }, ctxWith(get));
    expect(get.mock.calls[0]![1].params).toEqual({ from: "2026-09-22T21:00:00+01:00", to: "2026-09-23T08:00:00+01:00" });
    await tool.handler({}, ctxWith(get));
    expect(get.mock.calls[1]![1].params).toEqual({});
  });

  it.each([
    ["404 module_disabled", 404, { error: "module_disabled", module: "security" }, "SECURITY_UNAVAILABLE"],
    ["503", 503, { error: { code: "SECURITY_UNAVAILABLE", message: "x" } }, "SECURITY_UNREACHABLE"],
    ["500 with no body", 500, null, "SECURITY_UNREACHABLE"],
    ["400 NO_SITE_TIMEZONE", 400, { error: { code: "NO_SITE_TIMEZONE", message: "x" } }, "NO_SITE_TIMEZONE"],
    ["400", 400, { error: { code: "BAD_REQUEST", message: "from is older than Droplet keeps this." } }, "BAD_REQUEST"],
  ])("%s → %s, never an empty list", async (_label, status, body, code) => {
    const get = vi.fn().mockResolvedValue(reply(status, body));
    const err = expectErr(await tool.handler({}, ctxWith(get)));
    expect(err.error.code).toBe(code);
    if (code === "BAD_REQUEST") expect(err.error.message).toBe("from is older than Droplet keeps this.");
    if (code === "SECURITY_UNAVAILABLE") expect(err.error.message).toBe("Security is switched off on this Droplet, or this person can't use it.");
  });

  it("no answer at all → SECURITY_UNREACHABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(expectErr(await tool.handler({}, ctxWith(get))).error.code).toBe("SECURITY_UNREACHABLE");
  });

  it.each([
    ["an unknown period", { period: "yesterday" }],
    ["period with from", { period: "today", from: "2026-09-22T21:00:00Z" }],
    ["to without from", { to: "2026-09-22T21:00:00Z" }],
    ["a long area", { area: "x".repeat(61) }],
    ["an empty area", { area: "  " }],
    ["a severity that is not a filter", { severity: "info" }],
    ["a state that is not a filter", { state: "no_action" }],
    ["limit 0", { limit: 0 }],
    ["limit 26", { limit: 26 }],
    ["a fractional limit", { limit: 2.5 }],
    ["an unknown argument", { user: "maria" }],
  ])("%s → INVALID_ARGS with no call", async (_label, args) => {
    const get = vi.fn();
    expect(expectErr(await tool.handler(args as Record<string, unknown>, ctxWith(get))).error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("the schema refuses extra properties", () => {
    expect((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });

  it("the description carries the honesty rules", () => {
    expect(tool.description).toMatch(/never who/i);
    expect(tool.description).toMatch(/only what this person may see/i);
    expect(tool.description).toMatch(/does not yet judge what is unusual/i);
  });

  it("the restated vocabularies are Prisma's (type-level; typecheck:tests runs it)", () => {
    expectTypeOf<SecuritySeverityName>().toExtend<PrismaSeverity>();
    expectTypeOf<SecurityIncidentStateName>().toExtend<PrismaIncidentState>();
    expect([...SECURITY_SEVERITY_ARGS]).toEqual(["alert", "notice"]);
    expect(SECURITY_STATE_ARGS).toContain("attention");
  });
});
