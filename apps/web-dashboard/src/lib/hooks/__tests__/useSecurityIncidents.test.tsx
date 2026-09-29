/**
 * WARP-3185 C — the Incidents list's paging (GET /api/security/incidents,
 * keyset cursor `<ms>.<id>`, useSWRInfinite).
 *
 *   · an incident that moves between pages while the list is open (new
 *     activity lifts it to page 1 before page 2 is re-read) is listed ONCE;
 *   · pages past the first don't go stale: the 15 s refresh re-reads every
 *     page the person loaded, not only the first (SWR's default for an
 *     infinite list is page 1 only).
 *
 * A real SWR with its own cache, so what is pinned is what SWR actually asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { IncidentSummary, IncidentsPage } from "@/lib/types";

const h = vi.hoisted(() => ({ getSecurityIncidents: vi.fn() }));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getSecurityIncidents: h.getSecurityIncidents,
}));

import { useSecurityIncidents } from "../useSecurity";

function incident(id: string, over: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    id,
    scope: "area",
    zone: { id: "z1", name: "Stock room", kind: "restricted" },
    camera: null,
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence"],
    grouping: "closed",
    openedInMode: "closed",
    firstActivityAt: "2026-09-23T01:14:00.000Z",
    lastActivityAt: "2026-09-23T01:20:00.000Z",
    eventCount: 1,
    labels: { person: 1 },
    lastAck: null,
    ...over,
  };
}

function page(incidents: IncidentSummary[], nextCursor: string | null): IncidentsPage {
  return { incidents, nextCursor };
}

function Wrap({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

const FILTER = { state: "all" as const, limit: 2 };
const CURSOR = "1790000000000.7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f";

beforeEach(() => {
  h.getSecurityIncidents.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSecurityIncidents — cursor paging", () => {
  it("Show older asks for the next page by the cursor the last page gave, and appends it", async () => {
    h.getSecurityIncidents.mockImplementation(async (q: { cursor?: string | null }) =>
      q.cursor === CURSOR ? page([incident("c")], null) : page([incident("a"), incident("b")], CURSOR),
    );
    const { result } = renderHook(() => useSecurityIncidents(FILTER), { wrapper: Wrap });
    await waitFor(() => expect(result.current.incidents?.map((i) => i.id)).toEqual(["a", "b"]));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.incidents?.map((i) => i.id)).toEqual(["a", "b", "c"]));
    expect(h.getSecurityIncidents).toHaveBeenCalledWith(expect.objectContaining({ ...FILTER, cursor: CURSOR }));
    expect(result.current.hasMore).toBe(false);
  });

  it("an incident that moved between pages is listed once — where it stands now, on the newer page", async () => {
    h.getSecurityIncidents.mockImplementation(async (q: { cursor?: string | null }) =>
      q.cursor === CURSOR
        ? page([incident("b", { state: "acknowledged" }), incident("c")], null)
        : page([incident("a"), incident("b")], CURSOR),
    );
    const { result } = renderHook(() => useSecurityIncidents(FILTER), { wrapper: Wrap });
    await waitFor(() => expect(result.current.incidents?.length).toBe(2));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.incidents?.map((i) => i.id)).toEqual(["a", "b", "c"]));
    expect(result.current.incidents?.find((i) => i.id === "b")?.state).toBe("open");
  });

  it("the 15 s refresh re-reads every page the person loaded, so older pages don't go stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let olderState: IncidentSummary["state"] = "open";
    h.getSecurityIncidents.mockImplementation(async (q: { cursor?: string | null }) =>
      q.cursor === CURSOR ? page([incident("c", { state: olderState })], null) : page([incident("a"), incident("b")], CURSOR),
    );
    const { result } = renderHook(() => useSecurityIncidents(FILTER), { wrapper: Wrap });
    await waitFor(() => expect(result.current.incidents?.length).toBe(2));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.incidents?.length).toBe(3));

    // Someone resolves the older incident; the list stays open.
    olderState = "resolved";
    h.getSecurityIncidents.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_500);
    });
    await waitFor(() => expect(h.getSecurityIncidents).toHaveBeenCalledWith(expect.objectContaining({ cursor: CURSOR })));
    await waitFor(() => expect(result.current.incidents?.find((i) => i.id === "c")?.state).toBe("resolved"));
  });
});
