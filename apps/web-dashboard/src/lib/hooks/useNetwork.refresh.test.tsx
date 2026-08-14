/**
 * WARP-1713 — the Network tab's Refresh button didn't refresh most of the page.
 *
 * `refresh` revalidated only the three keys this hook subscribes to
 * (/api/network/status, /devices, /firewall). Every other card on the tab owns
 * its own SWR key — /api/aps, the interfaces table, radio detail, guest Wi-Fi,
 * DHCP pool, UPnP, system controls, phone-home, AI access, camera privacy and
 * the entire switch panel — so on Overview, WiFi, Devices or System the button
 * spun and nothing the operator was looking at moved.
 *
 * The regression these tests lock down: Refresh sweeps the whole network
 * surface by key prefix, and refuses to touch keys belonging to other pages.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import useSWR from "swr";
import type { ReactNode } from "react";
import { useNetwork, isNetworkSurfaceKey } from "@/lib/hooks/useNetwork";

vi.mock("@/lib/api", () => ({
  fetchNetworkStatus: vi.fn().mockResolvedValue({ routerConnected: true }),
  fetchConnectedDevices: vi.fn().mockResolvedValue([]),
  fetchFirewallConfig: vi.fn().mockResolvedValue({}),
  confirmNetworkCommand: vi.fn().mockResolvedValue({}),
  RouterStatusError: class RouterStatusError extends Error {},
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig
    value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}
  >
    {children}
  </SWRConfig>
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isNetworkSurfaceKey", () => {
  it("claims every prefix the Network tab's cards actually fetch from", () => {
    // Sampled from the real `useSWR` call sites on /network — if a card moves
    // to a new prefix, this is the test that should fail.
    for (const key of [
      "/api/network/status",
      "/api/network/devices",
      "/api/network/firewall",
      "/api/network/interfaces",
      "/api/network/wifi/radio",
      "/api/network/wifi/guest",
      "/api/network/dhcp/pool",
      "/api/network/upnp",
      "/api/network/system/controls",
      "/api/network/phone-home",
      "/api/network/ai-access",
      "/api/aps",
      "/api/switch/status",
      "/api/switch/ports",
      "/api/switch/vlans",
    ]) {
      expect(isNetworkSurfaceKey(key)).toBe(true);
    }
  });

  it("leaves other pages alone", () => {
    for (const key of [
      "/api/cameras",
      "/api/files",
      "/api/models",
      "/api/networking-blog", // not ours despite the prefix-ish name
    ]) {
      expect(isNetworkSurfaceKey(key)).toBe(false);
    }
  });

  it("ignores non-string keys rather than throwing", () => {
    expect(isNetworkSurfaceKey(null)).toBe(false);
    expect(isNetworkSurfaceKey(undefined)).toBe(false);
    expect(isNetworkSurfaceKey(["/api/network/status", 1])).toBe(false);
  });
});

describe("useNetwork().refresh (WARP-1713)", () => {
  it("revalidates a card key this hook does NOT subscribe to", async () => {
    // Stand in for CoverageExtendersPanel / NetworkSimple, which own /api/aps.
    // Under the old refresh this fetcher was called exactly once (mount) and
    // Refresh never touched it.
    const apFetcher = vi.fn().mockResolvedValue({ aps: [] });

    const { result } = renderHook(
      () => {
        useSWR("/api/aps", apFetcher);
        return useNetwork();
      },
      { wrapper },
    );

    await waitFor(() => expect(apFetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(apFetcher).toHaveBeenCalledTimes(2);
  });

  it("does not revalidate keys outside the network surface", async () => {
    const cameraFetcher = vi.fn().mockResolvedValue([]);

    const { result } = renderHook(
      () => {
        useSWR("/api/cameras", cameraFetcher);
        return useNetwork();
      },
      { wrapper },
    );

    await waitFor(() => expect(cameraFetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(cameraFetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps a stable `refresh` identity across renders", async () => {
    // The page holds `refresh` in the dep array of its 1s operation-polling
    // effect; a new function each render tore that interval down and rebuilt it
    // on every render while a write was in flight.
    const { result, rerender } = renderHook(() => useNetwork(), { wrapper });
    const first = result.current.refresh;
    rerender();
    expect(result.current.refresh).toBe(first);
  });

  it("reports isRefreshing for the whole sweep, not just the status key", async () => {
    // One resolver per fetch, so the test decides exactly when the /api/aps
    // leg of the sweep completes. Under the old `isRefreshing = statusValidating`
    // the spinner stopped while this leg was still in flight.
    const resolvers: Array<() => void> = [];
    const gatedFetcher = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ aps: [] }));
        }),
    );

    const { result } = renderHook(
      () => {
        useSWR("/api/aps", gatedFetcher);
        return useNetwork();
      },
      { wrapper },
    );

    // Settle the mount fetch first.
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await act(async () => {
      resolvers[0]();
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refresh();
    });
    expect(result.current.isRefreshing).toBe(true);

    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]();
      await pending;
    });

    expect(result.current.isRefreshing).toBe(false);
  });
});
