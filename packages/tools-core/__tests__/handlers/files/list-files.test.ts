import { describe, it, expect, vi } from "vitest";
import listFiles from "../../../src/handlers/files/list-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  get: ReturnType<typeof vi.fn>,
  opts: { ncToken?: string; userId?: string } = {},
): ToolContext {
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
    userId: opts.userId === undefined ? "alice" : opts.userId,
    ncToken: opts.ncToken === undefined ? "ncT-abc" : opts.ncToken,
    signal: new AbortController().signal,
  };
}

describe("list_files", () => {
  it("defaults path to /, includes auth headers", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ entries: [{ name: "a.txt" }] }), { status: 200 }),
    );
    const r = await listFiles.handler({}, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      `/?path=${encodeURIComponent("/")}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcloud-Token": "ncT-abc",
          "X-Nextcloud-User": "alice",
        }),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("forwards a non-default path", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await listFiles.handler({ path: "/photos" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(`/?path=${encodeURIComponent("/photos")}`, expect.anything());
  });

  // TOOLS-03: auth gate — the raw path is used as the entire WebDAV URL
  // path, so an unauthenticated list must be refused before any call.
  it("returns AUTH_REQUIRED without ncToken", async () => {
    const get = vi.fn();
    const r = await listFiles.handler({ path: "/photos" }, ctxWith(get, { ncToken: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without userId", async () => {
    const get = vi.fn();
    const r = await listFiles.handler({ path: "/photos" }, ctxWith(get, { userId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  // WARP-1373: gpt-oss writes directory paths with a trailing slash
  // routinely; that form used to fail with INVALID_PATH "empty path
  // segment" and cost a wasted agent-loop iteration.
  it("accepts a trailing-slash directory path and lists the same dir", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await listFiles.handler({ path: "/Home/Maintenance/" }, ctxWith(get));
    expect(r.ok).toBe(true);
    expect(get).toHaveBeenCalledWith(
      `/?path=${encodeURIComponent("/Home/Maintenance")}`,
      expect.anything(),
    );
  });

  it("collapses duplicate separators", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await listFiles.handler({ path: "//Home//Maintenance//" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(
      `/?path=${encodeURIComponent("/Home/Maintenance")}`,
      expect.anything(),
    );
  });

  it("still lists root for a bare '/'", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await listFiles.handler({ path: "/" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith(`/?path=${encodeURIComponent("/")}`, expect.anything());
  });

  // TOOLS-03: traversal rejection at the tool boundary. `..`/absolute
  // segments could resolve outside the WebDAV prefix via new URL(path).
  for (const bad of [
    "/../etc",
    "/foo/../../bar",
    "/x\0y",
    "/Notes/%2e%2e/admin",
    "/Notes/%252e%252e/admin",
    "/Notes/..\\admin",
    "/Notes/%zz",
    // WARP-1373: the trailing-slash strip must not weaken the guard.
    "/Notes/../",
    "/Notes/%2e%2e/",
  ]) {
    it(`rejects malformed path ${JSON.stringify(bad)} with INVALID_PATH`, async () => {
      const get = vi.fn();
      const r = await listFiles.handler({ path: bad }, ctxWith(get));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
      expect(get).not.toHaveBeenCalled();
    });
  }
});
