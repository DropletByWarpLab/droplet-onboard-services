/**
 * WARP-3536 — usePmLive: a `pm.changed` frame revalidates the PM reads it
 * affects, debounced to 250 ms, held while a card is being dragged.
 *
 * Real SWR with a fresh cache per test; `authFetch` is the only fake, and it
 * records every read, so what is asserted is what the browser would fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import useSWR, { SWRConfig } from "swr";
import { publishPmLiveFrame, notifyPmLiveResync } from "@/lib/pm-live-events";
import {
  keyAffectedBy,
  usePmLive,
  usePmLivePause,
  PM_LIVE_DEBOUNCE_MS,
  PM_LIVE_MAX_WAIT_MS,
} from "./usePmLive";

const fetched: string[] = [];

function frame(over: Partial<{ projectId: string; workItemId: string; verb: string }> = {}) {
  publishPmLiveFrame("droplet/pm/alice", {
    type: "pm.changed",
    projectId: "p-1",
    workItemId: "w-1",
    verb: "state_changed",
    ...over,
  });
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false } }, children);

/** Mount the live hook beside a set of SWR reads, the way the Projects page does. */
function mountPage(keys: string[]) {
  return renderHook(
    () => {
      usePmLive();
      for (const key of keys) {
        // eslint-disable-next-line react-hooks/rules-of-hooks -- a fixed list per mount
        useSWR(key, async (k: string) => {
          fetched.push(k);
          return { k };
        });
      }
    },
    { wrapper },
  );
}

const reads = (key: string) => fetched.filter((k) => k === key).length;

beforeEach(() => {
  fetched.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Let the initial mount fetches settle (SWR starts them on the next frame), then forget them. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  fetched.length = 0;
}

describe("keyAffectedBy", () => {
  const e = { projectId: "p-1", workItemId: "w-1" };
  it.each([
    ["/api/pm/summary", true],
    ["/api/pm/projects", true],
    ["/api/pm/projects?archived=1", true],
    ["/api/pm/my-work?section=assigned&today=2026-10-03&limit=100&offset=0", true],
    ["/api/pm/projects/p-1", true], // the project's own counts move with its items
    ["/api/pm/projects/p-1?x=1", true],
    ["/api/pm/projects/p-1/work-items", true],
    ["/api/pm/projects/p-1/work-items?parent=w-9", true],
    ["/api/pm/work-items/w-1/comments", true],
    ["/api/pm/work-items/w-1/activity", true],
    ["/api/pm/work-items/w-1", true],
    ["/api/pm/assigned-to-me", true],
    ["/api/pm/work-items?q=login", true],
    // another project's board, another item's drawer
    ["/api/pm/projects/p-2/work-items", false],
    ["/api/pm/work-items/w-2/comments", false],
    ["/api/pm/work-items/w-10/comments", false], // w-1 is a prefix of w-10, not the same item
    ["/api/pm/projects/p-10/work-items", false],
    ["/api/pm/projects/p-2", false],
    // nothing an item's activity can change
    ["/api/pm/projects/p-1/states", false],
    ["/api/pm/projects/p-1/labels", false],
    // not PM at all, or not a string key
    ["/api/crm/summary", false],
    ["/api/departments", false],
    ["notifications:unread", false],
  ])("%s -> %s", (key, expected) => {
    expect(keyAffectedBy(key, e)).toBe(expected);
  });

  it("ignores keys that are not strings", () => {
    expect(keyAffectedBy(["pm-presence", "w-1"], e)).toBe(false);
    expect(keyAffectedBy(null, e)).toBe(false);
    expect(keyAffectedBy(undefined, e)).toBe(false);
  });
});

describe("usePmLive", () => {
  it("revalidates the reads a frame affects, and only those", async () => {
    mountPage([
      "/api/pm/projects/p-1/work-items",
      "/api/pm/projects/p-2/work-items",
      "/api/pm/work-items/w-1/comments",
      "/api/pm/summary",
      "/api/pm/projects/p-1/states",
    ]);
    await settle();

    act(() => frame());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS);
    });

    expect(reads("/api/pm/projects/p-1/work-items")).toBe(1);
    expect(reads("/api/pm/work-items/w-1/comments")).toBe(1);
    expect(reads("/api/pm/summary")).toBe(1);
    expect(reads("/api/pm/projects/p-2/work-items")).toBe(0);
    expect(reads("/api/pm/projects/p-1/states")).toBe(0);
  });

  it("waits out a 250 ms debounce, and a burst becomes one refresh", async () => {
    mountPage(["/api/pm/projects/p-1/work-items"]);
    await settle();

    act(() => frame());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS - 1);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(0); // not yet

    // Four more frames inside the window, each restarting it.
    for (let i = 0; i < 4; i += 1) {
      act(() => frame({ workItemId: `w-${i + 2}` }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS - 50);
      });
    }
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(1);
  });

  it("never starves behind a stream: a refresh happens at least every max-wait", async () => {
    expect(PM_LIVE_MAX_WAIT_MS).toBeGreaterThan(PM_LIVE_DEBOUNCE_MS);
    mountPage(["/api/pm/projects/p-1/work-items"]);
    await settle();

    // A frame every 100 ms for 2.5 s: the quiet gap a plain debounce needs never comes.
    for (let t = 0; t < 2_500; t += 100) {
      act(() => frame({ workItemId: `w-${t}` }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(reads("/api/pm/projects/p-1/work-items")).toBeGreaterThanOrEqual(1);
    expect(reads("/api/pm/projects/p-1/work-items")).toBeLessThanOrEqual(2);
  });

  it("does nothing for a frame that arrives after unmount", async () => {
    const { unmount } = mountPage(["/api/pm/projects/p-1/work-items"]);
    await settle();
    act(() => frame());
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS * 4);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(0);
  });

  it("a resync (the socket came back) re-reads every PM read on screen", async () => {
    mountPage(["/api/pm/projects/p-1/work-items", "/api/pm/projects/p-2/work-items", "/api/pm/summary", "/api/other"]);
    await settle();

    act(() => notifyPmLiveResync());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS);
    });

    expect(reads("/api/pm/projects/p-1/work-items")).toBe(1);
    expect(reads("/api/pm/projects/p-2/work-items")).toBe(1);
    expect(reads("/api/pm/summary")).toBe(1);
    expect(reads("/api/other")).toBe(0); // not a PM read
  });

  it("collapses a flood of distinct items into a resync rather than growing without bound", async () => {
    mountPage(["/api/pm/projects/p-9/work-items"]); // a project none of the frames name
    await settle();

    for (let i = 0; i < 600; i += 1) act(() => frame({ projectId: `p-${i}`, workItemId: `w-${i}` }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS);
    });
    // 600 > the cap, so "something changed somewhere" re-reads what is on screen.
    expect(reads("/api/pm/projects/p-9/work-items")).toBe(1);
  });
});

describe("pausing while a card is held", () => {
  it("holds the refresh for the whole drag, then runs it once after the drop", async () => {
    mountPage(["/api/pm/projects/p-1/work-items"]);
    const drag = renderHook(({ on }) => usePmLivePause(on), { initialProps: { on: false }, wrapper });
    await settle();

    drag.rerender({ on: true }); // dragstart
    act(() => frame());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_MAX_WAIT_MS * 3);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(0); // nothing moved under the pointer

    act(() => frame({ workItemId: "w-2" })); // still held: more frames just queue
    drag.rerender({ on: false }); // dragend / drop
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(1);
  });

  it("a drag that was never joined by a frame leaves nothing to run", async () => {
    mountPage(["/api/pm/projects/p-1/work-items"]);
    const drag = renderHook(({ on }) => usePmLivePause(on), { initialProps: { on: true }, wrapper });
    await settle();
    drag.rerender({ on: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_MAX_WAIT_MS);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(0);
  });

  it("two holds at once: the refresh waits for BOTH", async () => {
    mountPage(["/api/pm/projects/p-1/work-items"]);
    const a = renderHook(({ on }) => usePmLivePause(on), { initialProps: { on: true }, wrapper });
    const b = renderHook(({ on }) => usePmLivePause(on), { initialProps: { on: true }, wrapper });
    await settle();

    act(() => frame());
    a.rerender({ on: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_MAX_WAIT_MS);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(0);

    b.rerender({ on: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(1);
  });

  it("a board that unmounts mid-drag releases the hold", async () => {
    mountPage(["/api/pm/projects/p-1/work-items"]);
    const drag = renderHook(({ on }) => usePmLivePause(on), { initialProps: { on: true }, wrapper });
    await settle();
    act(() => frame());
    drag.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PM_LIVE_DEBOUNCE_MS);
    });
    expect(reads("/api/pm/projects/p-1/work-items")).toBe(1);
  });
});
