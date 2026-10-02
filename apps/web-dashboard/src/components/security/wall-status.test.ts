/**
 * WARP-2981 (ADR-059 P6) — the Security wall's pure rules (wall-status.ts)
 * and its retry policy (useSecurity.ts): when the strip is fresh, stale or
 * offline; which health rows count as sources and what the sources cell says;
 * when the needs-attention count may be behind; when the sign-out warning
 * shows; how long a failed read waits before it is retried; the camera
 * tiles' grid; and who the wall runs for (D6).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityHealthRow } from "@/lib/types";
import { tierLabel } from "@/lib/access";
import { tileRetryDelayMs, wallOnErrorRetry, wallRetryDelayMs } from "@/lib/hooks/useSecurity";
import {
  BEHIND_COPY,
  WALL_COPY,
  WALL_ROW_ROLE,
  countBehind,
  sessionWarning,
  sourceRows,
  sourcesHeadline,
  WALL_TILE_MIN_PICTURE_PX,
  tileGrid,
  wallFreshness,
  wallRunsFor,
  type WallRead,
} from "./wall-status";

const NOW = Date.parse("2026-09-25T21:00:00Z");
const row = (id: string, state: SecurityHealthRow["state"]): SecurityHealthRow =>
  ({ id, state, detail: "", lastSeenAt: null }) as SecurityHealthRow;
const reads = (v: number | null): Record<WallRead, number | null> => ({ modules: v, counts: v, sources: v, mode: v });
const none: Record<WallRead, boolean> = { modules: false, counts: false, sources: false, mode: false };

describe("wallFreshness (T-D1)", () => {
  it("nothing answered and nothing failed → loading", () => {
    expect(wallFreshness(reads(null), none, true, NOW)).toEqual({ state: "loading", updatedAt: null });
  });

  it("fresh at 44 s, stale at 46 s", () => {
    expect(wallFreshness(reads(NOW - 44_000), none, true, NOW)).toEqual({ state: "fresh", updatedAt: NOW - 44_000 });
    expect(wallFreshness(reads(NOW - 46_000), none, true, NOW).state).toBe("stale");
    expect(wallFreshness(reads(NOW - 45_000), none, true, NOW).state).toBe("fresh");
  });

  it("the OLDEST status read decides — a strip is as fresh as its stalest cell", () => {
    const at = { modules: NOW, counts: NOW - 1_000, sources: NOW - 50_000, mode: NOW - 2_000 };
    expect(wallFreshness(at, none, true, NOW)).toEqual({ state: "stale", updatedAt: NOW - 50_000 });
  });

  it("the modules read's age is not judged (it polls every 2 min)", () => {
    expect(wallFreshness({ ...reads(NOW - 1_000), modules: NOW - 110_000 }, none, true, NOW).state).toBe("fresh");
  });

  it("a status read that failed before its first answer → stale with no time", () => {
    const at = { ...reads(NOW - 1_000), mode: null };
    expect(wallFreshness(at, { ...none, mode: true }, true, NOW)).toEqual({ state: "stale", updatedAt: null });
  });

  it("a modules read that failed before its first answer → stale, never 'Waiting' for ever", () => {
    expect(wallFreshness(reads(null), { ...none, modules: true }, true, NOW)).toEqual({ state: "stale", updatedAt: null });
  });

  it("a failure AFTER an answer keeps the answer until it is 45 s old", () => {
    expect(wallFreshness(reads(NOW - 10_000), { ...none, counts: true }, true, NOW).state).toBe("fresh");
    expect(wallFreshness(reads(NOW - 50_000), { ...none, counts: true }, true, NOW).state).toBe("stale");
  });

  it("offline wins even when fresh, and keeps the time", () => {
    expect(wallFreshness(reads(NOW - 1_000), none, false, NOW)).toEqual({ state: "offline", updatedAt: NOW - 1_000 });
  });
});

describe("the sources cell (T-D2)", () => {
  it("every source ok → All reporting", () => {
    expect(sourcesHeadline([row("camera_ingest", "ok"), row("camera_system", "ok"), row("threat_mirror", "ok")])).toBe(WALL_COPY.sourcesAllReporting);
  });

  it("one quiet source → '1 quiet', never All reporting", () => {
    expect(sourcesHeadline([row("camera_ingest", "quiet"), row("camera_system", "ok")])).toBe("1 quiet");
  });

  it("not reporting outranks quiet outranks not set up", () => {
    expect(sourcesHeadline([row("camera_ingest", "not_configured"), row("camera_system", "quiet"), row("threat_mirror", "down")])).toBe("1 not reporting");
    expect(sourcesHeadline([row("camera_ingest", "not_configured"), row("camera_system", "quiet"), row("threat_mirror", "quiet")])).toBe("2 quiet");
    expect(sourcesHeadline([row("camera_ingest", "not_configured"), row("threat_mirror", "ok")])).toBe("1 not set up");
    expect(sourcesHeadline([row("camera_ingest", "down"), row("camera_system", "down")])).toBe("2 not reporting");
  });

  it("rows that are not event sources never move it: learning patterns, record keeping, alerts, the mode, the engine", () => {
    const others = [row("site_mode", "down"), row("incidents", "down"), row("alerts", "down"), row("links", "not_configured"), row("patterns", "quiet"), row("retention", "quiet")];
    expect(sourcesHeadline([row("camera_ingest", "ok"), ...others])).toBe(WALL_COPY.sourcesAllReporting);
    expect(sourceRows(others)).toEqual([]);
  });

  // #2423 review 13: `links` reached the wall unclassified and, counted as a source, read "1 not set up" whenever
  // linking was off. An id this build does not know is never a source: the sources cell claims only what it knows.
  it("an id this build does not know is never a source; the known ones keep the server's order", () => {
    const rows = [row("camera_system", "ok"), row("digest_v9", "down"), row("camera_ingest", "quiet")];
    expect(sourceRows(rows).map((r) => r.id)).toEqual(["camera_system", "camera_ingest"]);
    expect(sourcesHeadline(rows)).toBe("1 quiet");
    expect(sourcesHeadline([row("camera_ingest", "ok"), row("summaries_v9", "not_configured")])).toBe(WALL_COPY.sourcesAllReporting);
  });

  it("Droplet's links are not a source: linking turned off (or down) never moves the sources cell", () => {
    expect(WALL_ROW_ROLE.links).toBe("other");
    for (const state of ["not_configured", "down", "quiet"] as const) {
      expect(sourcesHeadline([row("camera_ingest", "ok"), row("threat_mirror", "ok"), row("links", state)]), state).toBe(WALL_COPY.sourcesAllReporting);
    }
  });

  it("WARP-2977: the door locks are a source — in the server's order, and they move the headline like any other", () => {
    const rows = [row("camera_ingest", "ok"), row("camera_system", "ok"), row("locks", "down"), row("threat_mirror", "ok"), row("incidents", "ok")];
    expect(sourceRows(rows).map((r) => r.id)).toEqual(["camera_ingest", "camera_system", "locks", "threat_mirror"]);
    expect(sourcesHeadline(rows)).toBe("1 not reporting");
    expect(sourcesHeadline([row("camera_ingest", "ok"), row("locks", "not_configured")])).toBe("1 not set up");
  });

  it("no source row at all is no claim", () => {
    expect(sourcesHeadline([row("patterns", "ok")])).toBe(WALL_COPY.unknownValue);
  });

  it("every known row is classified, and only camera events, the camera system, the door locks and the warnings are sources", () => {
    expect(Object.entries(WALL_ROW_ROLE).filter(([, role]) => role === "source").map(([id]) => id)).toEqual([
      "camera_ingest",
      "camera_system",
      "locks",
      "threat_mirror",
    ]);
  });
});

describe("countBehind (T-D3) — one case per cause, each line true for it", () => {
  it.each([
    ["the engine is not running", [row("incidents", "down")], "unsorted"],
    ["it hasn't sorted for 2 min", [row("incidents", "down"), row("camera_ingest", "ok")], "unsorted"],
    ["events failed triage in the last day", [row("incidents", "down"), row("camera_ingest", "quiet")], "unsorted"],
    ["not subscribed to the camera system", [row("incidents", "ok"), row("camera_ingest", "down")], "camera_events"],
    ["camera events arrive but can't be saved", [row("incidents", "ok"), row("camera_ingest", "down")], "camera_events"],
    ["the warning mirror is not scheduled (owner/admin row)", [row("incidents", "ok"), row("threat_mirror", "down")], "warnings"],
    ["both engine and cameras down → the engine first", [row("incidents", "down"), row("camera_ingest", "down")], "unsorted"],
  ] as const)("%s", (_why, rows, expected) => {
    expect(countBehind(rows as unknown as SecurityHealthRow[])).toBe(expected);
  });

  it.each([
    ["quiet cameras", [row("incidents", "ok"), row("camera_ingest", "quiet")]],
    ["no camera system", [row("incidents", "ok"), row("camera_ingest", "not_configured")]],
    ["the camera system itself down (that is an incident of its own)", [row("incidents", "ok"), row("camera_system", "down")]],
    ["a quiet warning mirror (registered, not run yet)", [row("incidents", "ok"), row("threat_mirror", "quiet")]],
    // WARP-2977 (D21): a lock row never forms an incident, so a lock outage cannot leave the number short.
    ["the door locks not reporting", [row("incidents", "ok"), row("camera_ingest", "ok"), row("locks", "down")]],
  ] as const)("%s → not behind", (_why, rows) => {
    expect(countBehind(rows as unknown as SecurityHealthRow[])).toBeNull();
  });

  it("the lines say 'may be behind' and never blame the wrong thing", () => {
    expect(BEHIND_COPY.unsorted).toBe("Some events haven't been sorted, so this may be behind.");
    expect(BEHIND_COPY.camera_events).toBe("Camera events aren't getting through, so this may be behind.");
    expect(BEHIND_COPY.warnings).toMatch(/may be behind\.$/);
  });
});

describe("sessionWarning (T-D4)", () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  it("shows from exactly 30 minutes out until the end", () => {
    expect(sessionWarning(at(30 * 60_000), NOW)).toBe(true);
    expect(sessionWarning(at(1_000), NOW)).toBe(true);
    expect(sessionWarning(at(1), NOW)).toBe(true);
  });
  it("not before the last half hour, not at or after the end, not without a time", () => {
    expect(sessionWarning(at(30 * 60_000 + 1_000), NOW)).toBe(false);
    expect(sessionWarning(at(0), NOW)).toBe(false);
    expect(sessionWarning(at(-60_000), NOW)).toBe(false);
    expect(sessionWarning(null, NOW)).toBe(false);
  });
});

describe("the wall's retry policy (T-D5)", () => {
  afterEach(() => vi.useRealTimers());

  it("15 s, 30 s, 60 s, then 120 s for good", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(wallRetryDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
  });

  it.each([
    ["a 503", Object.assign(new Error("down"), { status: 503 })],
    ["a 404 (the module gate's answer when it cannot read the toggle)", Object.assign(new Error("gone"), { status: 404 })],
    ["a timeout", Object.assign(new Error("slow"), { code: "TIMEOUT", status: 0 })],
  ])("retries %s after exactly the backoff", (_why, err) => {
    vi.useFakeTimers();
    const revalidate = vi.fn();
    wallOnErrorRetry(err, ["security-wall", "counts"], {}, revalidate, { retryCount: 2, dedupe: true });
    vi.advanceTimersByTime(29_999);
    expect(revalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revalidate).toHaveBeenCalledWith({ retryCount: 2, dedupe: true });
  });
});

describe("tileRetryDelayMs — from a tile's own 3 s cadence", () => {
  it("3 s, 6 s, 12 s … and never past 2 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(tileRetryDelayMs)).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 96_000, 120_000, 120_000]);
  });
});

describe("tileGrid — every camera on screen, in the nearest square", () => {
  it.each([
    [1, 1, 1],
    [2, 2, 1],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [7, 3, 3],
    [9, 3, 3],
    [10, 4, 3],
    [12, 4, 3],
    [13, 4, 4],
  ])("%i cameras → %i × %i", (n, cols, rows) => {
    const g = tileGrid(n);
    expect(g).toEqual({ cols, rows });
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
  });
});

// WARP-2981 F14: on a TV the tiles get what the banners and the strip leave (wall.css), so the grid follows that box.
// The boxes are `.sec-wall-tiles`' content at 960×540: 928 px wide; 398 px tall with nothing wrong (the strip 126 px),
// 208 px with both banners and two sources down (the strip 191 px, the banners 125 px), 328 px with the stale banner alone.
describe("tileGrid — from the tiles' own box (F14)", () => {
  const box = (height: number, width = 928) => ({ width, height });

  it("with room for a 72 px picture the near-square grid stays, so a healthy wall does not move", () => {
    // 4 × 3 at 398 px: (398 − 2 × 8) / 3 − 39 = 88 px pictures.
    expect(tileGrid(12, box(398))).toEqual({ cols: 4, rows: 3 });
    expect(tileGrid(9, box(398))).toEqual({ cols: 3, rows: 3 });
    expect(tileGrid(4, box(398))).toEqual({ cols: 2, rows: 2 });
    // The floor is inclusive: 2 × 2 keeps its 72 px pictures at 230 px ((230 − 8) / 2 − 39) and gives them up at 229.
    expect(tileGrid(4, box(230))).toEqual({ cols: 2, rows: 2 });
    expect(tileGrid(4, box(229))).not.toEqual({ cols: 2, rows: 2 });
  });

  it("without a box, or before it is measured (0 × 0), it is the near-square grid", () => {
    for (const n of [1, 3, 7, 12]) {
      expect(tileGrid(n, undefined)).toEqual(tileGrid(n));
      expect(tileGrid(n, { width: 0, height: 0 })).toEqual(tileGrid(n));
      expect(tileGrid(n, { width: 928, height: 0 })).toEqual(tileGrid(n));
      expect(tileGrid(n, { width: 0, height: 398 })).toEqual(tileGrid(n));
    }
  });

  it("too short for it, fewer rows and more columns: 12 cameras → 6 × 2, not 4 × 3, both banners and two sources down", () => {
    expect(tileGrid(12, box(208))).toEqual({ cols: 6, rows: 2 });
    expect(tileGrid(9, box(208))).toEqual({ cols: 5, rows: 2 });
    // 4 and 3 cameras go to one row: 2 × 2 would leave 61 px pictures where 4 × 1 leaves 127 px.
    expect(tileGrid(4, box(208))).toEqual({ cols: 4, rows: 1 });
    expect(tileGrid(3, box(208))).toEqual({ cols: 3, rows: 1 });
    // With the stale banner alone (328 px) 12 cameras were 65 px pictures at 4 × 3; 6 × 2 is 121 px high, 83 px of it a 16:9 picture.
    expect(tileGrid(12, box(328))).toEqual({ cols: 6, rows: 2 });
  });

  it("never so many columns that the pictures get narrower than the room gains in height", () => {
    // 12 × 1 has 169 px of height but each cell is 70 px wide, so its 16:9 picture is 39 px high; 6 × 2's is 61.
    expect(tileGrid(12, box(208))).not.toEqual({ cols: 12, rows: 1 });
    // On a very wide, very short box one row wins: 3 cameras in 1800 × 100 px.
    expect(tileGrid(3, { width: 1800, height: 100 })).toEqual({ cols: 3, rows: 1 });
  });

  it("holds every camera, and is never taller than the near-square grid", () => {
    for (let n = 1; n <= 12; n++)
      for (const height of [60, 120, 208, 260, 328, 398, 600, 903])
        for (const width of [609, 928, 1888]) {
          const g = tileGrid(n, { width, height });
          expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
          expect(g.rows).toBeLessThanOrEqual(tileGrid(n).rows);
          expect(g.cols).toBeGreaterThanOrEqual(tileGrid(n).cols);
        }
  });

  it("its floor is wall.css's frame floor", () => {
    expect(WALL_TILE_MIN_PICTURE_PX).toBe(72);
  });
});

describe("wallRunsFor (D6: \"Member wall, own cameras\")", () => {
  it.each([
    ["family", true],
    // Every read the wall makes is floored at owner/admin/family on the server: a guest wall only collects 403s.
    ["guest", false],
    ["owner", false],
    ["admin", false],
    ["service", false],
    [undefined, false],
    [null, false],
  ])("%s → %s", (role, runs) => {
    expect(wallRunsFor(role)).toBe(runs);
  });
});

describe("the TV view's copy (D6)", () => {
  it("the header link's tooltip names the account a TV runs on, in the household's word for the tier", () => {
    expect(WALL_COPY.linkTitle).toContain(`with a ${tierLabel("family")} account`);
    expect(WALL_COPY.linkTitle).not.toMatch(/family|what the signed-in account can see/);
  });

  it("a tile's state line is short enough to sit on a 72 px picture: a few words, no sentence", () => {
    for (const key of ["tileConnecting", "tileLost", "tileNotSending", "tileOff"] as const) {
      expect(WALL_COPY[key].length).toBeLessThanOrEqual(20);
      expect(WALL_COPY[key]).not.toMatch(/\. /);
    }
  });

  it("the notices name the device as the wall's banners do — 'this screen', never 'this TV'", () => {
    for (const key of ["refusedWhat", "refusedSignOut", "signedOutBody", "signedOutAction"] as const) {
      expect(WALL_COPY[key]).toMatch(/this screen|here/i);
      expect(WALL_COPY[key]).not.toMatch(/this TV/i);
    }
    // A first visit was never signed in: no "again".
    expect(WALL_COPY.signedOutBody).not.toMatch(/again/);
  });
});
