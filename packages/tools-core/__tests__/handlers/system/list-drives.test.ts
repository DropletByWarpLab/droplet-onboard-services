import { describe, it, expect, vi } from "vitest";
import listDrives from "../../../src/handlers/system/list-drives.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      fileIndexer: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("list_drives", () => {
  it("returns the device-bridge /drives body", async () => {
    const body = { drives: [{ device: "/dev/nvme0n1p1", used: 100, free: 900 }] };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await listDrives.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    expect(get).toHaveBeenCalledWith("/drives", expect.anything());
  });
});
