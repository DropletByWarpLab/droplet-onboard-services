// WARP-2664 — analyze_file_cleanup: the read-only preview. Two invariants
// matter most and each has its own test at the bottom: this tool never issues
// a write, and its result never exceeds the orchestrator's tool-result cap.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Mock } from "vitest";
import analyzeFileCleanup, {
  ANALYZE_DEFAULT_DEPTH,
  ANALYZE_DEFAULT_STALE_DAYS,
  ANALYZE_MAX_ENTRIES,
  SAMPLE,
} from "../../../src/handlers/files/analyze-file-cleanup.js";
import type { ToolContext } from "../../../src/types.js";

/**
 * `MODEL_TOOL_RESULT_CAP_CHARS` from
 * `apps/orchestrator/src/services/tool-result-bounding.ts`. Restated here
 * because tools-core cannot import from the app; if that constant moves, this
 * number has to move with it. Past the cap the orchestrator SHORTENS the
 * largest values, which on a nested report empties whole sections — including
 * the path lists delete_files needs — so overflowing is a defect, not verbosity.
 */
const MODEL_TOOL_RESULT_CAP_CHARS = 8000;

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
  opts: { ncToken?: string; userId?: string; post?: Mock; del?: Mock; signal?: AbortSignal } = {},
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
    signal: opts.signal ?? new AbortController().signal,
  };
}

type Row = { path: string; isDirectory?: boolean; size?: number; mimeType?: string | null; modifiedAt?: string };
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

const RECENT = "2026-08-01T00:00:00.000Z";
const ANCIENT = "2019-05-05T00:00:00.000Z";
const MIDDLE = "2022-06-06T00:00:00.000Z";

function row(path: string, o: Omit<Row, "path"> = {}): Row {
  return { path, isDirectory: false, size: 100, mimeType: "application/octet-stream", modifiedAt: RECENT, ...o };
}

/** A GET mock that serves a listing per `?path=` and 404s anything else. */
function treeGet(tree: Record<string, Row[] | number>) {
  return vi.fn(async (url: string, _opts?: Opts) => {
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

    const broken = await analyzeFileCleanup.handler({ path: "/D" }, ctxWith(treeGet({ "/D": 403 })));
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.error.code).toBe("LIST_FAILED");
      expect(broken.error.message).toContain("403");
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
      size_human: expect.any(String),
      max_depth: ANALYZE_DEFAULT_DEPTH,
      directories_listed: 4,
      truncated: false,
    });

    expect(d.by_category.map((c: { category: string }) => c.category)).toContain("Documents");

    expect(d.largest[0]).toEqual({ path: "/Downloads/setup.exe", size_human: "87.9 KB" });

    expect(d.stale.older_than_days).toBe(ANALYZE_DEFAULT_STALE_DAYS);
    expect(d.stale.count).toBe(2);
    expect(d.stale.shown).toBe(2);
    expect(d.stale.items).toEqual([
      { path: "/Downloads/setup.exe", modified_at: "2019-05-05" },
      { path: "/Downloads/Old/report.pdf", modified_at: "2019-05-05" },
    ]);

    expect(d.junk.count).toBe(2);
    expect(d.junk.items).toEqual(
      expect.arrayContaining([
        { path: "/Downloads/.DS_Store", reason: "macOS folder metadata" },
        { path: "/Downloads/movie.mkv.part", reason: "unfinished download" },
      ]),
    );

    // Duplicates name the copy to KEEP and only offer the others for deletion.
    expect(d.duplicate_candidates.groups).toBe(1);
    expect(d.duplicate_candidates.items[0]).toEqual({
      size_human: "4.9 KB",
      // Two copies are named "report.pdf", so the shallower one is kept;
      // Old/report.pdf still outranks "report (1).pdf" because its own name
      // survived normalization untouched.
      keep: "/Downloads/report.pdf",
      delete_candidates: ["/Downloads/Old/report.pdf", "/Downloads/report (1).pdf"],
      copies: 3,
    });
    expect(d.duplicate_candidates.items[0].delete_candidates).not.toContain(
      d.duplicate_candidates.items[0].keep,
    );
    expect(d.duplicate_candidates.note).toMatch(/not by content/);

    expect(d.empty_directories.count).toBe(1);
    expect(d.empty_directories.items).toEqual(["/Downloads/Empty"]);
    expect(d.empty_directories.note).toMatch(/not proof/);

    // The plan is per-destination COUNTS, not example paths.
    expect(d.organize_plan).toEqual({
      rule: "by_type",
      applicable: true,
      files_to_move: 5, // .DS_Store is hidden; the 2 folders and Old/* are out
      moves_by_folder: { Documents: 2, Images: 1, Installers: 1, Other: 1 },
      folders_shown: 4,
      folders_total: 4,
      note: expect.stringMatching(/Apply with organize_files/),
    });
    expect(d.unreadable_directories).toEqual([]);
    // An empty subfolder was seen, and an empty listing is indistinguishable
    // from an unreachable one, so the caveat rides along.
    expect(d.caveat).toMatch(/unreachable file service/i);
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
    expect(d.organize_plan.moves_by_folder).toEqual({ "2026": 4, "2019": 1 });
  });

  // organize_files refuses "/" outright, so a plan for it could never be
  // applied. Handing over an approvable-looking plan the next call rejects is
  // worse than saying so.
  it("marks the organize plan inapplicable at the top-level folder", async () => {
    const r = await analyzeFileCleanup.handler({ path: "/" }, ctxWith(treeGet({ "/": [row("/a.pdf")] })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.organize_plan.applicable).toBe(false);
    expect(d.organize_plan.moves_by_folder).toBeUndefined();
    expect(d.organize_plan.note).toMatch(/does not act on the top-level folder/);
  });

  it("reports the full job even when it exceeds one organize_files run", async () => {
    const many = Array.from({ length: 620 }, (_, i) => row(`/Downloads/f${i}.pdf`, { mimeType: "application/pdf" }));
    const r = await analyzeFileCleanup.handler(
      { path: "/Downloads", max_depth: 0 },
      ctxWith(treeGet({ "/Downloads": many })),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    // The honest total, not the per-call cap — understating it by 120 files is
    // how the assistant tells someone a folder is sorted when it is not.
    expect(d.organize_plan.files_to_move).toBe(620);
    expect(d.organize_plan.note_partial).toMatch(/more than one run/);
  });

  it("notes a subfolder it could not read and keeps going", async () => {
    const r = await analyzeFileCleanup.handler(
      { path: "/Downloads" },
      ctxWith(treeGet({ ...TREE, "/Downloads/Old": 403 })),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.unreadable_directories).toEqual([{ path: "/Downloads/Old", status: 403 }]);
    expect(d.empty_directories.items).toEqual(["/Downloads/Empty"]);
  });

  it("flags a truncated scan rather than presenting it as complete", async () => {
    // The cap is reached with a subfolder still unread, so the report does
    // not cover the tree.
    const many = Array.from({ length: ANALYZE_MAX_ENTRIES + 10 }, (_, i) => row(`/Big/f${i}.txt`, { size: 1 }));
    const tree = {
      "/Big": [...many, row("/Big/More", { isDirectory: true, size: 0, mimeType: null })],
      "/Big/More": [row("/Big/More/x.txt")],
    };
    const r = await analyzeFileCleanup.handler({ path: "/Big" }, ctxWith(treeGet(tree)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as any).scanned.truncated).toBe(true);
  });

  // PR #1985 review: one flat folder holding more than the cap is read whole
  // — every file is in the report — so the scan is complete, not truncated.
  it("does not flag a flat folder that merely exceeds the cap, since every file was read", async () => {
    const many = Array.from({ length: ANALYZE_MAX_ENTRIES + 10 }, (_, i) => row(`/Big/f${i}.txt`, { size: 1 }));
    const r = await analyzeFileCleanup.handler({ path: "/Big" }, ctxWith(treeGet({ "/Big": many })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.scanned.files).toBe(ANALYZE_MAX_ENTRIES + 10);
    expect(d.scanned.truncated).toBe(false);
  });

  it("caveats a scan that found nothing at all", async () => {
    const r = await analyzeFileCleanup.handler({ path: "/Downloads" }, ctxWith(treeGet({ "/Downloads": [] })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as Record<string, any>;
    expect(d.scanned.files).toBe(0);
    // Never "your folder is clean" — an outage produces exactly this result.
    expect(d.caveat).toMatch(/unreachable file service/i);
  });

  describe("bounded output", () => {
    // Built to overrun EVERY sample cap, with long real-world names — the cap
    // has to hold for the messy folder, not the tidy one.
    function messyTree() {
      const files: Row[] = [];
      const LONG = "Quarterly business review and appendix, final revision";
      for (let i = 0; i < 200; i++) {
        const ext = ["pdf", "jpg", "mp4", "mp3", "zip", "exe", "docx", "csv"][i % 8];
        files.push(row(`/Messy/${LONG} ${i}.${ext}`, { size: 1000 + i * 977, modifiedAt: ANCIENT }));
      }
      for (let g = 0; g < 40; g++) {
        for (const suffix of ["", " (1)", " - Copy", " copy 2"]) {
          files.push(row(`/Messy/Scanned contract for the north site ${g}${suffix}.pdf`, {
            size: 500_000 + g,
            mimeType: "application/pdf",
            modifiedAt: MIDDLE,
          }));
        }
      }
      // Junk with names that are genuinely junk-SHAPED: a folder can only
      // hold one ".DS_Store", so a realistic mess is a handful of exact
      // names plus many extension-matched leftovers. (Prefixing the exact
      // names to make them unique would stop them matching at all, which is
      // how an earlier version of this fixture reported 12 junk files
      // instead of 60 and looked like a detection bug.)
      for (const exact of [".DS_Store", "Thumbs.db", "desktop.ini", ".localized"]) {
        files.push(row(`/Messy/${exact}`, { size: 4096, modifiedAt: ANCIENT }));
      }
      for (let i = 0; i < 56; i++) {
        const ext = ["tmp", "part", "bak", "crdownload"][i % 4];
        files.push(row(`/Messy/${LONG} ${i}.${ext}`, { size: 4096 + i, modifiedAt: ANCIENT }));
      }
      const dirs: Row[] = [];
      for (let i = 0; i < 50; i++) {
        dirs.push(row(`/Messy/Empty archive folder number ${i}`, { isDirectory: true, size: 0, mimeType: null }));
      }
      const tree: Record<string, Row[] | number> = { "/Messy": [...files, ...dirs] };
      for (const d of dirs) tree[d.path] = [];
      return tree;
    }

    it("keeps the whole result under the orchestrator's tool-result cap", async () => {
      const r = await analyzeFileCleanup.handler({ path: "/Messy" }, ctxWith(treeGet(messyTree())));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const chars = JSON.stringify(r.data).length;
      expect(
        chars,
        `analyze_file_cleanup serialized to ${chars} chars on a messy folder; past ` +
          `${MODEL_TOOL_RESULT_CAP_CHARS} the orchestrator empties whole sections, including the ` +
          `path lists delete_files needs. Trim a sample size in SAMPLE, do not raise this number.`,
      ).toBeLessThan(MODEL_TOOL_RESULT_CAP_CHARS);
    });

    it("caps every sampled list while keeping the counts exact", async () => {
      const r = await analyzeFileCleanup.handler({ path: "/Messy" }, ctxWith(treeGet(messyTree())));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as Record<string, any>;

      expect(d.largest).toHaveLength(SAMPLE.largest);
      expect(d.stale.items).toHaveLength(SAMPLE.stale);
      expect(d.junk.items).toHaveLength(SAMPLE.junk);
      expect(d.duplicate_candidates.items).toHaveLength(SAMPLE.duplicateGroups);
      expect(d.empty_directories.items).toHaveLength(SAMPLE.empty);
      for (const g of d.duplicate_candidates.items) {
        expect(g.delete_candidates.length).toBeLessThanOrEqual(SAMPLE.duplicatePaths);
      }
      expect(Object.keys(d.organize_plan.moves_by_folder).length).toBeLessThanOrEqual(SAMPLE.planFolders);

      // The counts are the whole set, and each sampled list says so.
      expect(d.stale.count).toBeGreaterThan(SAMPLE.stale);
      expect(d.stale.shown).toBe(SAMPLE.stale);
      expect(d.junk.count).toBe(60);
      expect(d.junk.shown).toBe(SAMPLE.junk);
      expect(d.duplicate_candidates.groups).toBe(40);
      expect(d.duplicate_candidates.shown).toBe(SAMPLE.duplicateGroups);
      expect(d.empty_directories.count).toBe(50);
      expect(d.empty_directories.shown).toBe(SAMPLE.empty);
    });

    it("samples the OLDEST stale files, not whichever the walk reached first", async () => {
      const r = await analyzeFileCleanup.handler(
        { path: "/Mixed", max_depth: 0 },
        ctxWith(
          treeGet({
            "/Mixed": [
              row("/Mixed/newest.txt", { modifiedAt: "2025-01-01T00:00:00.000Z" }),
              row("/Mixed/oldest.txt", { modifiedAt: "2001-01-01T00:00:00.000Z" }),
              row("/Mixed/middle.txt", { modifiedAt: "2010-01-01T00:00:00.000Z" }),
            ],
          }),
        ),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Order asserted by POSITION — normalising it away with .sort() would
      // let a reversed comparator ship the least-stale files as the answer.
      expect((r.data as any).stale.items.map((i: { path: string }) => i.path)).toEqual([
        "/Mixed/oldest.txt",
        "/Mixed/middle.txt",
        "/Mixed/newest.txt",
      ]);
    });
  });

  // PR #1985 review: the walk checks the signal before every listing, like
  // the write handlers do before every mkdir / move / delete.
  describe("cancellation", () => {
    it("stops the walk once aborted and marks the scan cancelled", async () => {
      const controller = new AbortController();
      const inner = treeGet(TREE);
      const get = vi.fn(async (url: string, opts?: Opts) => {
        const res = await inner(url, opts);
        controller.abort();
        return res;
      });
      const r = await analyzeFileCleanup.handler({ path: "/Downloads" }, ctxWith(get, { signal: controller.signal }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as Record<string, any>;
      expect(get).toHaveBeenCalledTimes(1);
      expect(d.scanned.directories_listed).toBe(1);
      expect(d.scanned.cancelled).toBe(true);
      expect(d.scanned.truncated).toBe(true);
      // What the one listing returned is still reported.
      expect(d.scanned.files).toBe(6);
    });

    // PR #1985 review: HttpClient takes a signal and the walk never passed
    // one, so a cancel could not interrupt a slow listing already in flight.
    it("forwards the signal to every listing, and a listing cut short ends the scan as cancelled", async () => {
      const controller = new AbortController();
      const inner = treeGet(TREE);
      let n = 0;
      const get = vi.fn(async (url: string, opts?: Opts) => {
        if (n++ === 0) return inner(url, opts);
        return abortedInFlight(controller)(opts);
      });
      const r = await analyzeFileCleanup.handler({ path: "/Downloads" }, ctxWith(get, { signal: controller.signal }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.data as Record<string, any>;
      expect(d.scanned.directories_listed).toBe(1);
      expect(d.scanned.cancelled).toBe(true);
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const call of get.mock.calls) {
        expect(call[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
      }
    });

    it("returns CANCELLED without any HTTP when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const get = vi.fn();
      const r = await analyzeFileCleanup.handler({ path: "/Downloads" }, ctxWith(get, { signal: controller.signal }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("CANCELLED");
      expect(get).not.toHaveBeenCalled();
    });
  });

  // THE invariant. A preview that writes is not a preview.
  it("never issues a POST or DELETE, whatever it finds", async () => {
    const post = vi.fn();
    const del = vi.fn();
    for (const path of ["/Downloads", "/", "/Downloads/Empty"]) {
      await analyzeFileCleanup.handler({ path }, ctxWith(treeGet(TREE), { post, del }));
    }
    expect(post).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});
