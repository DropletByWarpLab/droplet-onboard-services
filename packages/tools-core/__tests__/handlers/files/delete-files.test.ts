// WARP-2664 — delete_files: validate everything, look every path up in its
// parent's listing, delete to trash, refuse folders unless empty + allowed.
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import deleteFiles, { DELETE_FILES_MAX_PATHS } from "../../../src/handlers/files/delete-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  mocks: { get?: Mock; del?: Mock; post?: Mock },
  opts: { ncToken?: string; userId?: string; signal?: AbortSignal } = {},
): ToolContext {
  return {
    http: {
      nextcloud: {
        get: mocks.get ?? vi.fn(),
        post: mocks.post ?? vi.fn(),
        patch: vi.fn(),
        delete: mocks.del ?? vi.fn(),
      },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      orchestrator: {} as ToolContext["http"]["orchestrator"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: opts.userId === undefined ? "alice" : opts.userId,
    ncToken: opts.ncToken === undefined ? "tok" : opts.ncToken,
    signal: opts.signal ?? new AbortController().signal,
  };
}

type Row = { path: string; isDirectory?: boolean };
// Full argument lists on purpose: `vi.fn(async () => …)` types `mock.calls`
// as the empty tuple, so `calls[i][1]` is a tsc error vitest cannot see.
type Opts = { headers?: Record<string, string> } | undefined;

function treeGet(tree: Record<string, Row[] | number>) {
  return vi.fn(async (url: string, _opts?: Opts) => {
    const m = /^\/\?path=(.*)$/.exec(url);
    const dir = m ? decodeURIComponent(m[1]) : "";
    const node = tree[dir];
    if (typeof node === "number") return new Response("{}", { status: node });
    if (!node) return new Response("[]", { status: 404 });
    const body = node.map((r) => ({
      name: r.path.split("/").pop(),
      isDirectory: r.isDirectory === true,
      size: 1,
      mimeType: r.isDirectory ? null : "text/plain",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      ...r,
    }));
    return new Response(JSON.stringify(body), { status: 200 });
  });
}
const okDelete = () =>
  vi.fn(async (_path: string, _opts?: Opts) => new Response("{}", { status: 200 }));

const TREE: Record<string, Row[] | number> = {
  "/Downloads": [
    { path: "/Downloads/a.tmp" },
    { path: "/Downloads/b.tmp" },
    { path: "/Downloads/Empty", isDirectory: true },
    { path: "/Downloads/Full", isDirectory: true },
  ],
  "/Downloads/Empty": [],
  "/Downloads/Full": [{ path: "/Downloads/Full/keep.txt" }],
  "/Docs": [{ path: "/Docs/old.bak" }],
};

describe("delete_files", () => {
  it("is Write-tier with interceptor-owned confirmation and NO confirmed flag in its schema", () => {
    expect(deleteFiles.requiresWrite).toBe(true);
    expect(deleteFiles.requiresConfirmation).toBe(true);
    const props = (deleteFiles.inputSchema as { properties: Record<string, unknown> }).properties;
    expect("confirmed" in props).toBe(false);
  });

  it("returns AUTH_REQUIRED without ncToken / userId, before any HTTP", async () => {
    for (const opts of [{ ncToken: "" }, { userId: "" }]) {
      const get = vi.fn();
      const del = vi.fn();
      const r = await deleteFiles.handler({ paths: ["/Downloads/a.tmp"] }, ctxWith({ get, del }, opts));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
      expect(get).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    }
  });

  it("validates the whole list before touching anything", async () => {
    const get = vi.fn();
    const del = vi.fn();
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{}, "INVALID_ARGS", /non-empty array/],
      [{ paths: [] }, "INVALID_ARGS", /non-empty array/],
      [{ paths: "/x" }, "INVALID_ARGS", /non-empty array/],
      [{ paths: new Array(DELETE_FILES_MAX_PATHS + 1).fill("/x") }, "INVALID_ARGS", /at most 100/],
      [{ paths: ["/Downloads/a.tmp", "/../etc/passwd"] }, "INVALID_PATH", /paths\[1\]/],
      [{ paths: ["/Downloads/a.tmp", 7] }, "INVALID_PATH", /paths\[1\]/],
      [{ paths: ["/Downloads/a.tmp", "/"] }, "INVALID_PATH", /paths\[1\].*top-level/],
    ];
    for (const [args, code, msg] of cases) {
      const r = await deleteFiles.handler(args, ctxWith({ get, del }));
      expect(r.ok, JSON.stringify(args).slice(0, 60)).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe(code);
        expect(r.error.message).toMatch(msg);
      }
    }
    expect(get).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("deletes files it finds in the parent listing, listing each parent once, with the acting-user headers", async () => {
    const get = treeGet(TREE);
    const del = okDelete();
    const r = await deleteFiles.handler(
      { paths: ["/Downloads/a.tmp", "/Downloads/b.tmp/", "/Docs/old.bak", "/Downloads/a.tmp"] },
      ctxWith({ get, del }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Two distinct parents → two GETs; the duplicate path is collapsed.
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      `/?path=${encodeURIComponent("/Downloads")}`,
      `/?path=${encodeURIComponent("/Docs")}`,
    ]);
    expect(del.mock.calls.map((c) => c[0])).toEqual([
      `/?path=${encodeURIComponent("/Downloads/a.tmp")}`,
      `/?path=${encodeURIComponent("/Downloads/b.tmp")}`,
      `/?path=${encodeURIComponent("/Docs/old.bak")}`,
    ]);
    for (const call of [...get.mock.calls, ...del.mock.calls]) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Nextcloud-Token": "tok", "X-Nextcloud-User": "alice" }),
        }),
      );
    }

    const d = r.data as Record<string, any>;
    expect(d.deleted).toEqual(["/Downloads/a.tmp", "/Downloads/b.tmp", "/Docs/old.bak"]);
    expect(d.skipped).toEqual([]);
    expect(d.failed).toEqual([]);
    expect(d.counts).toEqual({ deleted: 3, skipped: 0, failed: 0 });
    expect(d.note).toMatch(/trash/);
  });

  it("reports a path missing from its parent listing as failed: not found, without a DELETE", async () => {
    const del = okDelete();
    const r = await deleteFiles.handler({ paths: ["/Downloads/ghost.tmp"] }, ctxWith({ get: treeGet(TREE), del }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).failed).toEqual([{ path: "/Downloads/ghost.tmp", reason: "not found" }]);
    expect(del).not.toHaveBeenCalled();
  });

  it("reports an unreadable parent as failed, without a DELETE", async () => {
    const del = okDelete();
    const r = await deleteFiles.handler(
      { paths: ["/Broken/x.tmp"] },
      ctxWith({ get: treeGet({ "/Broken": 500 }), del }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).failed).toEqual([
      { path: "/Broken/x.tmp", reason: "could not read /Broken (nextcloud returned 500)" },
    ]);
    expect(del).not.toHaveBeenCalled();
  });

  it("skips a folder unless allow_folders is set — never a recursive trash by accident", async () => {
    const del = okDelete();
    const r = await deleteFiles.handler({ paths: ["/Downloads/Empty"] }, ctxWith({ get: treeGet(TREE), del }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).skipped).toEqual([
      { path: "/Downloads/Empty", reason: expect.stringMatching(/allow_folders: true.*delete_file/) },
    ]);
    expect(del).not.toHaveBeenCalled();
  });

  it("with allow_folders, deletes an EMPTY folder and skips one with contents", async () => {
    const get = treeGet(TREE);
    const del = okDelete();
    const r = await deleteFiles.handler(
      { paths: ["/Downloads/Empty", "/Downloads/Full"], allow_folders: true },
      ctxWith({ get, del }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.deleted).toEqual(["/Downloads/Empty"]);
    expect(d.skipped).toEqual([
      { path: "/Downloads/Full", reason: "folder is not empty; use delete_file to delete it with its contents" },
    ]);
    // Parent once, then each folder once to check emptiness.
    expect(get.mock.calls.map((c) => decodeURIComponent(String(c[0]).slice("/?path=".length)))).toEqual([
      "/Downloads",
      "/Downloads/Empty",
      "/Downloads/Full",
    ]);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("a DELETE the server refuses is reported as failed and the rest continue", async () => {
    const del = vi.fn(async (url: string, _opts?: Opts) =>
      new Response("{}", { status: url.includes(encodeURIComponent("/Downloads/a.tmp")) ? 423 : 200 }),
    );
    const r = await deleteFiles.handler(
      { paths: ["/Downloads/a.tmp", "/Downloads/b.tmp"] },
      ctxWith({ get: treeGet(TREE), del }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.failed).toEqual([{ path: "/Downloads/a.tmp", reason: "nextcloud returned 423" }]);
    expect(d.deleted).toEqual(["/Downloads/b.tmp"]);
  });

  it("does not attempt anything once the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const get = vi.fn();
    const del = vi.fn();
    const r = await deleteFiles.handler(
      { paths: ["/Downloads/a.tmp"] },
      ctxWith({ get, del }, { signal: controller.signal }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).skipped).toEqual([
      { path: "/Downloads/a.tmp", reason: expect.stringMatching(/cancelled/) },
    ]);
    expect(get).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("never calls POST", async () => {
    const post = vi.fn();
    await deleteFiles.handler({ paths: ["/Downloads/a.tmp"] }, ctxWith({ get: treeGet(TREE), del: okDelete(), post }));
    expect(post).not.toHaveBeenCalled();
  });
});
