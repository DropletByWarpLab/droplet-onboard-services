import { describe, it, expect, vi } from "vitest";
import listDrives from "../../../src/handlers/system/list-drives.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1144: list_drives must hit the ORCHESTRATOR's /api/storage/drives —
// the same source of truth the dashboard's Drives page uses — not the
// file-indexer (which has no /drives route and whose default URL pointed at
// a port nothing listens on, so every chat tool call died as "fetch failed").
function ctxWithGet(get: ReturnType<typeof vi.fn>): ToolContext {
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

describe("list_drives", () => {
  it("fetches /api/storage/drives on the orchestrator and returns the drives + usage shape", async () => {
    // Mirror of the orchestrator route's response: bridge drives enriched
    // with the customer label join (apps/orchestrator/src/routes/storage.ts).
    const body = {
      drives: [
        {
          device: "/dev/nvme0n1p1",
          mount: "/mnt/droplet/media-1a2b",
          label: "media",
          uuid: "1a2b-3c4d",
          size_bytes: 1_000_000_000_000,
          used_bytes: 750_000_000_000,
          free_bytes: 250_000_000_000,
          mounted: true,
          bus: "nvme",
          displayName: "Media drive",
          icon: null,
          notes: null,
        },
      ],
      count: 1,
      snapshot_at: "2026-07-08T12:00:00Z",
    };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await listDrives.handler({}, ctxWithGet(get));
    expect(get).toHaveBeenCalledWith("/api/storage/drives", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as typeof body;
      expect(data).toEqual(body);
      // The agent needs usage numbers to answer "what's using the most storage?".
      expect(data.drives[0].size_bytes).toBeGreaterThan(0);
      expect(data.drives[0].used_bytes).toBeGreaterThan(0);
      expect(data.drives[0].free_bytes).toBeGreaterThan(0);
    }
  });

  it("surfaces DRIVES_UNAVAILABLE on a non-2xx response", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 502 }));
    const r = await listDrives.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("DRIVES_UNAVAILABLE");
      expect(r.error.message).toContain("502");
    }
  });

  it("returns an honest STORAGE_UNREACHABLE error when fetch throws — never raw 'fetch failed'", async () => {
    // undici throws TypeError("fetch failed") on ECONNREFUSED — exactly what
    // chat showed on the box (WARP-1144). The handler must translate it.
    const get = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const r = await listDrives.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("error");
      expect(r.error.code).toBe("STORAGE_UNREACHABLE");
      expect(r.error.message).toContain("storage service");
      expect(r.error.message).not.toContain("fetch failed");
    }
  });
});
