/**
 * ADR-055 P4b — the doors hooks, driven for real.
 *
 * The page test replaces `@/lib/api`'s fetchers too, so it cannot see what the
 * hooks do with them. This file mocks one layer LOWER — the fetchers and
 * writers — and drives the real hooks inside a real SWRConfig: that the list
 * asks for retired doors too, that a write re-reads the list, that a failed
 * write throws and leaves the list alone, and that the log pages by the cursor
 * the box handed back. (The wire itself is pinned in lib/api.doors.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const api = vi.hoisted(() => ({
  getDoors: vi.fn(),
  getDoorEvents: vi.fn(),
  createDoor: vi.fn(),
  patchDoor: vi.fn(),
  retireDoor: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  ...api,
}));

import { useDoorEvents, useDoors } from "../useDoors";

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>{children}</SWRConfig>;
}

const door = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  doorPositionSource: "lock",
  heldOpenSeconds: 30,
  status: "active",
  retiredAt: null,
  position: "closed",
  positionSince: "2026-09-29T18:02:00.000Z",
  claims: { forcedDoor: "latch_witnessed", heldOpen: true },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});
const event = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  doorId: "d1",
  doorName: "Front door",
  kind: "door_open",
  occurredAt: "2026-09-29T18:02:00.000Z",
  forcedClaim: null,
  troubleCode: null,
  derivedFromId: null,
  correlationKey: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getDoors.mockResolvedValue({ doors: [door("d1", "Front door")] });
  api.getDoorEvents.mockResolvedValue({ events: [event("3"), event("2")], nextCursor: "1790000000000_2" });
});

describe("useDoors", () => {
  it("reads the doors, retired ones included (the page files them apart)", async () => {
    const { result } = renderHook(() => useDoors(), { wrapper });
    expect(result.current.doors).toBeNull();
    await waitFor(() => expect(result.current.doors).toHaveLength(1));
    expect(api.getDoors).toHaveBeenCalledWith({ includeRetired: true });
  });

  it.each([
    ["create", (h: ReturnType<typeof useDoors>) => h.create({ name: "Side door", doorPositionSource: "none" }), "createDoor"],
    ["patch", (h: ReturnType<typeof useDoors>) => h.patch("d1", { name: "Back door" }), "patchDoor"],
    ["retire", (h: ReturnType<typeof useDoors>) => h.retire("d1"), "retireDoor"],
  ] as const)("%s sends the write and then re-reads the list", async (_name, run, writer) => {
    api[writer].mockResolvedValue({ door: door("d1", "Front door") });
    const { result } = renderHook(() => useDoors(), { wrapper });
    await waitFor(() => expect(result.current.doors).toHaveLength(1));
    const reads = api.getDoors.mock.calls.length;
    api.getDoors.mockResolvedValue({ doors: [door("d1", "Front door"), door("d2", "Side door")] });
    await act(async () => {
      await run(result.current);
    });
    expect(api[writer]).toHaveBeenCalledTimes(1);
    expect(api.getDoors.mock.calls.length).toBeGreaterThan(reads);
    await waitFor(() => expect(result.current.doors).toHaveLength(2));
  });

  it("a failed write throws the typed error to the caller and does not re-read", async () => {
    const forbidden = Object.assign(new Error("HTTP 403"), { status: 403 });
    api.retireDoor.mockRejectedValue(forbidden);
    const { result } = renderHook(() => useDoors(), { wrapper });
    await waitFor(() => expect(result.current.doors).toHaveLength(1));
    const reads = api.getDoors.mock.calls.length;
    await act(async () => {
      await expect(result.current.retire("d1")).rejects.toBe(forbidden);
    });
    expect(api.getDoors.mock.calls.length).toBe(reads);
  });

  it("a failed read is an error and no doors, never an empty list", async () => {
    api.getDoors.mockRejectedValue(Object.assign(new Error("HTTP 503"), { status: 503 }));
    const { result } = renderHook(() => useDoors(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.doors).toBeNull();
  });
});

describe("useDoorEvents", () => {
  it("reads the first page with no cursor, and says there is more", async () => {
    const { result } = renderHook(() => useDoorEvents(), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(api.getDoorEvents).toHaveBeenCalledWith({ cursor: null });
    expect(result.current.hasMore).toBe(true);
  });

  it("loadMore asks for the page after the cursor the box handed back, and appends it", async () => {
    const { result } = renderHook(() => useDoorEvents(), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    api.getDoorEvents.mockResolvedValueOnce({ events: [event("3"), event("2")], nextCursor: "1790000000000_2" });
    api.getDoorEvents.mockResolvedValueOnce({ events: [event("1")], nextCursor: null });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events.map((e) => e.id)).toEqual(["3", "2", "1"]));
    expect(api.getDoorEvents).toHaveBeenCalledWith({ cursor: "1790000000000_2" });
    expect(result.current.hasMore).toBe(false);
  });

  it("loadMore on the last page asks for nothing more", async () => {
    api.getDoorEvents.mockResolvedValue({ events: [event("1")], nextCursor: null });
    const { result } = renderHook(() => useDoorEvents(), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    const calls = api.getDoorEvents.mock.calls.length;
    act(() => result.current.loadMore());
    expect(api.getDoorEvents.mock.calls.length).toBe(calls);
  });

  it("a failed read is an error, not an empty log", async () => {
    api.getDoorEvents.mockRejectedValue(Object.assign(new Error("HTTP 503"), { status: 503 }));
    const { result } = renderHook(() => useDoorEvents(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.events).toEqual([]);
  });
});
