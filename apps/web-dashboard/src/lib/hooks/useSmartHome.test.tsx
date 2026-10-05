/**
 * useSmartHome.command — KAN-5 regression.
 *
 * The bug: `command` awaited `sendMatterCommand` but discarded the returned
 * body, so the 202 `confirmation_required` answer for every Tier-2 Matter write
 * (a climate setpoint >= 30C, lock/unlock) was dropped and the write became a
 * silent no-op. `command` must now return a discriminated union so the caller
 * can detect the confirmation path and surface a confirm affordance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useSmartHome } from "@/lib/hooks/useSmartHome";

vi.mock("@/lib/api", () => ({
  fetchMatterDevices: vi.fn().mockResolvedValue({
    lights: [],
    switches: [],
    sensors: [],
    climate: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
  }),
  discoverMatterDevices: vi.fn().mockResolvedValue({ devices: [], count: 0 }),
  commissionMatterDevice: vi.fn(),
  sendMatterCommand: vi.fn(),
}));

import { sendMatterCommand, fetchMatterDevices, discoverMatterDevices } from "@/lib/api";

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSmartHome.command (KAN-5)", () => {
  it("returns { status: 'ok' } for a Tier-1 write and does not swallow it", async () => {
    vi.mocked(sendMatterCommand).mockResolvedValue({
      status: "sent",
      nodeId: "12345",
      command: "toggle",
      tier: 1,
    });

    const { result } = renderHook(() => useSmartHome(), { wrapper });

    let res: Awaited<ReturnType<typeof result.current.command>> | undefined;
    await act(async () => {
      res = await result.current.command("12345", "toggle");
    });

    expect(res).toEqual({ status: "ok" });
    expect(sendMatterCommand).toHaveBeenCalledWith("12345", "toggle", undefined);
  });

  it("surfaces the confirmation_required body for a Tier-2 write", async () => {
    vi.mocked(sendMatterCommand).mockResolvedValue({
      status: "confirmation_required",
      nodeId: "12345",
      command: "lock",
      service: "lock",
      tier: 2,
      reason: "Commands to lock devices require confirmation",
      confirmationToken: "tok-abc",
      expiresIn: 60,
    });

    const { result } = renderHook(() => useSmartHome(), { wrapper });

    let res: Awaited<ReturnType<typeof result.current.command>> | undefined;
    await act(async () => {
      res = await result.current.command("12345", "lock");
    });

    expect(res).toEqual({
      status: "confirmation_required",
      nodeId: "12345",
      confirmationToken: "tok-abc",
      service: "lock",
      reason: "Commands to lock devices require confirmation",
      tier: 2,
    });
  });

  it("maps a climate setpoint >= 30C 202 to the confirmation path, echoing service", async () => {
    vi.mocked(sendMatterCommand).mockResolvedValue({
      status: "confirmation_required",
      nodeId: "31000",
      command: "set_temperature",
      service: "set_temperature",
      tier: 2,
      reason: "Temperature >= 30C may be unsafe",
      confirmationToken: "tok-temp",
      expiresIn: 60,
    });

    const { result } = renderHook(() => useSmartHome(), { wrapper });

    let res: Awaited<ReturnType<typeof result.current.command>> | undefined;
    await act(async () => {
      res = await result.current.command("31000", "set_temperature", {
        temperature: 31,
      });
    });

    expect(res).toMatchObject({
      status: "confirmation_required",
      service: "set_temperature",
      confirmationToken: "tok-temp",
    });
    expect(sendMatterCommand).toHaveBeenCalledWith("31000", "set_temperature", {
      temperature: 31,
    });
  });
});

describe("useSmartHome polling gate", () => {
  it("does not poll device or discovery endpoints when disabled", () => {
    renderHook(() => useSmartHome({ enabled: false }), { wrapper });
    expect(fetchMatterDevices).not.toHaveBeenCalled();
    expect(discoverMatterDevices).not.toHaveBeenCalled();
  });

  it("makes no device or discovery requests through polling or refresh while disabled", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useSmartHome({ enabled: false }), { wrapper });
    try {
      await act(async () => {
        result.current.refresh();
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(fetchMatterDevices).not.toHaveBeenCalled();
      expect(discoverMatterDevices).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("stops both active polls when disabled and resumes both when re-enabled", async () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useSmartHome({ enabled }),
      { wrapper, initialProps: { enabled: true } },
    );
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(fetchMatterDevices).toHaveBeenCalled();
      expect(discoverMatterDevices).toHaveBeenCalled();
      const initialDeviceCalls = vi.mocked(fetchMatterDevices).mock.calls.length;
      const initialDiscoveryCalls = vi.mocked(discoverMatterDevices).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
      expect(vi.mocked(fetchMatterDevices).mock.calls.length).toBeGreaterThan(initialDeviceCalls);
      expect(vi.mocked(discoverMatterDevices).mock.calls.length).toBeGreaterThan(initialDiscoveryCalls);

      await act(async () => { rerender({ enabled: false }); });
      vi.mocked(fetchMatterDevices).mockClear();
      vi.mocked(discoverMatterDevices).mockClear();
      await act(async () => {
        result.current.refresh();
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(fetchMatterDevices).not.toHaveBeenCalled();
      expect(discoverMatterDevices).not.toHaveBeenCalled();

      await act(async () => { rerender({ enabled: true }); });
      // Both cached keys revalidate after the effect commits and SWR's next
      // animation frame runs.
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(fetchMatterDevices).toHaveBeenCalled();
      expect(discoverMatterDevices).toHaveBeenCalled();
      const resumedDeviceCalls = vi.mocked(fetchMatterDevices).mock.calls.length;
      const resumedDiscoveryCalls = vi.mocked(discoverMatterDevices).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
      expect(vi.mocked(fetchMatterDevices).mock.calls.length).toBeGreaterThan(resumedDeviceCalls);
      expect(vi.mocked(discoverMatterDevices).mock.calls.length).toBeGreaterThan(resumedDiscoveryCalls);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});

describe("useSmartHome.disconnected (WARP-3276)", () => {
  it("is false for a normal answer", async () => {
    const { result } = renderHook(() => useSmartHome(), { wrapper });
    await waitFor(() => expect(result.current.grouped).not.toBeNull());
    expect(result.current.disconnected).toBe(false);
  });

  it("is true when the orchestrator answers _status: disconnected (controller down)", async () => {
    vi.mocked(fetchMatterDevices).mockResolvedValueOnce({
      lights: [],
      switches: [],
      sensors: [],
      climate: [],
      media: [],
      covers: [],
      locks: [],
      other: [],
      _status: "disconnected",
    });
    const { result } = renderHook(() => useSmartHome(), { wrapper });
    await waitFor(() => expect(result.current.disconnected).toBe(true));
    expect(result.current.totalDevices).toBe(0);
  });
});
