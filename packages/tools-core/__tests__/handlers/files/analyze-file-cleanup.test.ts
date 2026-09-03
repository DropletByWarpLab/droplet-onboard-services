// WARP-2664 — analyze_file_cleanup: the read-only preview. The invariant
// that matters most is the last describe: this tool never issues a write.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Mock } from "vitest";
import analyzeFileCleanup, {
  ANALYZE_DEFAULT_DEPTH,
  ANALYZE_DEFAULT_STALE_DAYS,
} from "../../../src/handlers/files/analyze-file-cleanup.js";
import type { ToolContext } from "../../../src/types.js";

// WARP-1844 class: "stale" is measured against the clock, so a fixture with
// wall-clock dates silently changes meaning as time passes — RECENT below
// would age past the 365-day default in 2027 and turn this suite red for no
// reason. Pin now, and every staleness assertion becomes a statement about
// the RULE rather than about the day the suite happens to run.
const NOW = new Date("2026-09-03T12:00:00.000Z");
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

function ctxWith(
  get: Mock,
  opts: { ncToken?: string; userId?: string; post?: Mock; del?: Mock } = {},
): ToolContext {
  return {
    http: {
      nextcloud: { get, post: opts.post ?? vi.fn(), patch: vi.fn(), delete: opts.del ?? vi.fn() },
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
    signal: new AbortController().signal,
  };
}

type Row = { path: string; isDirectory?: boolean; size?: number; mimeType?: string | null; modifiedAt?: string };

const RECENT = "2026-08-01T00:00:00.000Z";
const ANCIENT = "2019-05-05T00:00:00.000Z";

function row(path: string, o: Omit<Row, "path"> = {}): Row {
  return { path, isDirectory: false, size: 100, mimeType: "application/octet-stream", modifiedAt: RECENT, ...o };
}

/** A GET mock that serves a listing per `?path=` and 404s anything else. */
function treeGet(tree: Record<string, Row[] | number>) {
  return vi.fn(async (url: string, _opts?: { headers?: Record<string, string> }) => {
    const m = /^\/\?path=(.*)$/.exec(url);
    const dir = m ? decodeURIComponent(m[1]) : "";
    const node = tree[dir];
    if (typeof node === "number") return new Response("{}", { status: node });
    if (!node) return new Response("[]", { status: 404 });
    const body = node.map((r) => ({ name: r.path.split("/").pop(), ...r }));
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

const TREE: Record<string, Row[] | number> = {
  "/Downloads": [
    row("/Downloads/report.pdf", { size: 5_000, mimeType: "application/pdf" }),
    row("/Downloads/report (1).pdf", { size: 5_000, mimeType: "application/pdf" }),
    row("/Downloads/holiday.jpg", { size: 40_000, mimeType: "image/jpeg" }),
    row("/Downloads/setup.exe", { size: 90_000, modifiedAt: ANCIENT }),
    row("/Downloads/.DS_Store", { size: 6 }),
    row("/Downloads/movie.mkv.part", { size: 70_000 }),
    row("/Downloads/Old", { isDirectory: true, size: 0, mimeType: null }),
    row("/Downloads/Empty", { isDirectory: true, size: 0, mimeType: null }),
  ],
  "/Downloads/Old": [
    row("/Downloads/Old/report.pdf", { size: 5_000, mimeType: "application/pdf", modifiedAt: ANCIENT }),
    row("/Downloads/Old/Deeper", { isDirectory: true, size: 0, mimeType: null }),
  ],
  "/Downloads/Old/Deeper": [row("/Downloads/Old/Deeper/x.txt", { size: 1 })],
  "/Downloads/Empty": [],
};

describe("analyze_file_cleanup", () => {
  it("is a Read-tier tool", () => {
    expect(analyzeFileCleanup.requiresWrite).toBe(false);
    expect(analyzeFileCleanup.requiresConfirmation).toBe(false);
  });

  it("returns AUTH_REQUIRED without ncToken, before any HTTP", async () => {
    const get = vi.fn();
    const r = await analyzeFileCleanup.handler({ path: "/Downloads" }, ctxWith(get, { ncToken: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AUTH_REQUIRED");
      expect(r.error.message).toContain("sign back in with their password");
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED without userId", async () => {
    const get = vi.fn();
    const r = await analyzeFileCleanup.handler({ path: "/Downloads" }, ctxWith(get, { userId: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects traversal with INVALID_PATH before any HTTP", async () => {
    const get = vi.fn();
    const r = await analyzeFileCleanup.handler({ path: "/../etc" }, ctxWith(get));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_PATH");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an unknown organize_rule with INVALID_ARGS before any HTTP", async () => {
    const get = vi.fn();
    const r = await analyzeFileCleanup.handler(
      { path: "/Downloads", organize_rule: "by_colour" },
      ctxWith(get),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ARGS");
      expect(r.error.message).toContain("by_type");
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("defaults the path to / and sends the acting-user headers", async () => {
    const get = treeGet({ "/": [] });
    const r = await analyzeFileCleanup.handler({}, ctxWith(get));
    expect(r.ok).toBe(true);
    expect(get).toHaveBeenCalledWith(
      `/?path=${encodeURIComponent("/")}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Nextcloud-Token": "tok", "X-Nextcloud-User": "alice" }),
      }),
    );
  });

  it("maps a 404 root to NOT_FOUND and any other failure to LIST_FAILED", async () => {
    const missing = await analyzeFileCleanup.handler({ path: "/Nope" }, ctxWith(treeGet({})));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");

    const broken = await analyzeFileCleanup.handler({ path: "/D" }, ctxWith(treeGet({ "/D": 503 })));
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.error.code).toBe("LIST_FAILED");
      expect(broken.error.message).toContain("503");
    }
  });

  it("produces the full report for a cluttered folder", async () => {
    const r = await analyzeFileCleanup.handler({ path: "/Downloads/" }, ctxWith(treeGet(TREE)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;

    expect(d.path).toBe("/Downloads");
    // Default depth 3 reaches Old/Deeper; the two folders + Empty are listed.
    expect(d.scanned).toEqual({
      files: 8,
      directories: 3,
      bytes: 5_000 + 5_000 + 40_000 + 90_000 + 6 + 70_000 + 5_000 + 1,
      size_human: expect.any(String),
      max_depth: ANALYZE_DEFAULT_DEPTH,
      directories_listed: 4,
      truncated: false,
    });

    // Categories, largest first by bytes.
    expect(d.by_category[0]).toEqual({ category: "Installers", files: 1, bytes: 90_000, size_human: "87.9 KB" });
    expect(d.by_category.map((c: { category: string }) => c.category)).toContain("Documents");

    expect(d.largest[0].path).toBe("/Downloads/setup.exe");
    expect(d.largest[0].size_human).toBe("87.9 KB");

    expect(d.stale.older_than_days).toBe(ANALYZE_DEFAULT_STALE_DAYS);
    expect(d.stale.count).toBe(2);
    expect(d.stale.items.map((i: { path: string }) => i.path).sort()).toEqual([
      "/Downloads/Old/report.pdf",
      "/Downloads/setup.exe",
    ]);

    expect(d.junk.count).toBe(2);
    expect(d.junk.items).toEqual(
      expect.arrayContaining([
        { path: "/Downloads/.DS_Store", size: 6, reason: "macOS folder metadata" },
        { path: "/Downloads/movie.mkv.part", size: 70_000, reason: "unfinished download" },
      ]),
    );

    expect(d.duplicate_candidates.groups).toBe(1);
    expect(d.duplicate_candidates.reclaimable_bytes).toBe(10_000);
    expect(d.duplicate_candidates.items[0]).toEqual({
      name: "report.pdf",
      size: 5_000,
      size_human: "4.9 KB",
      paths: ["/Downloads/report.pdf", "/Downloads/report (1).pdf", "/Downloads/Old/report.pdf"],
    });
    expect(d.duplicate_candidates.note).toMatch(/not by content/);

    expect(d.empty_directories).toEqual({ count: 1, items: ["/Downloads/Empty"] });

    // The organize preview covers direct children only, by_type by default.
    expect(d.organize_plan.rule).toBe("by_type");
    expect(d.organize_plan.files_to_move).toBe(5); // .DS_Store hidden, 2 folders
    expect(d.organize_plan.folders).toEqual([
      "/Downloads/Documents",
      "/Downloads/Images",
      "/Downloads/Installers",
      "/Downloads/Other",
    ]);
    expect(d.organize_plan.sample).toContainEqual({
      from: "/Downloads/holiday.jpg",
      to: "/Downloads/Images/holiday.jpg",
    });
    expect(d.unreadable_directories).toEqual([]);
  });

  it("honours max_depth (0 lists only the folder itself) and stale_days", async () => {
    const get = treeGet(TREE);
    const r = await analyzeFileCleanup.handler(
      { path: "/Downloads", max_depth: 0, stale_days: 1 },
      ctxWith(get),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(get).toHaveBeenCalledTimes(1);
    expect(d.scanned.directories_listed).toBe(1);
    expect(d.scanned.files).toBe(6);
    expect(d.stale.older_than_days).toBe(1);
    // RECENT is 33 days before the pinned NOW, so at stale_days: 1 every
    // direct child counts — the knob moves the answer, which is the point.
    expect(d.stale.count).toBe(6);
    expect(d.empty_directories.count).toBe(0);
  });

  it("previews a different organize rule on request", async () => {
    const r = await analyzeFileCleanup.handler(
      { path: "/Downloads", organize_rule: "by_year" },
      ctxWith(treeGet(TREE)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.organize_plan.rule).toBe("by_year");
    expect(d.organize_plan.folders).toEqual(["/Downloads/2026", "/Downloads/2019"]);
  });

  it("notes a subfolder it could not read and keeps going", async () => {
    const r = await analyzeFileCleanup.handler(
      { path: "/Downloads" },
      ctxWith(treeGet({ ...TREE, "/Downloads/Old": 500 })),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.unreadable_directories).toEqual([{ path: "/Downloads/Old", status: 500 }]);
    expect(d.empty_directories.items).toEqual(["/Downloads/Empty"]);
  });

  // THE invariant. A preview that writes is not a preview.
  it("never issues a POST or DELETE, whatever it finds", async () => {
    const post = vi.fn();
    const del = vi.fn();
    const r = await analyzeFileCleanup.handler({ path: "/Downloads" }, ctxWith(treeGet(TREE), { post, del }));
    expect(r.ok).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
