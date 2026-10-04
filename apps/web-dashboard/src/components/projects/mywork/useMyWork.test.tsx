import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { PmWorkItem } from "../types";
import type { PmMyWorkPage } from "./types";

const pmGet = vi.fn();
vi.mock("../calendar/pmGet", () => ({ pmGet: (url: string) => pmGet(url) }));

import { MY_WORK_PAGE_SIZE, myWorkUrl, useMyWork } from "./useMyWork";

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
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
    // Page 0 was fetched once; loading later pages did not re-request it.
    expect(pmGet.mock.calls.filter(([u]) => String(u).endsWith("offset=0"))).toHaveLength(1);
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

  it("surfaces a failed first page as an error with no items", async () => {
    pmGet.mockRejectedValueOnce(new Error("down"));
    const { result } = renderHook(() => useMyWork("created", "2026-10-03"), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.items).toEqual([]);
    expect(result.current.counts).toBeUndefined();
  });
});
