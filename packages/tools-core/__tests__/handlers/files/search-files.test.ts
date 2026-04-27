import { describe, it, expect, vi } from "vitest";
import searchFiles from "../../../src/handlers/files/search-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(get: ReturnType<typeof vi.fn>, opts: { ncToken?: string; userId?: string } = {}): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
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

  it("calls nextcloud /search with query and limit", async () => {
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await searchFiles.handler({ query: "todo" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      "/search?query=todo&limit=50",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Nextcloud-Token": "tok" }) }),
    );
  });
});
