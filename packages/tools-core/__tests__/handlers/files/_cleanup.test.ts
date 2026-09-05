// WARP-2664 — the pure helpers behind analyze_file_cleanup / organize_files /
// delete_files. Every classification the tools report to a user is decided
// here, so each rule gets its own pin.
import { describe, it, expect, vi } from "vitest";
import {
  CLEANUP_CONCURRENCY,
  categoryOf,
  clampInt,
  destinationFolderFor,
  duplicateGroups,
  extensionOf,
  humanBytes,
  isOrganizeRule,
  junkReason,
  mapPool,
  normalizeCopyName,
  parseEntries,
  planOrganize,
  readListing,
  unlessAborted,
  walkTree,
  type CleanupEntry,
} from "../../../src/handlers/files/_cleanup.js";

function entry(p: string, opts: Partial<CleanupEntry> = {}): CleanupEntry {
  return {
    name: p.split("/").pop() ?? "",
    path: p,
    isDirectory: false,
    size: 100,
    mimeType: "application/octet-stream",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ...opts,
  };
}

describe("extensionOf", () => {
  it.each([
    ["report.PDF", "pdf"],
    ["archive.tar.gz", "gz"],
    [".bashrc", ""],
    ["README", ""],
    ["trailing.", ""],
  ])("%s → %s", (name, ext) => {
    expect(extensionOf(name)).toBe(ext);
  });
});

describe("categoryOf", () => {
  it("decides by extension first, case-insensitively", () => {
    expect(categoryOf("holiday.JPG", "application/octet-stream")).toBe("Images");
    expect(categoryOf("notes.md", null)).toBe("Documents");
    expect(categoryOf("clip.mkv", null)).toBe("Videos");
    expect(categoryOf("song.flac", null)).toBe("Audio");
    expect(categoryOf("backup.7z", null)).toBe("Archives");
    expect(categoryOf("setup.msi", null)).toBe("Installers");
  });

  it("falls back to the MIME type when the extension says nothing", () => {
    expect(categoryOf("scan", "image/png")).toBe("Images");
    expect(categoryOf("clip", "video/mp4")).toBe("Videos");
    expect(categoryOf("voice", "audio/ogg")).toBe("Audio");
    expect(categoryOf("readme", "text/plain")).toBe("Documents");
    expect(categoryOf("statement", "application/pdf")).toBe("Documents");
    expect(categoryOf("bundle", "application/zip")).toBe("Archives");
  });

  it("is Other when neither side knows", () => {
    expect(categoryOf("blob.xyz", "application/octet-stream")).toBe("Other");
    expect(categoryOf("blob", null)).toBe("Other");
  });
});

describe("junkReason", () => {
  it.each([
    [".DS_Store", "macOS folder metadata"],
    ["Thumbs.db", "Windows thumbnail cache"],
    ["desktop.ini", "Windows folder settings"],
    ["._photo.jpg", "macOS resource fork"],
    ["~$report.docx", "Office lock file"],
    [".~lock.report.odt#", "LibreOffice lock file"],
    ["notes.txt~", "editor backup"],
    ["setup.TMP", "temporary file"],
    ["video.part", "unfinished download"],
    ["movie.mp4.crdownload", "unfinished download"],
    ["config.bak", "backup copy"],
    [".config.swp", "editor swap file"],
  ])("%s → %s", (name, reason) => {
    expect(junkReason(name)).toBe(reason);
  });

  it("never flags something a person named", () => {
    for (const name of ["photo.jpg", "Tax 2025.pdf", "old notes.md", "temperature.csv", "partial.txt"]) {
      expect(junkReason(name), name).toBeNull();
    }
  });
});

describe("normalizeCopyName", () => {
  it.each([
    ["report (1).pdf", "report.pdf"],
    ["report - Copy.pdf", "report.pdf"],
    ["report - Copy (2).PDF", "report.pdf"],
    ["report copy 2.pdf", "report.pdf"],
    ["Copy of report.pdf", "report.pdf"],
    ["Copy of report - Copy (3).pdf", "report.pdf"],
    ["plain.pdf", "plain.pdf"],
    ["README", "readme"],
  ])("%s → %s", (name, normalized) => {
    expect(normalizeCopyName(name)).toBe(normalized);
  });
});

describe("duplicateGroups", () => {
  it("groups by normalized name AND size, drops singletons and empty files, sorts by reclaimable bytes", () => {
    const groups = duplicateGroups([
      entry("/A/report.pdf", { size: 500 }),
      entry("/B/report (1).pdf", { size: 500 }),
      entry("/C/Report - Copy.pdf", { size: 500 }),
      entry("/A/report.pdf.bak", { size: 500 }), // different name — not a copy
      entry("/A/photo.jpg", { size: 9000 }),
      entry("/B/photo.jpg", { size: 9000 }),
      entry("/C/photo.jpg", { size: 9001 }), // same name, different size
      entry("/A/empty.txt", { size: 0 }), // empty files match everything — excluded
      entry("/B/empty.txt", { size: 0 }),
      entry("/A/alone.txt", { size: 7 }),
      entry("/A/folder", { isDirectory: true, size: 4096 }),
      entry("/B/folder", { isDirectory: true, size: 4096 }),
    ]);
    // photo.jpg reclaims 9,000; report.pdf reclaims 1,000 — largest first.
    expect(groups).toEqual([
      { name: "photo.jpg", size: 9000, keep: "/A/photo.jpg", duplicates: ["/B/photo.jpg"] },
      {
        name: "report.pdf",
        size: 500,
        keep: "/A/report.pdf",
        duplicates: ["/B/report (1).pdf", "/C/Report - Copy.pdf"],
      },
    ]);
  });

  // `reclaimable` is computed as size x duplicates.length, i.e. assuming ONE
  // copy survives — so the group has to name which. Without it the model can
  // hand every path to delete_files and the file goes entirely.
  it("keeps the copy whose own name survived normalization, whatever the walk order", () => {
    const [g] = duplicateGroups([
      entry("/D/Copies/report (2).pdf", { size: 40 }),
      entry("/D/Copies/report - Copy.pdf", { size: 40 }),
      entry("/D/report.pdf", { size: 40 }), // the original, reached LAST
    ]);
    expect(g.keep).toBe("/D/report.pdf");
    expect(g.duplicates).toEqual(["/D/Copies/report (2).pdf", "/D/Copies/report - Copy.pdf"]);
    expect(g.duplicates).not.toContain(g.keep);
  });

  it("falls back to the shallowest path, then lexicographic, when no copy is the original", () => {
    const [g] = duplicateGroups([
      entry("/D/deep/nested/report (3).pdf", { size: 40 }),
      entry("/D/report (2).pdf", { size: 40 }),
      entry("/D/report (1).pdf", { size: 40 }),
    ]);
    // Both /D entries are equally shallow, so lexicographic decides.
    expect(g.keep).toBe("/D/report (1).pdf");
    expect(g.duplicates).toEqual(["/D/report (2).pdf", "/D/deep/nested/report (3).pdf"]);
  });

  it("is deterministic across input orderings", () => {
    const files = [
      entry("/D/report (1).pdf", { size: 40 }),
      entry("/D/report.pdf", { size: 40 }),
      entry("/D/x/report - Copy.pdf", { size: 40 }),
    ];
    const forward = duplicateGroups(files);
    const reversed = duplicateGroups([...files].reverse());
    expect(reversed).toEqual(forward);
  });
});

describe("destinationFolderFor", () => {
  it("names the folder per rule", () => {
    const e = entry("/D/holiday.jpg", { modifiedAt: "2024-03-09T10:00:00.000Z" });
    expect(destinationFolderFor(e, "by_type")).toBe("Images");
    expect(destinationFolderFor(e, "by_extension")).toBe("JPG");
    expect(destinationFolderFor(e, "by_month")).toBe("2024-03");
    expect(destinationFolderFor(e, "by_year")).toBe("2024");
  });

  it("has a home for files with no extension or no usable date", () => {
    expect(destinationFolderFor(entry("/D/README"), "by_extension")).toBe("No extension");
    expect(destinationFolderFor(entry("/D/x.txt", { modifiedAt: "" }), "by_month")).toBe("Undated");
    expect(destinationFolderFor(entry("/D/x.txt", { modifiedAt: "garbage" }), "by_year")).toBe("Undated");
  });

  it("isOrganizeRule accepts only the four rules", () => {
    expect(isOrganizeRule("by_type")).toBe(true);
    expect(isOrganizeRule("by_size")).toBe(false);
    expect(isOrganizeRule(1)).toBe(false);
  });
});

describe("planOrganize", () => {
  const listing = [
    entry("/Downloads/a.pdf"),
    entry("/Downloads/b.JPG"),
    entry("/Downloads/c.png"),
    entry("/Downloads/.hidden", { size: 1 }),
    entry("/Downloads/Old", { isDirectory: true }),
    // Something deeper that a recursive listing might carry — never moved.
    entry("/Downloads/Old/d.pdf"),
  ];

  it("moves only direct-child files, skips hidden files, leaves folders and deeper files alone", () => {
    const plan = planOrganize("/Downloads", listing, "by_type", 500);
    expect(plan.moves).toEqual([
      { from: "/Downloads/a.pdf", to: "/Downloads/Documents/a.pdf", folder: "/Downloads/Documents" },
      { from: "/Downloads/b.JPG", to: "/Downloads/Images/b.JPG", folder: "/Downloads/Images" },
      { from: "/Downloads/c.png", to: "/Downloads/Images/c.png", folder: "/Downloads/Images" },
    ]);
    expect(plan.folders).toEqual(["/Downloads/Documents", "/Downloads/Images"]);
    expect(plan.skipped).toEqual([{ path: "/Downloads/.hidden", reason: "hidden file" }]);
    expect(plan.remaining).toBe(0);
  });

  it("caps the move list and counts the overflow as remaining", () => {
    const plan = planOrganize("/Downloads", listing, "by_type", 2);
    expect(plan.moves).toHaveLength(2);
    expect(plan.remaining).toBe(1);
  });

  it("handles the root prefix without doubling the slash", () => {
    const plan = planOrganize("/", [entry("/x.pdf")], "by_type", 10);
    expect(plan.moves[0]).toEqual({ from: "/x.pdf", to: "/Documents/x.pdf", folder: "/Documents" });
  });

  it("is a no-op on a folder whose files already sit in subfolders", () => {
    const plan = planOrganize(
      "/Downloads",
      [entry("/Downloads/Documents", { isDirectory: true }), entry("/Downloads/Documents/a.pdf")],
      "by_type",
      10,
    );
    expect(plan.moves).toEqual([]);
    expect(plan.folders).toEqual([]);
  });
});

describe("parseEntries", () => {
  it("accepts a bare array or an { entries } wrapper and drops malformed rows", () => {
    const rows = [
      { name: "a.txt", path: "/a.txt", isDirectory: false, size: 3, mimeType: "text/plain", modifiedAt: "2026-01-01T00:00:00.000Z" },
      { path: "/noname.txt", size: -5, modifiedAt: 12 },
      { name: "no-path" },
      null,
      "string",
    ];
    const fromArray = parseEntries(rows);
    expect(fromArray).toEqual([
      { name: "a.txt", path: "/a.txt", isDirectory: false, size: 3, mimeType: "text/plain", modifiedAt: "2026-01-01T00:00:00.000Z" },
      { name: "noname.txt", path: "/noname.txt", isDirectory: false, size: 0, mimeType: null, modifiedAt: "" },
    ]);
    expect(parseEntries({ entries: rows })).toEqual(fromArray);
    expect(parseEntries("nope")).toEqual([]);
    expect(parseEntries(null)).toEqual([]);
  });
});

describe("readListing", () => {
  it("reads entries from an OK answer and flags an empty one as possibly degraded", async () => {
    const full = await readListing(new Response(JSON.stringify([{ path: "/D/a.txt", name: "a.txt" }]), { status: 200 }));
    expect(full).toEqual({
      ok: true,
      status: 200,
      entries: [expect.objectContaining({ path: "/D/a.txt" })],
      possiblyDegraded: false,
    });
    const empty = await readListing(new Response("[]", { status: 200 }));
    expect(empty).toEqual({ ok: true, status: 200, entries: [], possiblyDegraded: true });
  });

  it("a failed answer has no entries and is a failure, not a degrade", async () => {
    expect(await readListing(new Response("nope", { status: 502 }))).toEqual({
      ok: false,
      status: 502,
      entries: [],
      possiblyDegraded: false,
    });
  });

  it("an unparseable OK body reads as empty, and therefore as possibly degraded", async () => {
    const r = await readListing(new Response("<html>", { status: 200 }));
    expect(r.entries).toEqual([]);
    expect(r.possiblyDegraded).toBe(true);
  });
});

// PR #1985 review: a forwarded signal makes fetch REJECT mid-flight, and
// inside a per-file loop that rejection would discard everything the loop
// had already done. The handlers await through this instead.
describe("unlessAborted", () => {
  it("returns the response when the call answers", async () => {
    const res = new Response("{}", { status: 200 });
    expect(await unlessAborted(new AbortController().signal, async () => res)).toBe(res);
  });

  it("returns null when the call rejects because the signal aborted", async () => {
    const controller = new AbortController();
    const r = await unlessAborted(controller.signal, async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    expect(r).toBeNull();
  });

  it("rethrows a rejection that is not the caller's own cancellation", async () => {
    await expect(
      unlessAborted(new AbortController().signal, async () => {
        throw new Error("ECONNRESET");
      }),
    ).rejects.toThrow("ECONNRESET");
  });
});

// PR #1985 review: the three tools issued every round-trip one at a time —
// up to hundreds of serialized listings, deletes or moves inside one chat
// turn. mapPool bounds what is in flight without changing what is reported
// or in what order.
describe("mapPool", () => {
  const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("never has more than `limit` calls in flight, dispatches in order, and returns results in item order", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const dispatched: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const results = await mapPool(items, 4, async (i) => {
      dispatched.push(i);
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Later items finish first, so item order in the result is a property
      // of the pool, not of the timing.
      await settle((3 - (i % 3)) * 2);
      inFlight--;
      return i * 10;
    });
    expect(peak).toBe(4);
    expect(dispatched).toEqual(items);
    expect(results).toEqual(items.map((i) => i * 10));
  });

  it("runs no more workers than there are items", async () => {
    expect(await mapPool([], 4, async (x: number) => x)).toEqual([]);
    let inFlight = 0;
    let peak = 0;
    await mapPool([1, 2], 4, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await settle(1);
      inFlight--;
      return x;
    });
    expect(peak).toBe(2);
  });

  it("rejects when a call rejects", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("clampInt / humanBytes", () => {
  it("clampInt truncates and clamps, falling back on non-numbers", () => {
    expect(clampInt(3.9, 0, 8, 3)).toBe(3);
    expect(clampInt(99, 0, 8, 3)).toBe(8);
    expect(clampInt(-1, 0, 8, 3)).toBe(0);
    expect(clampInt("4", 0, 8, 3)).toBe(3);
    expect(clampInt(undefined, 0, 8, 3)).toBe(3);
    expect(clampInt(Number.NaN, 0, 8, 3)).toBe(3);
  });

  it("humanBytes reads like a person would say it", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(1536)).toBe("1.5 KB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(humanBytes(-3)).toBe("0 B");
  });
});

describe("walkTree", () => {
  type Tree = Record<string, Array<Partial<CleanupEntry> & { path: string }> | number>;
  const live = () => new AbortController().signal;

  function lister(tree: Tree) {
    const calls: string[] = [];
    const list = vi.fn(async (dir: string) => {
      calls.push(dir);
      const node = tree[dir];
      if (typeof node === "number") return new Response("{}", { status: node });
      if (!node) return new Response("[]", { status: 404 });
      const body = node.map((n) => ({
        name: n.path.split("/").pop(),
        isDirectory: false,
        size: 1,
        mimeType: "text/plain",
        modifiedAt: "2026-01-01T00:00:00.000Z",
        ...n,
      }));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return { list, calls };
  }

  const tree: Tree = {
    "/D": [{ path: "/D/a.txt" }, { path: "/D/sub", isDirectory: true }, { path: "/D/empty", isDirectory: true }],
    "/D/sub": [{ path: "/D/sub/b.txt" }, { path: "/D/sub/deeper", isDirectory: true }],
    "/D/sub/deeper": [{ path: "/D/sub/deeper/c.txt" }],
    "/D/empty": [],
  };

  it("walks breadth-first to maxDepth, reporting empty folders", async () => {
    const { list, calls } = lister(tree);
    const r = await walkTree("/D", list, { maxDepth: 1, maxEntries: 100, maxListings: 100, signal: live() });
    expect(calls).toEqual(["/D", "/D/sub", "/D/empty"]);
    expect(r.entries.map((e) => e.path)).toEqual([
      "/D/a.txt", "/D/sub", "/D/empty", "/D/sub/b.txt", "/D/sub/deeper",
    ]);
    expect(r.emptyDirectories).toEqual(["/D/empty"]);
    expect(r.listed).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.rootStatus).toBe(200);
    // /D/empty read as empty, and an empty listing is what an outage returns.
    expect(r.possiblyDegraded).toBe(true);
  });

  // PR #1985 review: the "may be an outage" signal is decided once, in
  // readListing, and OR'd across the walk — not re-derived per handler.
  it("possiblyDegraded is false when every listing had entries, true when the root itself read empty", async () => {
    const full = await walkTree("/D", lister({ "/D": [{ path: "/D/a.txt" }] }).list, { maxDepth: 1, maxEntries: 100, maxListings: 100, signal: live() });
    expect(full.possiblyDegraded).toBe(false);
    const empty = await walkTree("/D", lister({ "/D": [] }).list, { maxDepth: 1, maxEntries: 100, maxListings: 100, signal: live() });
    expect(empty.possiblyDegraded).toBe(true);
    expect(empty.emptyDirectories).toEqual([]); // the root is reported via the flag, not as an empty subfolder
  });

  it("depth 0 lists only the root", async () => {
    const { list, calls } = lister(tree);
    await walkTree("/D", list, { maxDepth: 0, maxEntries: 100, maxListings: 100, signal: live() });
    expect(calls).toEqual(["/D"]);
  });

  it("stops at maxListings and flags truncation", async () => {
    const { list } = lister(tree);
    const r = await walkTree("/D", list, { maxDepth: 5, maxEntries: 100, maxListings: 2, signal: live() });
    expect(r.listed).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("stops at maxEntries and flags truncation", async () => {
    const { list } = lister(tree);
    const r = await walkTree("/D", list, { maxDepth: 5, maxEntries: 3, maxListings: 100, signal: live() });
    expect(r.truncated).toBe(true);
    expect(r.listed).toBe(1);
  });

  // PR #1985 review: `truncated` claims folders went UNREAD. A scan that
  // reached the cap with nothing left to list read everything, so it is
  // complete — flagging it sent the user a false "this may be incomplete".
  it("a scan that reaches maxEntries with nothing left to list is complete, not truncated", async () => {
    const flat: Tree = { "/E": [{ path: "/E/a" }, { path: "/E/b" }, { path: "/E/c" }] };
    const exact = await walkTree("/E", lister(flat).list, { maxDepth: 3, maxEntries: 3, maxListings: 100, signal: live() });
    expect(exact.entries).toHaveLength(3);
    expect(exact.truncated).toBe(false);
    // One folder's worth is always read whole, so overrunning the cap inside
    // a single listing is still a complete read of that folder.
    const over = await walkTree("/E", lister(flat).list, { maxDepth: 3, maxEntries: 2, maxListings: 100, signal: live() });
    expect(over.entries).toHaveLength(3);
    expect(over.truncated).toBe(false);
  });

  // PR #1985 review: the write handlers check the signal before every
  // iteration; the walk did not, so a cancelled analyze kept listing up to
  // maxListings folders.
  describe("cancellation", () => {
    it("stops listing once the signal is aborted, keeps what was read, and says so", async () => {
      const controller = new AbortController();
      const inner = lister(tree);
      const list = vi.fn(async (dir: string) => {
        const res = await inner.list(dir);
        controller.abort();
        return res;
      });
      const r = await walkTree("/D", list, { maxDepth: 3, maxEntries: 100, maxListings: 100, signal: controller.signal });
      expect(list).toHaveBeenCalledTimes(1);
      expect(r.entries.map((e) => e.path)).toEqual(["/D/a.txt", "/D/sub", "/D/empty"]);
      expect(r.listed).toBe(1);
      expect(r.cancelled).toBe(true);
      // Two folders were still queued, so the report does not cover the tree.
      expect(r.truncated).toBe(true);
    });

    it("a listing cut short by the signal ends the walk as cancelled instead of throwing", async () => {
      const controller = new AbortController();
      const inner = lister(tree);
      let n = 0;
      const list = vi.fn(async (dir: string) => {
        if (n++ === 0) return inner.list(dir);
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      });
      const r = await walkTree("/D", list, { maxDepth: 3, maxEntries: 100, maxListings: 100, signal: controller.signal });
      expect(r.entries.map((e) => e.path)).toEqual(["/D/a.txt", "/D/sub", "/D/empty"]);
      expect(r.listed).toBe(1);
      expect(r.cancelled).toBe(true);
      expect(r.truncated).toBe(true);
    });

    it("a listing that fails for any other reason still throws", async () => {
      const list = vi.fn(async (_dir: string) => {
        throw new Error("ECONNRESET");
      });
      await expect(
        walkTree("/D", list, { maxDepth: 3, maxEntries: 100, maxListings: 100, signal: live() }),
      ).rejects.toThrow("ECONNRESET");
    });

    it("lists nothing when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { list } = lister(tree);
      const r = await walkTree("/D", list, { maxDepth: 3, maxEntries: 100, maxListings: 100, signal: controller.signal });
      expect(list).not.toHaveBeenCalled();
      expect(r.cancelled).toBe(true);
      expect(r.listed).toBe(0);
    });
  });

  it("lists at most CLEANUP_CONCURRENCY folders at a time — and more than one — folding entries in queue order", async () => {
    const wide: Tree = { "/W": Array.from({ length: 10 }, (_, i) => ({ path: `/W/d${i}`, isDirectory: true })) };
    for (let i = 0; i < 10; i++) wide[`/W/d${i}`] = [{ path: `/W/d${i}/f.txt` }];
    const inner = lister(wide);
    let inFlight = 0;
    let peak = 0;
    const list = vi.fn(async (dir: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Vary the answer time so a later listing can answer first.
      await new Promise<void>((r) => setTimeout(r, 1 + (Number(dir.slice(-1)) % 3)));
      inFlight--;
      return inner.list(dir);
    });
    const r = await walkTree("/W", list, { maxDepth: 2, maxEntries: 1000, maxListings: 100, signal: live() });
    expect(r.listed).toBe(11);
    expect(peak).toBeLessThanOrEqual(CLEANUP_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(r.entries.filter((e) => !e.isDirectory).map((e) => e.path)).toEqual(
      Array.from({ length: 10 }, (_, i) => `/W/d${i}/f.txt`),
    );
    expect(r.truncated).toBe(false);
  });

  it("a failed subfolder is recorded and skipped, the walk goes on", async () => {
    const { list } = lister({ ...tree, "/D/sub": 500 });
    const r = await walkTree("/D", list, { maxDepth: 2, maxEntries: 100, maxListings: 100, signal: live() });
    expect(r.errors).toEqual([{ path: "/D/sub", status: 500 }]);
    expect(r.emptyDirectories).toEqual(["/D/empty"]);
  });

  it("a failed root ends the walk with its status and no further calls", async () => {
    const { list, calls } = lister({ "/D": 404 });
    const r = await walkTree("/D", list, { maxDepth: 2, maxEntries: 100, maxListings: 100, signal: live() });
    expect(r.rootStatus).toBe(404);
    expect(r.entries).toEqual([]);
    expect(calls).toEqual(["/D"]);
  });
});
