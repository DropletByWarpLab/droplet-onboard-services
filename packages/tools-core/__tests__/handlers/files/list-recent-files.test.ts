import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listRecentFiles from "../../../src/handlers/files/list-recent-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(get: Mock, ncToken?: string): ToolContext {
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
    userId: "alice",
    ncToken,
    signal: new AbortController().signal,
  };
}

describe("list_recent_files", () => {
  it("requires auth", async () => {
    const r = await listRecentFiles.handler({}, ctxWith(vi.fn(), ""));
    expect(r.ok).toBe(false);
  });

  // WARP-1012 — regression. The `_service:mcp` principal must assert the
  // acting user via X-Nextcloud-User on every files-API call; the route's
  // getUser() hard-rejects the service principal without it (the live
  // "nextcloud returned 401"). Token alone is NOT enough.
  it("calls /recents?limit=30 with BOTH per-user headers", async () => {
    const get = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    await listRecentFiles.handler({}, ctxWith(get, "tok"));
    expect(get).toHaveBeenCalledWith(
      "/recents?limit=30",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": "tok",
          "X-Nextcloud-User": "alice",
        }),
      }),
    );
  });

  it("surfaces upstream failure statuses as RECENT_FAILED", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const r = await listRecentFiles.handler({}, ctxWith(get, "tok"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("RECENT_FAILED");
      expect(r.error.message).toBe("nextcloud returned 401");
    }
  });
});
