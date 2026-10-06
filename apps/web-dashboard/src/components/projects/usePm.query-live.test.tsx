import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishPmLiveFrame } from "@/lib/pm-live-events";

const h = vi.hoisted(() => ({ authFetch: vi.fn(), version: 0 }));
vi.mock("@/lib/auth", () => ({ authFetch: h.authFetch }));
import { useWorkItemByKey, useWorkItemQuery } from "./usePm";
import { usePmLive } from "./usePmLive";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);
const frame = (projectId: string, workItemId: string) => act(() => {
  publishPmLiveFrame("droplet/pm/ada", { type: "pm.changed", projectId, workItemId, verb: "updated" });
});
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
beforeEach(() => { h.authFetch.mockReset(); h.version = 0; });
afterEach(cleanup);

describe("live refresh of server queries and deep-linked items", () => {
  it("refreshes every loaded query page while leaving another project alone", async () => {
    h.authFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { projectId: string; cursor: string | null };
      const tail = body.cursor !== null;
      return response({ work_items: [{ id: `${body.projectId}-${tail ? 2 : 1}`, name: `${tail ? "Tail" : "First"} ${h.version}` }], total: 2, nextCursor: tail ? null : "tail" });
    });
    const { result } = renderHook(() => {
      usePmLive();
      const own = useWorkItemQuery({ enabled: true, projectId: "p1", filter: { and: [] } });
      const other = useWorkItemQuery({ enabled: true, projectId: "p2", filter: { and: [] } });
      return { own, other };
    }, { wrapper });
    await waitFor(() => {
      expect(result.current.own.items?.map(x => x.name)).toEqual(["First 0", "Tail 0"]);
      expect(result.current.other.items?.map(x => x.name)).toEqual(["First 0", "Tail 0"]);
    });
    const otherReads = () => h.authFetch.mock.calls.filter(c => JSON.parse(String(c[1].body)).projectId === "p2").length;
    const before = otherReads();
    h.version = 1;
    frame("p1", "p1-1");
    await waitFor(() => expect(result.current.own.items?.map(x => x.name)).toEqual(["First 1", "Tail 1"]));
    expect(result.current.other.items?.map(x => x.name)).toEqual(["First 0", "Tail 0"]);
    expect(otherReads()).toBe(before);
  });

  it("refreshes a mounted workspace query for any project change", async () => {
    h.authFetch.mockImplementation(async () => response({ work_items: [{ id: "w1", name: `Task ${h.version}` }], total: 1, nextCursor: null }));
    const { result } = renderHook(() => {
      usePmLive();
      return useWorkItemQuery({ enabled: true, projectId: null, filter: { and: [] } });
    }, { wrapper });
    await waitFor(() => expect(result.current.items?.[0].name).toBe("Task 0"));
    h.version = 1;
    frame("p9", "w9");
    await waitFor(() => expect(result.current.items?.[0].name).toBe("Task 1"));
  });

  it("refreshes a deep-linked drawer by its resolved identity and ignores unrelated items", async () => {
    h.authFetch.mockImplementation(async () => response({ work_item: { id: "w1", projectId: "p1", key: "RDM-1", name: `Task ${h.version}` } }));
    const { result } = renderHook(() => {
      usePmLive();
      return useWorkItemByKey("RDM-1", true);
    }, { wrapper });
    await waitFor(() => expect(result.current.item?.name).toBe("Task 0"));
    const before = h.authFetch.mock.calls.length;
    h.version = 1;
    frame("p2", "w2");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(h.authFetch.mock.calls).toHaveLength(before);
    frame("p1", "w1");
    await waitFor(() => expect(result.current.item?.name).toBe("Task 1"));
  });
});
