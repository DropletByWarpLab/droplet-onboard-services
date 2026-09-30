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
const BODY = { site: { mode: "closed" }, areas: [], moreAreas: 0, nextOffset: null, suggestionsWaiting: null };

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

  // WARP-3194 item 1: A4 trims to the tool-result cap; `nextOffset` is where the next page starts.
  it("GETs A4 from the offset A4 handed out, alone or with the area, and returns nextOffset", async () => {
    const page = { ...BODY, areas: [{ name: "Area 000" }], moreAreas: 3, nextOffset: 21 };
    const get = vi.fn().mockResolvedValue(reply(200, page));
    const ctx = ctxWith(get);
    const out = expectOk(await tool.handler({ offset: 21 }, ctx));
    expect(get).toHaveBeenCalledWith("/api/security/assistant/areas", {
      params: { offset: "21" },
      headers: { Accept: "application/json" },
      signal: ctx.signal,
    });
    expect(out.data).toEqual({ type: "security_areas", ...page });
    await tool.handler({ area: "Back door", offset: 0 }, ctx);
    expect(get.mock.calls[1]![1].params).toEqual({ area: "Back door", offset: "0" });
    await tool.handler({ offset: 64 }, ctx);
    expect(get.mock.calls[2]![1].params).toEqual({ offset: "64" });
  });

  it("the schema offers the offset, as tightly as the route takes it", () => {
    const props = (tool.inputSchema as { properties: Record<string, { type: string; description?: string }> }).properties;
    expect(Object.keys(props).sort()).toEqual(["area", "offset"]);
    expect(props.offset).toEqual({ type: "integer", description: "nextOffset of the last page" });
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
    ["a negative offset", { offset: -1 }],
    ["an offset past the 64-area limit", { offset: 65 }],
    ["a fractional offset", { offset: 1.5 }],
    ["an offset as text", { offset: "21" }],
    ["a cursor (A4 pages by offset)", { cursor: "21" }],
  ])("%s → INVALID_ARGS with no call", async (_label, args) => {
    const get = vi.fn();
    expect(expectErr(await tool.handler(args as Record<string, unknown>, ctxWith(get))).error.code).toBe("INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});
