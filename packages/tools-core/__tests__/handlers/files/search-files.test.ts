import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import searchFiles from "../../../src/handlers/files/search-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(get: Mock, opts: { ncToken?: string; userId?: string } = {}): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: opts.userId ?? "alice",
    ncToken: opts.ncToken ?? "tok",
    signal: new AbortController().signal,
  };
}

describe("search_files", () => {
  it("rejects empty query", async () => {
    const r = await searchFiles.handler({ query: "  " }, ctxWith(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("requires auth", async () => {
    const r = await searchFiles.handler({ query: "x" }, ctxWith(vi.fn(), { ncToken: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
  });

  // WARP-1012 — regression. The files API route (`GET /api/files/search`)
  // requires the search term in `q`, NOT `query`; sending `query=` made the
  // route 400 before auth was even consulted ("nextcloud returned 400" in
  // the live repro). And the `_service:mcp` principal must assert the acting
  // user via X-Nextcloud-User — the route hard-rejects (401) without it.
  it("calls the files API /search with q, limit, and BOTH per-user headers", async () => {
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await searchFiles.handler({ query: "todo" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      "/search?q=todo&limit=50",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": "tok",
          "X-Nextcloud-User": "alice",
        }),
      }),
    );
  });

  it("never sends the pre-WARP-1012 `query=` param name", async () => {
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await searchFiles.handler({ query: "todo" }, ctxWith(get));
    const [calledPath] = get.mock.calls[0] as [string];
    expect(calledPath).not.toContain("query=");
  });

  it("url-encodes the search term", async () => {
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await searchFiles.handler({ query: "tax 2026 & receipts" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      `/search?q=${encodeURIComponent("tax 2026 & receipts")}&limit=50`,
      expect.anything(),
    );
  });

  it("surfaces upstream failure statuses as SEARCH_FAILED", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    const r = await searchFiles.handler({ query: "todo" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SEARCH_FAILED");
      expect(r.error.message).toBe("nextcloud returned 400");
    }
  });
});
