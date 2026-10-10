/**
 * useCoverageAps / useApRadios — the hook bodies behind the topology panel's
 * access-point reads.
 *
 * `TopologyPanel.test.tsx` mocks both hooks wholesale, so it cannot tell a
 * hook that gates correctly from one that doesn't (the lesson
 * `useRouterPorts.test.tsx` opens with). This file mocks one layer lower
 * (`@/lib/api`) and drives the real hooks. What it pins:
 *   - a viewer who can't read per-AP radios makes NO request — the read is
 *     owner/admin only, and asking as anyone else is a 403 on every poll;
 *   - the keys are the ones the Coverage Extenders panel and `ApRadioDetail`
 *     already use, so the cache is shared, and they sit inside the Network
 *     page's Refresh sweep (`isNetworkSurfaceKey`) — a card whose key drifted
 *     out of it would spin the button and not move;
 *   - a failed AP read surfaces as an error, never as an empty success;
 *   - a paused list (the page is hiding the panel) makes no request at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, type State } from "swr";

const fetchApDevices = vi.fn();
const fetchApWirelessDetail = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchApDevices: (...args: unknown[]) => fetchApDevices(...args),
  fetchApWirelessDetail: (...args: unknown[]) => fetchApWirelessDetail(...args),
}));

import { useApRadios, useCoverageAps } from "../useCoverageAps";
import { isNetworkSurfaceKey } from "../useNetwork";

const MAC = "80:ea:0b:39:ae:23";

let cache: Map<string, State>;
beforeEach(() => {
  vi.clearAllMocks();
  cache = new Map();
});

/** A fresh cache per test, kept so a test can read back which keys were used. */
function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ dedupingInterval: 0, provider: () => cache }}>{children}</SWRConfig>
  );
}

/** The SWR keys the hooks registered, as the Refresh sweep sees them. */
const keys = () => [...cache.keys()].filter((k) => typeof k === "string" && k.startsWith("/api"));

describe("useCoverageAps", () => {
  it("returns the AP rows, and is loading until they arrive", async () => {
    fetchApDevices.mockResolvedValue({
      aps: [{ mac: MAC, status: "ONLINE" }],
      discoveredCap: 20,
      discoveredCapReached: false,
    });
    const { result } = renderHook(() => useCoverageAps(), { wrapper });

    expect(result.current).toMatchObject({ aps: [], isLoading: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.aps).toEqual([{ mac: MAC, status: "ONLINE" }]);
    expect(result.current.error).toBeUndefined();
  });

  it("surfaces a failed read as an error with no rows, and stops loading", async () => {
    fetchApDevices.mockRejectedValue(new Error("Failed to fetch extender APs: 500"));
    const { result } = renderHook(() => useCoverageAps(), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current).toMatchObject({ aps: [], isLoading: false });
  });

  it("makes no request while the panel is hidden, and isn't 'loading'", async () => {
    const { result } = renderHook(() => useCoverageAps({ paused: true }), { wrapper });

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchApDevices).not.toHaveBeenCalled();
    expect(result.current).toEqual({ aps: [], isLoading: false, error: undefined });
    expect(keys()).toEqual([]);
  });

  it("reads under the key the Coverage Extenders panel uses, inside the Refresh sweep", async () => {
    fetchApDevices.mockResolvedValue({ aps: [] });
    renderHook(() => useCoverageAps(), { wrapper });
    await waitFor(() => expect(fetchApDevices).toHaveBeenCalled());

    expect(keys()).toContain("/api/aps");
    expect(isNetworkSurfaceKey("/api/aps")).toBe(true);
  });
});

describe("useApRadios", () => {
  it("reads the AP's live radios when the viewer may", async () => {
    const detail = { mac: MAC, supported: true, radios: [] };
    fetchApWirelessDetail.mockResolvedValue(detail);
    const { result } = renderHook(() => useApRadios(MAC, true), { wrapper });

    await waitFor(() => expect(result.current.detail).toEqual(detail));
    expect(fetchApWirelessDetail).toHaveBeenCalledWith(MAC);
    expect(result.current.error).toBeUndefined();
  });

  it("makes no request at all when the viewer can't read per-AP radios", async () => {
    const { result } = renderHook(() => useApRadios(MAC, false), { wrapper });

    // Give a (wrongly) enabled SWR the chance to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchApWirelessDetail).not.toHaveBeenCalled();
    expect(result.current).toEqual({ detail: undefined, error: undefined });
    expect(keys()).toEqual([]);
  });

  it("surfaces a failed read as an error, not as empty radios", async () => {
    fetchApWirelessDetail.mockRejectedValue(new Error("Failed to fetch access point radios: 502"));
    const { result } = renderHook(() => useApRadios(MAC, true), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.detail).toBeUndefined();
  });

  it("reads under ApRadioDetail's per-AP key, inside the Refresh sweep", async () => {
    fetchApWirelessDetail.mockResolvedValue({ mac: MAC, supported: true, radios: [] });
    renderHook(() => useApRadios(MAC, true), { wrapper });
    await waitFor(() => expect(fetchApWirelessDetail).toHaveBeenCalled());

    const key = `/api/aps/${MAC}/wireless`;
    expect(keys()).toContain(key);
    expect(isNetworkSurfaceKey(key)).toBe(true);
  });
});
