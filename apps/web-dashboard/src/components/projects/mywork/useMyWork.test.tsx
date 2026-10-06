import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { PmWorkItem } from "../types";
import type { PmMyWorkPage } from "./types";
import { publishPmLiveFrame } from "@/lib/pm-live-events";

const pmGet = vi.fn();
vi.mock("../calendar/pmGet", () => ({ pmGet: (url: string) => pmGet(url) }));

import { MY_WORK_PAGE_SIZE, myWorkUrl, useMyWork } from "./useMyWork";

// `focusThrottleInterval: 0`: SWR ignores a focus within 5s of the last revalidation
// (a real tab regains focus later than that); a test cannot wait that long.
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, focusThrottleInterval: 0 }}>{children}</SWRConfig>
);

function item(n: number, projectId: string): PmWorkItem {
  return { id: `w${n}`, projectId, key: `${projectId.toUpperCase()}-${n}`, name: `Item ${n}` } as unknown as PmWorkItem;
}

function page(over: Partial<PmMyWorkPage>): PmMyWorkPage {
  return {
    section: "assigned",
    today: "2026-10-03",
    items: [],
    projects: [],
    total: 0,
    counts: { assigned: 0, created: 0, overdue: 0, dueThisWeek: 0 },
    limit: MY_WORK_PAGE_SIZE,
    offset: 0,
    nextOffset: null,
    ...over,
  };
}

const P1 = { id: "p1", name: "Alpha", identifier: "AAA", icon: null, color: null };
const P2 = { id: "p2", name: "Bravo", identifier: "BBB", icon: null, color: null };
const COUNTS = { assigned: 3, created: 1, overdue: 2, dueThisWeek: 0 };

beforeEach(() => pmGet.mockReset());

describe("myWorkUrl", () => {
  it("carries the section, the viewer's day and the page window", () => {
    expect(myWorkUrl("overdue", "2026-10-03", 0)).toBe("/api/pm/my-work?section=overdue&today=2026-10-03&limit=100&offset=0");
    expect(myWorkUrl("due_this_week", "2026-10-03", 200, 50)).toBe(
      "/api/pm/my-work?section=due_this_week&today=2026-10-03&limit=50&offset=200",
    );
  });
});

describe("useMyWork", () => {
  it("loads the first page and exposes items, projects, counts and the exact total", async () => {
    pmGet.mockResolvedValueOnce(
      page({ items: [item(1, "p1"), item(2, "p2")], projects: [P1, P2], total: 2, counts: COUNTS, nextOffset: null }),
    );
    const { result } = renderHook(() => useMyWork("assigned", "2026-10-03"), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(pmGet).toHaveBeenCalledWith("/api/pm/my-work?section=assigned&today=2026-10-03&limit=100&offset=0");
    expect(result.current.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(result.current.counts).toEqual(COUNTS);
    expect(result.current.total).toBe(2);
    expect(result.current.hasMore).toBe(false);
  });

  it("loads further pages from the server's nextOffset until it says there are no more, merging projects once", async () => {
    const pages: Record<string, PmMyWorkPage> = {
      "0": page({ items: [item(1, "p1"), item(2, "p1")], projects: [P1], total: 5, counts: COUNTS, nextOffset: 2 }),
      "2": page({ items: [item(3, "p1"), item(4, "p2")], projects: [P1, P2], total: 5, counts: COUNTS, offset: 2, nextOffset: 4 }),
      "4": page({ items: [item(5, "p2")], projects: [P2], total: 5, counts: COUNTS, offset: 4, nextOffset: null }),
    };
    pmGet.mockImplementation(async (url: string) => pages[new URL(url, "http://x").searchParams.get("offset") ?? "0"]);
    const { result } = renderHook(() => useMyWork("assigned", "2026-10-03"), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    expect(pmGet).toHaveBeenLastCalledWith("/api/pm/my-work?section=assigned&today=2026-10-03&limit=100&offset=2");
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(5));
    expect(pmGet).toHaveBeenLastCalledWith("/api/pm/my-work?section=assigned&today=2026-10-03&limit=100&offset=4");
    expect(result.current.hasMore).toBe(false);
    expect(result.current.items.map((i) => i.id)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    expect(result.current.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(result.current.total).toBe(5);
    // Loading a later page also re-requests the first (SWR's revalidateFirstPage), which is
    // what keeps the counts and the head of the list fresh while someone pages through.
    expect(pmGet.mock.calls.filter(([u]) => String(u).endsWith("offset=0")).length).toBeGreaterThanOrEqual(2);
  });

  it("a different day is a different request, so the lists follow local midnight", async () => {
    pmGet.mockResolvedValue(page({ items: [item(1, "p1")], projects: [P1], total: 1, counts: COUNTS }));
    const { result, rerender } = renderHook(({ day }) => useMyWork("overdue", day), {
      wrapper,
      initialProps: { day: "2026-10-03" },
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    rerender({ day: "2026-10-04" });
    await waitFor(() =>
      expect(pmGet).toHaveBeenCalledWith("/api/pm/my-work?section=overdue&today=2026-10-04&limit=100&offset=0"),
    );
  });

  it("refetches the first page when the window regains focus, so new work shows up without a reload", async () => {
    pmGet.mockResolvedValueOnce(
      page({ items: [item(1, "p1")], projects: [P1], total: 1, counts: { ...COUNTS, assigned: 1 }, nextOffset: null }),
    );
    const { result } = renderHook(() => useMyWork("assigned", "2026-10-03"), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(pmGet).toHaveBeenCalledTimes(1);

    // A teammate assigns two more items while this tab is open.
    pmGet.mockResolvedValue(
      page({
        items: [item(1, "p1"), item(2, "p1"), item(3, "p1")],
        projects: [P1],
        total: 3,
        counts: { ...COUNTS, assigned: 3 },
        nextOffset: null,
      }),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.counts?.assigned).toBe(3);
    expect(pmGet).toHaveBeenCalledTimes(2);
  });

  it("revalidates the active personal section once after a live-event burst, through the session-scoped endpoint", async () => {
    pmGet.mockResolvedValueOnce(page({ items: [item(1, "p1")], projects: [P1], total: 1, counts: COUNTS }));
    pmGet.mockResolvedValue(page({ items: [item(2, "p2")], projects: [P2], total: 1, counts: COUNTS }));
    const { result } = renderHook(() => useMyWork("overdue", "2026-10-03"), { wrapper });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["w1"]));
    expect(pmGet).toHaveBeenCalledTimes(1);

    await act(async () => {
      publishPmLiveFrame("droplet/pm/alice", {
        type: "pm.changed", projectId: "p2", workItemId: "w2", verb: "assigned",
      });
      publishPmLiveFrame("droplet/pm/alice", {
        type: "pm.changed", projectId: "p2", workItemId: "w3", verb: "state_changed",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["w2"]));
    expect(pmGet).toHaveBeenCalledTimes(2);
    expect(pmGet).toHaveBeenLastCalledWith("/api/pm/my-work?section=overdue&today=2026-10-03&limit=100&offset=0");
    expect(pmGet.mock.calls.every(([url]) => !String(url).includes("user"))).toBe(true);
  });

  it("clears a pending live refresh when the section unmounts", async () => {
    pmGet.mockResolvedValue(page({ items: [item(1, "p1")], projects: [P1], total: 1, counts: COUNTS }));
    const { unmount } = renderHook(() => useMyWork("assigned", "2026-10-03"), { wrapper });
    await waitFor(() => expect(pmGet).toHaveBeenCalledTimes(1));
    publishPmLiveFrame("droplet/pm/alice", {
      type: "pm.changed", projectId: "p1", workItemId: "w1", verb: "updated",
    });
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pmGet).toHaveBeenCalledTimes(1);
  });

  it("a section that is opened again shows what it had, then refreshes it", async () => {
    const cache = new Map();
    const shared = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
    );
    pmGet.mockResolvedValueOnce(page({ items: [item(1, "p1")], projects: [P1], total: 1, counts: COUNTS }));
    const first = renderHook(() => useMyWork("assigned", "2026-10-03"), { wrapper: shared });
    await waitFor(() => expect(first.result.current.items).toHaveLength(1));
    first.unmount();

    pmGet.mockResolvedValue(
      page({ items: [item(1, "p1"), item(2, "p1"), item(3, "p1")], projects: [P1], total: 3, counts: COUNTS }),
    );
    const second = renderHook(() => useMyWork("assigned", "2026-10-03"), { wrapper: shared });
    expect(second.result.current.items).toHaveLength(1); // the cache, instantly
    await waitFor(() => expect(second.result.current.items).toHaveLength(3)); // then the truth
    expect(pmGet).toHaveBeenCalledTimes(2);
  });

  it("mutate() — Refresh, or an edit in the drawer — re-requests EVERY loaded page", async () => {
    const hits: Record<string, number> = {};
    const pages: Record<string, PmMyWorkPage> = {
      "0": page({ items: [item(1, "p1"), item(2, "p1")], projects: [P1], total: 3, counts: COUNTS, nextOffset: 2 }),
      "2": page({ items: [item(3, "p1")], projects: [P1], total: 3, counts: COUNTS, offset: 2, nextOffset: null }),
    };
    pmGet.mockImplementation(async (url: string) => {
      const offset = new URL(url, "http://x").searchParams.get("offset") ?? "0";
      hits[offset] = (hits[offset] ?? 0) + 1;
      return pages[offset];
    });
    const { result } = renderHook(() => useMyWork("assigned", "2026-10-03"), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    const before = { ...hits };

    await act(async () => {
      await result.current.mutate();
    });
    expect(hits["0"]).toBeGreaterThan(before["0"]);
    expect(hits["2"]).toBeGreaterThan(before["2"]);
  });

  it("surfaces a failed first page as an error with no items", async () => {
    pmGet.mockRejectedValueOnce(new Error("down"));
    const { result } = renderHook(() => useMyWork("created", "2026-10-03"), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.items).toEqual([]);
    expect(result.current.counts).toBeUndefined();
  });
});
