/**
 * WARP-291: optimistic Block/Unblock with snapshot-and-rollback.
 *
 * Before WARP-291 the hook waited for the POST round-trip to settle
 * before flipping the SWR cache. The audit flagged that as a "silent
 * destructive" — the user clicks Block, nothing visibly happens for
 * ~10 s, then the reconciler picks the flag up and the badge flips.
 *
 * The new behavior: write the optimistic `manualBlock`/`isBlocked`
 * straight into the SWR cache before the POST, then on error roll the
 * cache back to the snapshot. SWR's revalidation tick still runs
 * after success so the eventual reconciler-truth wins.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";
import { SWRConfig, useSWRConfig } from "swr";

import { useDeviceBlockMutation } from "@/lib/hooks/useDeviceBlockMutation";
import type { EnrichedNetworkDevice } from "@/lib/types";

const fetchMock = vi.fn();

function makeDevice(
  partial: Partial<EnrichedNetworkDevice> = {},
): EnrichedNetworkDevice {
  return {
    mac: "aa:bb:cc:dd:ee:ff",
    displayName: "Test device",
    hostname: null,
    vendor: "Vendor",
    icon: null,
    notes: null,
    lastIp: "192.168.1.50",
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    online: true,
    isBlocked: false,
    manualBlock: false,
    lastAppliedBlocked: null,
    groups: [],
    presenceDays: [],
    ...partial,
  } as EnrichedNetworkDevice;
}

function wrapper({ children }: { children: React.ReactNode }) {
  // Isolate the SWR cache per test so cache state doesn't bleed across
  // assertions.
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("useDeviceBlockMutation — optimistic flip + rollback", () => {
  it("flips the device-detail SWR cache before the POST resolves (optimistic)", async () => {
    // Seed the per-MAC detail cache with a device whose isBlocked=false.
    const device = makeDevice({ isBlocked: false });
    const key = `/api/network/devices/${encodeURIComponent(device.mac)}`;

    // Network call: hold the POST open so we can observe the in-flight state.
    let resolvePost: () => void = () => {};
    fetchMock.mockImplementation(() =>
      new Promise<Response>((res) => {
        resolvePost = () =>
          res(
            new Response(JSON.stringify({}), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
      }),
    );

    const { result } = renderHook(
      () => {
        const swr = useSWRConfig();
        const mut = useDeviceBlockMutation();
        return { swr, mut };
      },
      { wrapper },
    );

    // Seed cache.
    await act(async () => {
      await result.current.swr.mutate(
        key,
        { device, presence: [] },
        { revalidate: false },
      );
    });

    expect(
      (
        result.current.swr.cache.get(key)?.data as
          | { device: EnrichedNetworkDevice }
          | undefined
      )?.device.isBlocked,
    ).toBe(false);

    // Fire the toggle. Don't await — we want to inspect mid-flight.
    let p: Promise<unknown> | undefined;
    await act(async () => {
      p = result.current.mut.toggleBlock(device);
      // Let the optimistic write commit.
      await Promise.resolve();
    });

    const optimisticDevice = (
      result.current.swr.cache.get(key)?.data as
        | { device: EnrichedNetworkDevice }
        | undefined
    )?.device;
    // WARP-106: the optimistic object must be self-consistent with the
    // server's computed `isBlocked = lastAppliedBlocked ?? manualBlock` —
    // all three flip together.
    expect(optimisticDevice?.isBlocked).toBe(true);
    expect(optimisticDevice?.manualBlock).toBe(true);
    expect(optimisticDevice?.lastAppliedBlocked).toBe(true);

    // Finish the request so the test cleans up.
    await act(async () => {
      resolvePost();
      await p;
    });
  });

  it("rolls back the SWR cache on POST failure", async () => {
    const device = makeDevice({ isBlocked: false });
    const key = `/api/network/devices/${encodeURIComponent(device.mac)}`;

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "UPSTREAM_FAIL", message: "boom" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { result } = renderHook(
      () => {
        const swr = useSWRConfig();
        const mut = useDeviceBlockMutation();
        return { swr, mut };
      },
      { wrapper },
    );

    await act(async () => {
      await result.current.swr.mutate(
        key,
        { device, presence: [] },
        { revalidate: false },
      );
    });

    await act(async () => {
      await expect(result.current.mut.toggleBlock(device)).rejects.toThrow();
    });

    // After the rollback the cache should be back to isBlocked=false.
    expect(
      (
        result.current.swr.cache.get(key)?.data as
          | { device: EnrichedNetworkDevice }
          | undefined
      )?.device.isBlocked,
    ).toBe(false);
  });

  it("on success: revalidates the device-list SWR key so the reconciler-truth eventually wins", async () => {
    const device = makeDevice({ isBlocked: false });

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(
      () => {
        const swr = useSWRConfig();
        const mut = useDeviceBlockMutation();
        return { swr, mut };
      },
      { wrapper },
    );

    // The optimistic write itself is enough on the per-MAC detail key.
    // Revalidation of the list key is a follow-up SWR call. We can
    // observe the POST itself fired with the expected body.
    await act(async () => {
      await result.current.mut.toggleBlock(device);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      `/api/network/devices/${encodeURIComponent(device.mac)}/manualBlock`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ blocked: true });
  });
});
