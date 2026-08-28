import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listStoragePools from "../../../src/handlers/system/list-storage-pools.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1144: list_storage_pools shares list_drives' dispatch path and shared
// its bug — it must hit the ORCHESTRATOR's /api/storage/pools (the Drives
// page's source of truth), not the file-indexer.
function ctxWithGet(get: Mock): ToolContext {
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

describe("list_storage_pools", () => {
  it("fetches /api/storage/pools on the orchestrator and returns the pools shape", async () => {
    // Mirror of the orchestrator route's response: bridge pools enriched with
    // the owner label join (apps/orchestrator/src/routes/storage.ts).
    const body = {
      pools: [
        {
          device: "md0",
          level: "raid1",
          status: "active",
          members: ["/dev/sda", "/dev/sdb"],
          displayName: "Backups",
          notes: null,
        },
      ],
      count: 1,
      snapshot_at: "2026-07-08T12:00:00Z",
    };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await listStoragePools.handler({}, ctxWithGet(get));
    expect(get).toHaveBeenCalledWith("/api/storage/pools", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(body);
  });

  it("passes through the honest empty list when no pool exists (ADR-019 D2)", async () => {
    const body = { pools: [], count: 0 };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await listStoragePools.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(body);
  });

  it("surfaces POOLS_UNAVAILABLE on a non-2xx response", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 502 }));
    const r = await listStoragePools.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("POOLS_UNAVAILABLE");
      expect(r.error.message).toContain("502");
    }
  });

  it("returns an honest STORAGE_UNREACHABLE error when fetch throws — never raw 'fetch failed'", async () => {
    const get = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const r = await listStoragePools.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("error");
      expect(r.error.code).toBe("STORAGE_UNREACHABLE");
      expect(r.error.message).not.toContain("fetch failed");
    }
  });
});
