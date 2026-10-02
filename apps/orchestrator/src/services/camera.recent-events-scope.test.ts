/**
 * WARP-2982 review follow-up — `getRecentEvents` holds the per-camera scope
 * on its CACHE path too, not only on the Frigate path.
 *
 * The recent-events cache is keyed by camera list, not by caller, and a
 * cache hit used to return before the scope post-filter ran. Two ways that
 * leaked another camera's events:
 *
 *  1. An owner's read wrote whatever Frigate returned under a narrowed key;
 *     a scoped reader of the same key got those rows back unfiltered. (Real
 *     Frigate honours `cameras`, so this is the second layer the PR claims
 *     — the stub below ignores the filter to prove it holds.)
 *  2. The narrowed key `cameras:events:<names>` for a camera named `recent`
 *     WAS `CACHE_KEY_EVENTS` (`cameras:events:recent`) — the owner's
 *     all-camera list. `CAMERA_NAME_RE` accepts `recent`.
 *
 * The cache here is a real in-memory store, so a second call genuinely hits
 * what the first call wrote.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./cache.service.js", () => ({
  cacheGet: vi.fn(async (k: string) => store.get(k) ?? null),
  cacheSet: vi.fn(async (k: string, v: unknown) => {
    store.set(k, v);
  }),
  cacheDel: vi.fn(async (k: string) => {
    store.delete(k);
  }),
}));

type Row = { id: string; camera: string; label: string; start_time: number };
const frigateRows = vi.hoisted(() => ({ rows: [] as Row[], honourFilter: true }));
const fetchEvents = vi.hoisted(() =>
  vi.fn(async (limit: number, cameras?: string[]) =>
    frigateRows.rows
      .filter((r) => !frigateRows.honourFilter || !cameras || cameras.includes(r.camera))
      .sort((a, b) => b.start_time - a.start_time)
      .slice(0, limit),
  ),
);
vi.mock("./frigate.client.js", () => ({ fetchEvents }));

import { getRecentEvents } from "./camera.service.js";

const row = (id: string, camera: string, start_time: number): Row => ({
  id,
  camera,
  label: "person",
  start_time,
});

beforeEach(() => {
  store.clear();
  fetchEvents.mockClear();
});

describe("getRecentEvents re-applies the scope on a cache hit", () => {
  it("a scoped reader never gets another camera's rows from an owner-written entry", async () => {
    // Frigate ignores the camera filter: the owner's narrowed read caches
    // both cameras' rows under the front_door key.
    frigateRows.honourFilter = false;
    frigateRows.rows = [row("ev-bed", "bedroom", 2), row("ev-front", "front_door", 1)];
    try {
      const ownerView = await getRecentEvents("all", 20, "front_door");
      expect(ownerView.map((e) => e.camera).sort()).toEqual(["bedroom", "front_door"]);

      const scoped = await getRecentEvents(new Set(["front_door"]), 20);
      expect(fetchEvents).toHaveBeenCalledTimes(1); // non-vacuous: it WAS a cache hit
      expect(scoped.map((e) => e.camera)).toEqual(["front_door"]);
    } finally {
      frigateRows.honourFilter = true;
    }
  });

  it("a camera named `recent` never reads the owner's all-camera list", async () => {
    frigateRows.rows = [row("ev-bed", "bedroom", 2), row("ev-rec", "recent", 1)];

    const ownerView = await getRecentEvents("all", 20); // writes CACHE_KEY_EVENTS
    expect(ownerView.map((e) => e.camera).sort()).toEqual(["bedroom", "recent"]);

    const scoped = await getRecentEvents(new Set(["recent"]), 20);
    expect(scoped.map((e) => e.camera)).toEqual(["recent"]);
  });

  it("a camera named `recent` gets its own newest events, not a slice of the owner's", async () => {
    // The owner's two newest rows are both bedroom. Sharing the owner's key
    // (even filtered) would leave the `recent` viewer with nothing.
    frigateRows.rows = [
      row("ev-bed-2", "bedroom", 4),
      row("ev-bed-1", "bedroom", 3),
      row("ev-rec-2", "recent", 2),
      row("ev-rec-1", "recent", 1),
    ];

    await getRecentEvents("all", 2); // owner fills CACHE_KEY_EVENTS with bedroom only

    const scoped = await getRecentEvents(new Set(["recent"]), 2);
    expect(scoped.map((e) => e.id)).toEqual(["ev-rec-2", "ev-rec-1"]);
    expect(fetchEvents).toHaveBeenLastCalledWith(2, ["recent"]);
  });
});
