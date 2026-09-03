// WARP-2664 — organize_files: one fresh listing, mkdir per destination,
// move per direct-child file, never an overwrite, never a delete.
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import organizeFiles from "../../../src/handlers/files/organize-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  mocks: { get?: Mock; post?: Mock; del?: Mock },
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

type Row = { path: string; isDirectory?: boolean; size?: number; mimeType?: string | null; modifiedAt?: string };
function row(path: string, o: Omit<Row, "path"> = {}): Row {
  return {
    path,
    isDirectory: false,
    size: 10,
    mimeType: "application/octet-stream",
    modifiedAt: "2024-03-09T10:00:00.000Z",
    ...o,
  };
}
// Mocks declare the full HttpClient argument list rather than taking none:
// `vi.fn(async () => …)` types `mock.calls` as the empty tuple, so every
// `calls[i][1]` assertion below is a tsc error the (type-stripping) vitest
// run cannot see.
type Opts = { headers?: Record<string, string> } | undefined;

function listingOf(rows: Row[], status = 200) {
  return vi.fn(async (_path: string, _opts?: Opts) =>
    new Response(JSON.stringify(rows.map((r) => ({ name: r.path.split("/").pop(), ...r }))), { status }),
  );
}
const okPost = () =>
  vi.fn(async (_path: string, _body?: unknown, _opts?: Opts) => new Response("{}", { status: 200 }));

const DOWNLOADS: Row[] = [
  row("/Downloads/a.pdf"),
  row("/Downloads/b.JPG"),
  row("/Downloads/c.png"),
  row("/Downloads/.hidden"),
  row("/Downloads/Old", { isDirectory: true, size: 0, mimeType: null }),
];

describe("organize_files", () => {
  it("is Write-tier with interceptor-owned confirmation and NO confirmed flag in its schema", () => {
    expect(organizeFiles.requiresWrite).toBe(true);
    expect(organizeFiles.requiresConfirmation).toBe(true);
    // Fail-closed on purpose: with no `confirmed` property the legacy
    // boolean path is unavailable and only a human-minted token gets through
    // (docs/tool-confirmation-contract.md §3).
    const props = (organizeFiles.inputSchema as { properties: Record<string, unknown> }).properties;
    expect("confirmed" in props).toBe(false);
  });

  it("returns AUTH_REQUIRED without ncToken / userId, before any HTTP", async () => {
    for (const opts of [{ ncToken: "" }, { userId: "" }]) {
      const get = vi.fn();
      const r = await organizeFiles.handler({ path: "/Downloads" }, ctxWith({ get }, opts));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("requires a path, refuses root and traversal, and rejects an unknown rule — all before HTTP", async () => {
    const get = vi.fn();
    const post = vi.fn();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "INVALID_PATH"],
      [{ path: "/" }, "INVALID_PATH"],
      [{ path: "/Downloads/../" }, "INVALID_PATH"],
      [{ path: "/Downloads", rule: "by_mood" }, "INVALID_ARGS"],
    ];
    for (const [args, code] of cases) {
      const r = await organizeFiles.handler(args, ctxWith({ get, post }));
      expect(r.ok, JSON.stringify(args)).toBe(false);
      if (!r.ok) expect(r.error.code, JSON.stringify(args)).toBe(code);
    }
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("maps a 404 listing to NOT_FOUND and other failures to LIST_FAILED, with no writes", async () => {
    const post = vi.fn();
    const missing = await organizeFiles.handler({ path: "/Nope" }, ctxWith({ get: listingOf([], 404), post }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
    const broken = await organizeFiles.handler({ path: "/D" }, ctxWith({ get: listingOf([], 502), post }));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.code).toBe("LIST_FAILED");
    expect(post).not.toHaveBeenCalled();
  });

  it("creates each destination once, moves only direct-child files with overwrite:false, skips hidden files and folders", async () => {
    const get = listingOf(DOWNLOADS);
    const post = okPost();
    const r = await organizeFiles.handler({ path: "/Downloads/" }, ctxWith({ get, post }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(get).toHaveBeenCalledWith(
      `/?path=${encodeURIComponent("/Downloads")}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Nextcloud-Token": "tok", "X-Nextcloud-User": "alice" }),
      }),
    );
    const posts = post.mock.calls.map((c) => [c[0], c[1]]);
    expect(posts).toEqual([
      ["/mkdir", { path: "/Downloads/Documents" }],
      ["/mkdir", { path: "/Downloads/Images" }],
      ["/move", { from: "/Downloads/a.pdf", to: "/Downloads/Documents/a.pdf", overwrite: false }],
      ["/move", { from: "/Downloads/b.JPG", to: "/Downloads/Images/b.JPG", overwrite: false }],
      ["/move", { from: "/Downloads/c.png", to: "/Downloads/Images/c.png", overwrite: false }],
    ]);
    for (const call of post.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ "X-Nextcloud-User": "alice" }) }));
    }

    const d = r.data as Record<string, any>;
    expect(d.rule).toBe("by_type");
    expect(d.moved_count).toBe(3);
    expect(d.moved).toHaveLength(3);
    expect(d.created_folders).toEqual(["/Downloads/Documents", "/Downloads/Images"]);
    expect(d.skipped).toEqual([{ path: "/Downloads/.hidden", reason: "hidden file" }]);
    expect(d.remaining).toBe(0);
    expect(d.note).toMatch(/nothing was deleted/);
  });

  it("a failed move is reported as skipped and the rest still move", async () => {
    const post = vi.fn(async (url: string, body?: unknown, _opts?: Opts) =>
      new Response("{}", {
        status: url === "/move" && (body as { to?: string })?.to?.endsWith("b.JPG") ? 500 : 200,
      }),
    );
    const r = await organizeFiles.handler({ path: "/Downloads" }, ctxWith({ get: listingOf(DOWNLOADS), post }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.moved_count).toBe(2);
    expect(d.skipped).toContainEqual({
      path: "/Downloads/b.JPG",
      reason: expect.stringMatching(/move failed \(nextcloud returned 500\)/),
    });
  });

  it("a failed mkdir is not fatal (the folder usually already exists on a re-run)", async () => {
    const post = vi.fn(async (url: string, _body?: unknown, _opts?: Opts) =>
      new Response("{}", { status: url === "/mkdir" ? 500 : 200 }),
    );
    const r = await organizeFiles.handler({ path: "/Downloads" }, ctxWith({ get: listingOf(DOWNLOADS), post }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.created_folders).toEqual([]);
    expect(d.moved_count).toBe(3);
  });

  it("is a no-op with no writes when nothing sits directly inside the folder", async () => {
    const post = vi.fn();
    const r = await organizeFiles.handler(
      { path: "/Downloads" },
      ctxWith({
        get: listingOf([row("/Downloads/Images", { isDirectory: true }), row("/Downloads/.hidden")]),
        post,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(post).not.toHaveBeenCalled();
    expect(d.moved_count).toBe(0);
    expect(d.note).toMatch(/Nothing to organize/);
  });

  it("by_month files by modification month", async () => {
    const post = okPost();
    const r = await organizeFiles.handler(
      { path: "/Downloads", rule: "by_month" },
      ctxWith({ get: listingOf([row("/Downloads/a.pdf")]), post }),
    );
    expect(r.ok).toBe(true);
    expect(post.mock.calls[0]).toEqual(["/mkdir", { path: "/Downloads/2024-03" }, expect.anything()]);
    expect(post.mock.calls[1][1]).toEqual({ from: "/Downloads/a.pdf", to: "/Downloads/2024-03/a.pdf", overwrite: false });
  });

  it("stops moving once the request is aborted and counts the rest as remaining", async () => {
    const controller = new AbortController();
    const post = vi.fn(async (url: string, _body?: unknown, _opts?: Opts) => {
      if (url === "/move") controller.abort();
      return new Response("{}", { status: 200 });
    });
    const r = await organizeFiles.handler(
      { path: "/Downloads" },
      ctxWith({ get: listingOf(DOWNLOADS), post }, { signal: controller.signal }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.moved_count).toBe(1);
    expect(d.remaining).toBe(2);
  });

  it("never calls DELETE", async () => {
    const del = vi.fn();
    await organizeFiles.handler({ path: "/Downloads" }, ctxWith({ get: listingOf(DOWNLOADS), post: okPost(), del }));
    expect(del).not.toHaveBeenCalled();
  });
});
