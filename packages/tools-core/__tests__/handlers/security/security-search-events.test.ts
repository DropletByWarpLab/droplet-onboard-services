/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_search_events`: A3, the last 30
 * days of Security events for the person the assistant acts for.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { SecurityEventKind as PrismaEventKind } from "@prisma/client";
import tool from "../../../src/handlers/security/security-search-events.js";
import { SECURITY_EVENT_KIND_ARGS, type SecurityEventKindName } from "../../../src/handlers/security/common.js";
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
    signal: new AbortController().signal,
  };
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("security_search_events", () => {
  it("is read-only", () => {
    expect(tool.name).toBe("security_search_events");
    expect(tool.requiresWrite).toBe(false);
    expect(tool.requiresConfirmation).toBe(false);
  });

  it("sends exactly its filters to A3 and returns the page under its type", async () => {
    const get = vi.fn().mockResolvedValue(reply(200, { period: null, timezone: null, events: [], nextCursor: null }));
    const ctx = ctxWith(get);
    const out = expectOk(
      await tool.handler({ period: "today", area: "Stock room", camera: "Back camera", label: "person", kind: "detection", limit: 40, cursor: "1.2" }, ctx),
    );
    expect(get).toHaveBeenCalledWith("/api/security/assistant/events", {
      params: { period: "today", area: "Stock room", camera: "Back camera", label: "person", kind: "detection", limit: "40", cursor: "1.2" },
      headers: { Accept: "application/json" },
      signal: ctx.signal,
    });
    expect(out.data).toEqual({ type: "security_events", period: null, timezone: null, events: [], nextCursor: null });
  });

  it.each([
    ["404 module_disabled", 404, { error: "module_disabled", module: "security" }, "SECURITY_UNAVAILABLE"],
    ["503", 503, {}, "SECURITY_UNREACHABLE"],
    ["400 NO_SITE_TIMEZONE", 400, { error: { code: "NO_SITE_TIMEZONE", message: "x" } }, "NO_SITE_TIMEZONE"],
  ])("%s → %s", async (_label, status, body, code) => {
    const get = vi.fn().mockResolvedValue(reply(status, body));
    const err = expectErr(await tool.handler({ period: "today" }, ctxWith(get)));
    expect(err.error.code).toBe(code);
    if (code === "NO_SITE_TIMEZONE") expect(err.error.message).toMatch(/exact times/);
  });

  it.each([
    ["a low-score kind", { kind: "detection_low" }],
    ["an unknown label", { label: "bicycle" }],
    ["limit 41", { limit: 41 }],
    ["a long camera name", { camera: "c".repeat(65) }],
    ["an unknown argument", { zone: "x" }],
  ])("%s → INVALID_ARGS with no call", async (_label, args) => {
    const get = vi.fn();
    expect(expectErr(await tool.handler(args as Record<string, unknown>, ctxWith(get))).error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("the kinds it offers are Prisma's event kinds (type-level), and never the low-score one", () => {
    expectTypeOf<SecurityEventKindName>().toExtend<PrismaEventKind>();
    expect(SECURITY_EVENT_KIND_ARGS).not.toContain("detection_low");
    expect(tool.description).toMatch(/not who/i);
  });
});
