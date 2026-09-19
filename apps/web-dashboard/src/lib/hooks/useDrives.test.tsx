/**
 * WARP-2098 (code review) — a failed refresh must be VISIBLE.
 *
 * fetchDrives() throws on a non-ok reply before reading the body, so the
 * `{error}` the orchestrator sends on a bridge 502 never reaches this hook.
 * SWR then keeps the last good `data` and sets its own `error`. The hook used
 * to derive bridgeError from `data` alone, so a real bridge failure rendered
 * the previous totals and system-drive card with nothing marking them stale.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useDrives } from "@/lib/hooks/useDrives";
import { fetchDrives } from "@/lib/api";

vi.mock("@/lib/api", () => ({ fetchDrives: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig
    value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}
  >
    {children}
  </SWRConfig>
);

const good = {
  drives: [
    {
      device: "/dev/sdb1",
      mount: "/mnt/droplet/photos",
      label: "",
      uuid: "U-DATA",
      size_bytes: 10,
      used_bytes: 5,
      free_bytes: 5,
      mounted: true,
    },
  ],
  count: 1,
  totals: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDrives — a failed fetch is visible (WARP-2098)", () => {
  it("reports bridgeError when the first fetch fails and nothing is cached", async () => {
    vi.mocked(fetchDrives).mockRejectedValue(new Error("Failed to fetch drives: 502"));
    const { result } = renderHook(() => useDrives(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bridgeError).toBeTruthy();
    expect(result.current.drives).toEqual([]);
  });

  it("reports bridgeError on a failed refresh while stale data is still cached", async () => {
    vi.mocked(fetchDrives).mockResolvedValueOnce(good as never);
    const { result } = renderHook(() => useDrives(), { wrapper });
    await waitFor(() => expect(result.current.drives).toHaveLength(1));
    expect(result.current.bridgeError).toBeUndefined();

    vi.mocked(fetchDrives).mockRejectedValueOnce(new Error("Failed to fetch drives: 502"));
    await act(async () => {
      await result.current.refresh().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.bridgeError).toBeTruthy());
  });

  it("clears bridgeError once a refresh succeeds again", async () => {
    vi.mocked(fetchDrives).mockRejectedValueOnce(new Error("Failed to fetch drives: 502"));
    const { result } = renderHook(() => useDrives(), { wrapper });
    await waitFor(() => expect(result.current.bridgeError).toBeTruthy());

    vi.mocked(fetchDrives).mockResolvedValueOnce(good as never);
    await act(async () => {
      await result.current.refresh().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.bridgeError).toBeUndefined());
    expect(result.current.drives).toHaveLength(1);
  });
});
