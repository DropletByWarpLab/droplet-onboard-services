import { describe, it, expect, vi } from "vitest";
import listFiles from "../../../src/handlers/files/list-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(get: ReturnType<typeof vi.fn>, ncToken?: string): ToolContext {
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
    ncToken,
    signal: new AbortController().signal,
  };
}

describe("list_files", () => {
  it("defaults path to /, includes ncToken header", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ entries: [{ name: "a.txt" }] }), { status: 200 }),
    );
    const ctx = ctxWith(get, "ncT-abc");
    const r = await listFiles.handler({}, ctx);
    expect(get).toHaveBeenCalledWith(
      "/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Nextcloud-Token": "ncT-abc" }),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("forwards a non-default path", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await listFiles.handler({ path: "/photos" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith("/photos", expect.anything());
  });
});
