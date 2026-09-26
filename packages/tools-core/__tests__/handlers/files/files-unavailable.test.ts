/**
 * WARP-3077 — a files-API answer marked `X-Droplet-Degraded` (the route's
 * Nextcloud-outage fallback, WARP-3052) must reach the model as
 * FILES_UNAVAILABLE, never as an empty result. A genuinely empty answer (no
 * header) still reads as empty.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listFiles from "../../../src/handlers/files/list-files.js";
import listRecentFiles from "../../../src/handlers/files/list-recent-files.js";
import organizeFiles from "../../../src/handlers/files/organize-files.js";
import analyzeFileCleanup from "../../../src/handlers/files/analyze-file-cleanup.js";
import deleteFiles from "../../../src/handlers/files/delete-files.js";
import { FILES_UNAVAILABLE_MESSAGE } from "../../../src/handlers/files/_unavailable.js";
import type { Tool, ToolContext } from "../../../src/types.js";

function ctxWith(get: Mock, del: Mock = vi.fn()): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: del },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    ncToken: "tok",
    signal: new AbortController().signal,
  };
}

const degraded = (body: string) =>
  vi.fn(async () => new Response(body, {
    status: 200,
    headers: { "X-Droplet-Degraded": "nextcloud-unavailable" },
  }));
const empty = (body: string) => vi.fn(async () => new Response(body, { status: 200 }));

const cases: Array<{ tool: Tool; args: Record<string, unknown>; body: string }> = [
  { tool: listFiles, args: { path: "/" }, body: "[]" },
  { tool: listRecentFiles, args: {}, body: '{"items":[]}' },
  { tool: organizeFiles, args: { path: "/Downloads" }, body: "[]" },
  { tool: analyzeFileCleanup, args: { path: "/" }, body: "[]" },
  { tool: deleteFiles, args: { paths: ["/Downloads/a.tmp"] }, body: "[]" },
];

describe.each(cases)("$tool.name against a degraded files API", ({ tool, args, body }) => {
  it("returns FILES_UNAVAILABLE with the user-facing message", async () => {
    const del = vi.fn();
    const r = await tool.handler(args, ctxWith(degraded(body), del));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("error");
      expect(r.error.code).toBe("FILES_UNAVAILABLE");
      expect(r.error.message).toBe(FILES_UNAVAILABLE_MESSAGE);
    }
    expect(del).not.toHaveBeenCalled();
  });

  it("does not report unavailable for a genuinely empty answer", async () => {
    const r = await tool.handler(args, ctxWith(empty(body)));
    if (!r.ok) expect(r.error.code).not.toBe("FILES_UNAVAILABLE");
  });
});

describe("genuinely empty stays empty", () => {
  it("list_files returns the empty listing", async () => {
    const r = await listFiles.handler({ path: "/" }, ctxWith(empty("[]")));
    expect(r).toEqual({ ok: true, data: [] });
  });

  it("list_recent_files returns the empty items", async () => {
    const r = await listRecentFiles.handler({}, ctxWith(empty('{"items":[]}')));
    expect(r).toEqual({ ok: true, data: { items: [] } });
  });
});
