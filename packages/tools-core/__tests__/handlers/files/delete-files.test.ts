// WARP-2664 — delete_files: validate everything, resolve every path in its
// parent listing, delete FILES to trash, refuse directories outright.
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import deleteFiles, { DELETE_FILES_MAX_PATHS } from "../../../src/handlers/files/delete-files.js";
import type { ToolContext } from "../../../src/types.js";

// Full argument lists on purpose: `vi.fn(async () => …)` types `mock.calls`
// as the empty tuple, so `calls[i][1]` is a tsc error vitest cannot see.
type Opts = { headers?: Record<string, string>; signal?: AbortSignal } | undefined;

/**
 * A call cut short by the caller's own signal while in flight — a cancel
 * arriving during a slow Nextcloud round-trip. Resolves 200 at once if no
 * signal was forwarded, so a handler that forgot to forward it fails the
 * assertion cleanly instead of hanging the suite.
 */
function abortedInFlight(controller: AbortController) {
  return (opts?: Opts): Promise<Response> => {
    if (!opts?.signal) return Promise.resolve(new Response("{}", { status: 200 }));
    const signal = opts.signal;
    return new Promise<Response>((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      controller.abort();
    });
  };
}

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
    { path: "/Downloads/c.tmp" },
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

  // The emptiness probe this flag used to gate was satisfiable by an OUTAGE:
  // GET /api/files answers 200 [] when Nextcloud is unreachable, so a full
  // folder read as empty and got recursively trashed. The flag is gone.
  it("exposes no allow_folders escape hatch", () => {
    const schema = deleteFiles.inputSchema as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties)).toEqual(["paths"]);
    expect(schema.additionalProperties).toBe(false);
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
    // THE ordering guarantee: a bad entry LATE in the list must not leave the
    // earlier, valid ones deleted.
    expect(get).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  // Tested from BELOW as well as above, so an off-by-one that refuses the
  // documented maximum cannot pass.
  it("accepts exactly DELETE_FILES_MAX_PATHS paths", async () => {
    const paths = Array.from({ length: DELETE_FILES_MAX_PATHS }, (_, i) => `/Bulk/f${i}.tmp`);
    const del = okDelete();
    const r = await deleteFiles.handler(
      { paths },
      ctxWith({ get: treeGet({ "/Bulk": paths.map((p) => ({ path: p })) }), del }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).counts.deleted).toBe(DELETE_FILES_MAX_PATHS);
    expect(del).toHaveBeenCalledTimes(DELETE_FILES_MAX_PATHS);
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
    expect(d.caveat).toBeUndefined();
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

  // A "not found" that is really an outage looks identical to a file that is
  // genuinely gone, so the result has to say so.
  it("caveats a not-found that an empty (possibly degraded) listing could explain", async () => {
    const del = okDelete();
    const r = await deleteFiles.handler(
      { paths: ["/Downloads/a.tmp"] },
      ctxWith({ get: treeGet({ "/Downloads": [] }), del }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.failed).toEqual([{ path: "/Downloads/a.tmp", reason: "not found" }]);
    expect(d.caveat).toMatch(/unreachable file service/i);
    expect(del).not.toHaveBeenCalled();
  });

  describe("directories are refused outright", () => {
    it("skips an EMPTY directory and never issues a DELETE for it", async () => {
      const get = treeGet(TREE);
      const del = okDelete();
      const r = await deleteFiles.handler({ paths: ["/Downloads/Empty"] }, ctxWith({ get, del }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as any).skipped).toEqual([
        { path: "/Downloads/Empty", reason: expect.stringMatching(/is a folder/) },
      ]);
      expect(del).not.toHaveBeenCalled();
      // No second listing: with no emptiness inference there is nothing to probe.
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("skips a directory WITH contents just the same", async () => {
      const del = okDelete();
      const r = await deleteFiles.handler({ paths: ["/Downloads/Full"] }, ctxWith({ get: treeGet(TREE), del }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as any).counts).toEqual({ deleted: 0, skipped: 1, failed: 0 });
      expect(del).not.toHaveBeenCalled();
    });

    // delete_file is confirmation-gated since WARP-2669 but still recursive
    // for directories, and this layer cannot verify what a folder holds, so
    // the refusal must not route the model to it.
    it("does not point the model at delete_file", async () => {
      const r = await deleteFiles.handler(
        { paths: ["/Downloads/Full"] },
        ctxWith({ get: treeGet(TREE), del: okDelete() }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const reason = (r.data as any).skipped[0].reason as string;
      expect(reason).not.toMatch(/delete_file/);
      expect(reason).toMatch(/Files app/);
      expect(deleteFiles.description).not.toMatch(/delete_file\b/);
    });

    it("keeps deleting the files in the same list", async () => {
      const del = okDelete();
      const r = await deleteFiles.handler(
        { paths: ["/Downloads/Full", "/Downloads/a.tmp"] },
        ctxWith({ get: treeGet(TREE), del }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as any).deleted).toEqual(["/Downloads/a.tmp"]);
      expect(del).toHaveBeenCalledTimes(1);
    });
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

  describe("cancellation", () => {
    it("does not attempt anything when the signal is already aborted", async () => {
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

    // PR #1985 review: HttpClient takes a signal and none was forwarded, so
    // a cancel could not interrupt a slow delete already in flight — it ran
    // to completion after the caller had given up.
    it("a DELETE cut short by the signal is reported as unknown, and the rest are not attempted", async () => {
      const controller = new AbortController();
      const get = treeGet(TREE);
      const del = vi.fn((_path: string, opts?: Opts) => abortedInFlight(controller)(opts));
      const r = await deleteFiles.handler(
        { paths: ["/Downloads/a.tmp", "/Downloads/b.tmp", "/Downloads/c.tmp"] },
        ctxWith({ get, del }, { signal: controller.signal }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as Record<string, any>;
      expect(del).toHaveBeenCalledTimes(1);
      expect(d.deleted).toEqual([]);
      // Unknown outcome is reported as such, never as deleted.
      expect(d.failed).toEqual([{ path: "/Downloads/a.tmp", reason: expect.stringMatching(/in flight/) }]);
      expect(d.skipped).toEqual([
        { path: "/Downloads/b.tmp", reason: expect.stringMatching(/cancelled/) },
        { path: "/Downloads/c.tmp", reason: expect.stringMatching(/cancelled/) },
      ]);
      for (const call of [...get.mock.calls, ...del.mock.calls]) {
        expect(call[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
      }
    });

    // The per-iteration check is the whole point on the tool that removes
    // data: hoisting it out of the loop must turn this red.
    it("STOPS PARTWAY when aborted mid-run, leaving the rest unattempted", async () => {
      const controller = new AbortController();
      const del = vi.fn(async (_path: string, _opts?: Opts) => {
        controller.abort();
        return new Response("{}", { status: 200 });
      });
      const r = await deleteFiles.handler(
        { paths: ["/Downloads/a.tmp", "/Downloads/b.tmp", "/Downloads/c.tmp"] },
        ctxWith({ get: treeGet(TREE), del }, { signal: controller.signal }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as Record<string, any>;
      expect(del).toHaveBeenCalledTimes(1);
      expect(d.deleted).toEqual(["/Downloads/a.tmp"]);
      expect(d.skipped).toEqual([
        { path: "/Downloads/b.tmp", reason: expect.stringMatching(/cancelled/) },
        { path: "/Downloads/c.tmp", reason: expect.stringMatching(/cancelled/) },
      ]);
      expect(d.counts).toEqual({ deleted: 1, skipped: 2, failed: 0 });
    });
  });

  it("never calls POST", async () => {
    const post = vi.fn();
    await deleteFiles.handler({ paths: ["/Downloads/a.tmp"] }, ctxWith({ get: treeGet(TREE), del: okDelete(), post }));
    expect(post).not.toHaveBeenCalled();
  });

  // PR #1985 review: a bare "%" is a filename character, not an encoding
  // error. Until _paths.ts learned that, this one name aborted the WHOLE
  // batch — the other paths were never attempted.
  it("deletes a file whose name holds a bare %, alongside the rest of the batch", async () => {
    const del = okDelete();
    const r = await deleteFiles.handler(
      { paths: ["/Downloads/50% Off Report.pdf", "/Downloads/a.tmp"] },
      ctxWith({
        get: treeGet({ "/Downloads": [{ path: "/Downloads/50% Off Report.pdf" }, { path: "/Downloads/a.tmp" }] }),
        del,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).deleted).toEqual(["/Downloads/50% Off Report.pdf", "/Downloads/a.tmp"]);
    expect(del.mock.calls.map((c) => c[0])).toEqual([
      `/?path=${encodeURIComponent("/Downloads/50% Off Report.pdf")}`,
      `/?path=${encodeURIComponent("/Downloads/a.tmp")}`,
    ]);
  });

});
