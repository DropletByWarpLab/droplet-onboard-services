// useProjectItems / useSubIssues — every page of a work-item list (WARP-3371).
//
// The board used to read one page of 100 and stop without a word. The hook now
// follows `nextCursor` until it is null, so a 250-item project is ALL 250 items,
// the first page paints before the rest have landed, and a page that fails
// after the first does not throw away the ones already in hand.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { PAGE_SIZE, useActivity, useComments, useProjectItems, useSubIssues } from "./usePm";

let TOTAL = 250;

/** Item `n` (1-based) in the shape the orchestrator sends. */
const wire = (n: number) => ({ id: `wi-${n}`, key: `INBOX-${n}`, name: `Item ${n}`, sortOrder: n });

const requested: string[] = [];
let failPage: ((url: string) => boolean) | null = null;
let delayPage: ((url: string) => number) | null = null;
/** When set, the server's cursor never advances: every page claims there is more. */
let neverAdvance = false;

/** A tiny server: pages of `limit` over TOTAL items, cursor = last id seen. */
function serve(url: string) {
  requested.push(url);
  const u = new URL(url, "http://box.test");
  const limit = Number(u.searchParams.get("limit") ?? 100);
  const cursor = u.searchParams.get("cursor");
  const after = cursor ? Number(cursor.replace("after-", "")) : 0;
  const rows = Array.from({ length: Math.min(limit, TOTAL - after) }, (_, i) => wire(after + i + 1));
  const last = after + rows.length;
  // The list the URL names: comments and activity are paged like work items.
  const key = u.pathname.endsWith("/comments") ? "comments" : u.pathname.endsWith("/activity") ? "activity" : "work_items";
  const nextCursor = neverAdvance ? `after-${after}` : last < TOTAL ? `after-${last}` : null;
  return { [key]: rows, nextCursor, total: TOTAL };
}

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(async (url: string) => {
    const wait = delayPage?.(url) ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (failPage?.(url)) {
      return { ok: false, status: 503, json: () => Promise.resolve({ error: "boom" }) } as Response;
    }
    return { ok: true, status: 200, json: () => Promise.resolve(serve(url)) } as Response;
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>;
}

/** A wrapper whose SWR cache survives an unmount, to model opening the board again. */
function sharedCacheWrapper() {
  const cache = new Map();
  return function Shared({ children }: { children: ReactNode }) {
    return <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>{children}</SWRConfig>;
  };
}

beforeEach(() => {
  neverAdvance = false;
  TOTAL = 250;
  requested.length = 0;
  failPage = null;
  delayPage = null;
});

describe("useProjectItems — follows the cursor to the last page", () => {
  it("250 items: every one arrives, in order, from two requests, and the total is exact", async () => {
    const { result } = renderHook(() => useProjectItems("p1"), { wrapper });

    await waitFor(() => expect(result.current.items).toHaveLength(TOTAL));
    expect(result.current.items!.map((i) => i.id)).toEqual(Array.from({ length: TOTAL }, (_, i) => `wi-${i + 1}`));
    expect(result.current.total).toBe(TOTAL);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loadError).toBeUndefined();
    expect(result.current.error).toBeUndefined();

    // PAGE_SIZE rows a request: 200 + 50, the second one driven by the cursor —
    // and the first page is read ONCE, not once more for every page after it.
    expect(PAGE_SIZE).toBe(200);
    expect(requested).toEqual([
      `/api/pm/projects/p1/work-items?limit=200`,
      `/api/pm/projects/p1/work-items?limit=200&cursor=after-200`,
    ]);
  });

  it("paints the first page BEFORE the rest has landed, and says more is coming", async () => {
    delayPage = (url) => (url.includes("cursor=") ? 80 : 0);
    const { result } = renderHook(() => useProjectItems("p1"), { wrapper });

    await waitFor(() => expect(result.current.items).toHaveLength(200));
    // 200 of 250 shown: the view can say "200 of 250" from these two facts.
    expect(result.current.total).toBe(TOTAL);
    expect(result.current.hasMore).toBe(true);

    await waitFor(() => expect(result.current.items).toHaveLength(TOTAL));
    expect(result.current.hasMore).toBe(false);
  });

  it("a page that fails after the first keeps the pages in hand: loadError, not error", async () => {
    failPage = (url) => url.includes("cursor=");
    const { result } = renderHook(() => useProjectItems("p1"), { wrapper });

    await waitFor(() => expect(result.current.loadError).toBeDefined());
    expect(result.current.items).toHaveLength(200);
    expect(result.current.hasMore).toBe(true);
    // `error` is reserved for "there is nothing to show".
    expect(result.current.error).toBeUndefined();
  });

  it("a FIRST page that fails is `error` — there is nothing to show", async () => {
    failPage = () => true;
    const { result } = renderHook(() => useProjectItems("p1"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.items).toBeUndefined();
    expect(result.current.loadError).toBeUndefined();
  });

  it("makes no request without a project", async () => {
    const { result } = renderHook(() => useProjectItems(null), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(requested).toEqual([]);
    expect(result.current.items).toBeUndefined();
  });

  it("a long chain costs one request per page: 1000 items is five requests, not fifteen", async () => {
    TOTAL = 1000;
    const { result } = renderHook(() => useProjectItems("p1"), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(1000));
    expect(requested).toHaveLength(5);
    expect(new Set(requested).size).toBe(5);
  });

  it("opening the board again re-reads a chain that is already cached (stale-while-revalidate)", async () => {
    const shared = sharedCacheWrapper();
    const first = renderHook(() => useProjectItems("p1"), { wrapper: shared });
    await waitFor(() => expect(first.result.current.items).toHaveLength(TOTAL));
    first.unmount();
    const before = requested.length;

    const second = renderHook(() => useProjectItems("p1"), { wrapper: shared });
    // The cached list paints immediately…
    expect(second.result.current.items).toHaveLength(TOTAL);
    // …and the chain is walked again behind it.
    await waitFor(() => expect(requested.length).toBe(before + 2));
  });

  it("re-reads every page when the tab regains focus — but not more than once per throttle window", async () => {
    // Move the clock, not the timers: SWR's own scheduling must keep running.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    // SWR registers its OWN global focus/visibility listener as
    // `setTimeout.bind(undefined, fn)`, so the dispatched Event becomes the
    // timer's delay: browsers coerce that silently, Node prints a
    // TimeoutNaNWarning. Nothing in this hook; keep the test output clean.
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      const { result } = renderHook(() => useProjectItems("p1"), { wrapper });
      await waitFor(() => expect(result.current.items).toHaveLength(TOTAL));
      const loaded = requested.length;

      // Straight after a load: throttled, nothing is re-read. (A real tab fires
      // both `focus` and `visibilitychange`; either one reaches the hook, and
      // `visibilitychange` leaves SWR's own global focus listener out of it.)
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 30));
      expect(requested.length).toBe(loaded);

      // Half a minute later the same event re-reads the whole chain.
      skew = 31_000;
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(requested.length).toBe(loaded + 2));
    } finally {
      now.mockRestore();
      warn.mockRestore();
    }
  });

  it("mutate() revalidates and resolves to the fresh FLATTENED list (the page reads `.work_items`)", async () => {
    const { result } = renderHook(() => useProjectItems("p1"), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(TOTAL));
    const before = requested.length;

    const fresh = await result.current.mutate();
    expect(fresh?.work_items).toHaveLength(TOTAL);
    expect(requested.length).toBeGreaterThan(before);
  });
});

describe("useSubIssues — a parent's children are paged the same way", () => {
  it("loads every child of a parent with more than one page of them", async () => {
    const { result } = renderHook(() => useSubIssues("p1", "parent-1"), { wrapper });
    await waitFor(() => expect(result.current.subIssues).toHaveLength(TOTAL));
    expect(requested[0]).toBe(`/api/pm/projects/p1/work-items?parent=parent-1&limit=200`);
    expect(requested[1]).toBe(`/api/pm/projects/p1/work-items?parent=parent-1&limit=200&cursor=after-200`);
  });
});

describe("comments and activity are read to the end too (WARP-3371)", () => {
  it("a thread of 250 comments is all 250, oldest first, from two requests", async () => {
    const { result } = renderHook(() => useComments("w1"), { wrapper });
    await waitFor(() => expect(result.current.comments).toHaveLength(TOTAL));
    expect(result.current.comments!.map((c) => c.id).slice(0, 3)).toEqual(["wi-1", "wi-2", "wi-3"]);
    expect(requested).toEqual([
      "/api/pm/work-items/w1/comments?limit=200",
      "/api/pm/work-items/w1/comments?limit=200&cursor=after-200",
    ]);
  });

  it("the activity feed is read to the end as well", async () => {
    const { result } = renderHook(() => useActivity("w1"), { wrapper });
    await waitFor(() => expect(result.current.activity).toHaveLength(TOTAL));
    expect(requested[1]).toBe("/api/pm/work-items/w1/activity?limit=200&cursor=after-200");
  });

  it("mutate() re-reads the whole thread (a posted comment lands at the END of a long one)", async () => {
    const { result } = renderHook(() => useComments("w1"), { wrapper });
    await waitFor(() => expect(result.current.comments).toHaveLength(TOTAL));
    const before = requested.length;
    TOTAL = 251; // somebody added a comment
    await result.current.mutate();
    await waitFor(() => expect(result.current.comments).toHaveLength(251));
    expect(requested.length).toBeGreaterThan(before);
  });

  it("makes no request without a work item", async () => {
    renderHook(() => useComments(null), { wrapper });
    renderHook(() => useActivity(null), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(requested).toEqual([]);
  });
});

describe("a server whose cursor never advances ends the walk — it does not become a request loop", () => {
  it("stops after at most ceil(total / PAGE_SIZE) + 2 pages and shows no row twice", async () => {
    neverAdvance = true;
    const { result } = renderHook(() => useProjectItems("p1"), { wrapper });
    await waitFor(() => expect(result.current.items).toBeDefined());
    // let any runaway loop show itself
    await new Promise((r) => setTimeout(r, 150));
    const pagesRequested = requested.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(requested.length).toBe(pagesRequested); // it has stopped asking
    expect(pagesRequested).toBeLessThanOrEqual(Math.ceil(TOTAL / PAGE_SIZE) + 2);
    // every page held the same rows: the list shows each once
    const ids = result.current.items!.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
