/**
 * WARP-2981 (ADR-059 P6) — useSecurityWall, driven for real: the `@/lib/api`
 * fetchers are mocked one layer below and the real hook runs inside a real
 * SWRConfig with its own cache, so what is pinned is what SWR actually asks
 * for and when (T-D6):
 *
 *   · nothing Security-shaped is asked before the wall's own modules read has
 *     answered, nor when Security is not open to this person (each such read
 *     would be a feature-gate denial, which the threat mirror shows as a
 *     "threat");
 *   · this person's camera list is asked only when Security AND Cameras are
 *     open to them (D6: the wall's tiles are exactly that list);
 *   · every key is the wall's own (`["security-wall", …]`), never /security's;
 *   · every modules answer is mirrored into the nav gate's shared key;
 *   · a failed read is retried — a 404 included — and its success clears it;
 *   · a modules read that fails before it ever answers says so;
 *   · when each read last answered lives in the cache WITH its answer, so a
 *     remount over a warm cache still knows how old the values are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, type Cache } from "swr";
import type { ReactNode } from "react";

const api = vi.hoisted(() => ({
  getWallModules: vi.fn(),
  getSecurityIncidentCounts: vi.fn(),
  getSecurityWallHealth: vi.fn(),
  getSecurityMode: vi.fn(),
  getSignInEndsAt: vi.fn(),
  getWallCameras: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  ...api,
}));

import { useSecurityWall } from "../useSecurity";
import { MODULE_GATE_KEY } from "../useModuleGate";

const ON = { modules: [{ id: "security", effective: true }, { id: "cameras", effective: true }] };
const OFF = { modules: [{ id: "security", effective: false }, { id: "cameras", effective: true }] };
/** Security on for the box, but not open to this person (her per-user set lacks it). */
const NARROWED = { modules: ON.modules, effectiveForUser: [{ moduleId: "cameras", level: "view" }] };
const COUNTS = { openAlerts: 1, openNotices: 2 };
const SOURCES = { sources: [{ id: "camera_ingest", state: "ok", detail: "Listening", lastSeenAt: null }] };
const MODE = { mode: "closed", source: "schedule" };
const CAMERAS = [{ name: "till", displayName: "Till", status: "recording", enabled: true }];

let cache: Map<string, unknown>;
function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ dedupingInterval: 0, provider: () => cache as unknown as Cache }}>{children}</SWRConfig>;
}

function status(n: number): Error {
  return Object.assign(new Error(`HTTP ${n}`), { status: n });
}

const securityCalls = () =>
  api.getSecurityIncidentCounts.mock.calls.length +
  api.getSecurityWallHealth.mock.calls.length +
  api.getSecurityMode.mock.calls.length +
  api.getWallCameras.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  cache = new Map();
  api.getWallModules.mockResolvedValue(ON);
  api.getSecurityIncidentCounts.mockResolvedValue(COUNTS);
  api.getSecurityWallHealth.mockResolvedValue(SOURCES);
  api.getSecurityMode.mockResolvedValue(MODE);
  api.getSignInEndsAt.mockResolvedValue(null);
  api.getWallCameras.mockResolvedValue(CAMERAS);
});

afterEach(() => vi.useRealTimers());

describe("useSecurityWall — gated on its own modules read (T-D6)", () => {
  it("asks nothing Security-shaped until modules has answered", async () => {
    let answer: (v: unknown) => void = () => {};
    api.getWallModules.mockReturnValue(new Promise((r) => (answer = r)));
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(result.current.access).toBeNull();
    expect(securityCalls()).toBe(0);
    await act(async () => answer(ON));
    await waitFor(() => expect(result.current.counts).toEqual(COUNTS));
    expect(result.current.sources).toEqual(SOURCES.sources);
    expect(result.current.mode).toEqual(MODE);
    expect(result.current.access).toEqual({ security: true, cameras: true });
    await waitFor(() => expect(result.current.cameras).toEqual({ list: CAMERAS, failed: false }));
  });

  it("Cameras not open to this person: the Security reads, but never their camera list", async () => {
    api.getWallModules.mockResolvedValue({ modules: [{ id: "security", effective: true }, { id: "cameras", effective: false }] });
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(result.current.counts).toEqual(COUNTS));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(api.getWallCameras).not.toHaveBeenCalled();
    expect(result.current.cameras).toEqual({ list: null, failed: false });
  });

  it("a camera list that fails before it ever answered says so", async () => {
    api.getWallCameras.mockRejectedValue(status(503));
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(result.current.cameras).toEqual({ list: null, failed: true }));
  });

  it.each([
    ["Security is off for the box", OFF],
    ["Security is not open to this person", NARROWED],
  ])("asks nothing when %s", async (_why, modules) => {
    api.getWallModules.mockResolvedValue(modules);
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(result.current.access).not.toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(result.current.access?.security).toBe(false);
    expect(securityCalls()).toBe(0);
    expect(result.current.counts).toBeNull();
  });

  it("uses only its own keys — never /security's shared ones — and mirrors modules into the nav gate's key", async () => {
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(result.current.mode).toEqual(MODE));
    const keys = [...cache.keys()];
    const own = keys.filter((k) => k !== MODULE_GATE_KEY);
    expect(own.length).toBeGreaterThanOrEqual(5);
    expect(own.every((k) => k.includes('"security-wall"'))).toBe(true);
    expect(keys).not.toContain("/api/security/health");
    expect(keys).not.toContain("/api/security/mode");
    // Not the cameras pages' shared list either: an owner's cached list in this tab must never become the wall's tiles.
    expect(keys).not.toContain("/api/cameras");
    expect(own.some((k) => k.includes('"cameras"'))).toBe(true);
    expect((cache.get(MODULE_GATE_KEY) as { data?: unknown } | undefined)?.data).toEqual(ON);
  });

  it("records when each read last answered", async () => {
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(result.current.lastOkAt.mode).not.toBeNull());
    for (const k of ["modules", "counts", "sources", "mode"] as const) {
      expect(result.current.lastOkAt[k]).toBeTypeOf("number");
      expect(result.current.failed[k]).toBe(false);
    }
  });

  it("a remount over the same cache knows when each read last answered — cached values never come back as new or as 'never'", async () => {
    const first = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(first.result.current.lastOkAt.mode).not.toBeNull());
    const heardAt = first.result.current.lastOkAt;
    first.unmount();
    // Droplet stops answering; the second mount has only the cache.
    for (const f of [api.getWallModules, api.getSecurityIncidentCounts, api.getSecurityWallHealth, api.getSecurityMode]) f.mockReturnValue(new Promise(() => {}));
    const second = renderHook(() => useSecurityWall(), { wrapper });
    expect(second.result.current.counts).toEqual(COUNTS);
    expect(second.result.current.lastOkAt).toEqual(heardAt);
    expect(Object.values(heardAt).every((t) => typeof t === "number")).toBe(true);
  });

  it("reads the sign-in's latest end", async () => {
    api.getSignInEndsAt.mockResolvedValue("2026-09-25T22:00:00.000Z");
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(result.current.signInEndsAt).toBe("2026-09-25T22:00:00.000Z"));
  });
});

describe("useSecurityWall — failures are retried and said (T-D6)", () => {
  it("a 404 from the counts (the module gate's blip) is retried, and the retry's success clears it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getSecurityIncidentCounts.mockRejectedValueOnce(status(404)).mockResolvedValue(COUNTS);
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(result.current.failed.counts).toBe(true));
    expect(result.current.counts).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await waitFor(() => expect(result.current.failed.counts).toBe(false));
    expect(result.current.counts).toEqual(COUNTS);
    expect(api.getSecurityIncidentCounts).toHaveBeenCalledTimes(2);
  });

  it("a modules read that fails before it ever answers is `failed`, asks nothing else, and recovers on its retry", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getWallModules.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "TIMEOUT", status: 0 })).mockResolvedValue(ON);
    const { result } = renderHook(() => useSecurityWall(), { wrapper });
    await waitFor(() => expect(result.current.failed.modules).toBe(true));
    expect(result.current.lastOkAt.modules).toBeNull();
    expect(result.current.access).toBeNull();
    expect(securityCalls()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await waitFor(() => expect(result.current.access).toEqual({ security: true, cameras: true }));
    expect(result.current.failed.modules).toBe(false);
  });
});
