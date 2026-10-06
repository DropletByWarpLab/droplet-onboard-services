/**
 * WARP-3537 — the table and grouping read through the SAME query API as the board
 * and list (WARP-3522): a sort and a group-by are arguments of the one query hook,
 * not a second way to ask. These tests pin what goes on the wire:
 *
 *   • `sort` rides every page — the server's cursor is bound to it, so a page
 *     fetched under another sort would be refused;
 *   • `groupBy` rides the FIRST page only — its `groups` are exact per-group counts
 *     for the whole result, one answer per query, not one per page;
 *   • either changing is a new query, not a reuse of the last.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";
import type { PmFilter, PmGroupByField, PmSortSpec } from "@droplet/shared-types";

const h = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authFetch: h.authFetch, useAuth: () => ({ user: null }) }));

import { useWorkItemQuery } from "./usePm";

const FILTER: PmFilter = { and: [] };
const SORT_A: PmSortSpec[] = [{ field: "dueDate", dir: "asc" }];
const SORT_B: PmSortSpec[] = [{ field: "priority", dir: "desc" }];

function page(over: Record<string, unknown>) {
  return { ok: true, json: async () => ({ work_items: [], nextCursor: null, total: 0, ...over }) };
}
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);
const bodies = () => h.authFetch.mock.calls.map((c) => JSON.parse(c[1].body as string) as Record<string, unknown>);

beforeEach(() => {
  h.authFetch.mockReset();
});

describe("useWorkItemQuery: sort and group-by", () => {
  it("sends the sort on every page and the group-by on the first only", async () => {
    // Answer by what is asked, not by call order: SWR revalidates the first page when
    // the second is added.
    h.authFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const { cursor } = JSON.parse(init.body) as { cursor: string | null };
      return cursor === null
        ? page({ nextCursor: "c1", total: 2, groups: [{ key: "high", count: 2 }] })
        : page({ nextCursor: null, total: 2 });
    });

    const { result } = renderHook(
      () => useWorkItemQuery({ enabled: true, projectId: "p1", filter: FILTER, sort: SORT_A, groupBy: "priority" }),
      { wrapper },
    );
    // (SWR also revalidates the first page when the second is added, so assert over
    // every call by its cursor rather than by position.)
    await waitFor(() => expect(bodies().some((b) => b.cursor === "c1")).toBe(true));

    const firstPages = bodies().filter((b) => b.cursor === null);
    const laterPages = bodies().filter((b) => b.cursor === "c1");
    expect(firstPages.length).toBeGreaterThan(0);
    for (const b of firstPages) expect(b).toMatchObject({ projectId: "p1", sort: SORT_A, groupBy: "priority" });
    for (const b of laterPages) {
      expect(b).toMatchObject({ projectId: "p1", sort: SORT_A });
      expect(b).not.toHaveProperty("groupBy");
    }

    await waitFor(() => expect(result.current.groups).toEqual([{ key: "high", count: 2 }]));
  });

  it("sends neither when none is asked for — the board and list ask exactly what they did before", async () => {
    h.authFetch.mockResolvedValue(page({}));
    renderHook(() => useWorkItemQuery({ enabled: true, projectId: "p1", filter: FILTER }), { wrapper });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalledTimes(1));
    const [only] = bodies();
    expect(only).not.toHaveProperty("sort");
    expect(only).not.toHaveProperty("groupBy");
  });

  it("asks again when the sort changes, and again when the group-by does", async () => {
    h.authFetch.mockResolvedValue(page({}));
    const initialProps: { sort?: PmSortSpec[]; groupBy?: PmGroupByField } = { sort: SORT_A, groupBy: "state" };
    const { rerender } = renderHook(
      (p: { sort?: PmSortSpec[]; groupBy?: PmGroupByField }) =>
        useWorkItemQuery({ enabled: true, projectId: "p1", filter: FILTER, ...p }),
      { wrapper, initialProps },
    );
    await waitFor(() => expect(h.authFetch).toHaveBeenCalledTimes(1));

    rerender({ sort: SORT_B, groupBy: "state" });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalledTimes(2));
    expect(bodies()[1]).toMatchObject({ sort: SORT_B, groupBy: "state" });

    rerender({ sort: SORT_B, groupBy: "priority" });
    await waitFor(() => expect(h.authFetch).toHaveBeenCalledTimes(3));
    expect(bodies()[2]).toMatchObject({ sort: SORT_B, groupBy: "priority" });
  });

  it("does not ask again for an equal sort in a new array", async () => {
    h.authFetch.mockResolvedValue(page({}));
    const { rerender } = renderHook(
      (p: { sort: PmSortSpec[] }) => useWorkItemQuery({ enabled: true, projectId: "p1", filter: FILTER, sort: p.sort }),
      { wrapper, initialProps: { sort: [{ field: "dueDate", dir: "asc" }] as PmSortSpec[] } },
    );
    await waitFor(() => expect(h.authFetch).toHaveBeenCalledTimes(1));
    rerender({ sort: [{ field: "dueDate", dir: "asc" }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.authFetch).toHaveBeenCalledTimes(1);
  });
});
