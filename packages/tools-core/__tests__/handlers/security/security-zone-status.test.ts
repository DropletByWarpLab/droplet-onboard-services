/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — `security_zone_status`: A4, the site mode
 * and what covers each area the person can see, right now.
 */
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import tool from "../../../src/handlers/security/security-zone-status.js";
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
const BODY = { site: { mode: "closed" }, areas: [], moreAreas: 0, suggestionsWaiting: null };

describe("security_zone_status", () => {
  it("is read-only", () => {
    expect(tool.name).toBe("security_zone_status");
    expect(tool.requiresWrite).toBe(false);
    expect(tool.requiresConfirmation).toBe(false);
  });

  it("GETs A4, with the area when one is named", async () => {
    const get = vi.fn().mockResolvedValue(reply(200, BODY));
    const ctx = ctxWith(get);
    const out = expectOk(await tool.handler({ area: "Back door" }, ctx));
    expect(get).toHaveBeenCalledWith("/api/security/assistant/areas", {
      params: { area: "Back door" },
      headers: { Accept: "application/json" },
      signal: ctx.signal,
    });
    expect(out.data).toEqual({ type: "security_areas", ...BODY });
    await tool.handler({}, ctx);
    expect(get.mock.calls[1]![1].params).toEqual({});
  });

  it.each([
    ["404 module_disabled", 404, { error: "module_disabled", module: "security" }, "SECURITY_UNAVAILABLE"],
    ["503", 503, {}, "SECURITY_UNREACHABLE"],
  ])("%s → %s", async (_label, status, body, code) => {
    const get = vi.fn().mockResolvedValue(reply(status, body));
    expect(expectErr(await tool.handler({}, ctxWith(get))).error.code).toBe(code);
  });

  it.each([
    ["an empty area", { area: "" }],
    ["a period (it is always now)", { period: "today" }],
  ])("%s → INVALID_ARGS with no call", async (_label, args) => {
    const get = vi.fn();
    expect(expectErr(await tool.handler(args as Record<string, unknown>, ctxWith(get))).error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});
