/**
 * useMatterCommandConfirm — KAN-5 device-control confirmation orchestration.
 *
 * Wraps `useSmartHome.command` so the Devices surface can intercept the Tier-2
 * `confirmation_required` answer, stage a confirm affordance, and complete the
 * write via `confirmMatterCommand` (echoing the token + service). Pre-KAN-5 the
 * 202 body was dropped and the write silently no-op'd; these tests pin the
 * round-trip.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMatterCommandConfirm } from "@/lib/hooks/useMatterCommandConfirm";
import type { MatterCommandResult } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  confirmMatterCommand: vi.fn(),
}));

import { confirmMatterCommand } from "@/lib/api";

beforeEach(() => {
  vi.clearAllMocks();
});

const CONFIRMATION: Extract<
  MatterCommandResult,
  { status: "confirmation_required" }
> = {
  status: "confirmation_required",
  nodeId: "12345",
  confirmationToken: "tok-abc",
  service: "lock",
  reason: "Commands to lock devices require confirmation",
  tier: 2,
};

describe("useMatterCommandConfirm (KAN-5)", () => {
  it("does not open a dialog for a Tier-1 ok result", async () => {
    const command = vi.fn().mockResolvedValue({ status: "ok" });
    const { result } = renderHook(() => useMatterCommandConfirm(command));

    await act(async () => {
      await result.current.request("12345", "toggle");
    });

    expect(result.current.pending).toBeNull();
    expect(command).toHaveBeenCalledWith("12345", "toggle", undefined);
  });

  it("stages the pending confirmation for a Tier-2 result", async () => {
    const command = vi.fn().mockResolvedValue(CONFIRMATION);
    const { result } = renderHook(() => useMatterCommandConfirm(command));

    await act(async () => {
      await result.current.request("12345", "lock");
    });

    expect(result.current.pending).toMatchObject({
      nodeId: "12345",
      service: "lock",
      confirmationToken: "tok-abc",
      reason: "Commands to lock devices require confirmation",
    });
  });

  it("confirms by echoing token + service, then refreshes and clears pending", async () => {
    vi.mocked(confirmMatterCommand).mockResolvedValue({
      confirmed: true,
      nodeId: "12345",
    });
    const command = vi.fn().mockResolvedValue(CONFIRMATION);
    const refresh = vi.fn();
    const { result } = renderHook(() =>
      useMatterCommandConfirm(command, refresh),
    );

    await act(async () => {
      await result.current.request("12345", "lock");
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(confirmMatterCommand).toHaveBeenCalledWith("12345", "tok-abc", "lock");
    expect(refresh).toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it("cancel clears the pending confirmation without calling confirm", () => {
    const command = vi.fn().mockResolvedValue(CONFIRMATION);
    const { result } = renderHook(() => useMatterCommandConfirm(command));

    act(() => {
      result.current.cancel();
    });

    expect(confirmMatterCommand).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it("surfaces a confirm failure and keeps the dialog open for retry", async () => {
    vi.mocked(confirmMatterCommand).mockRejectedValue(
      new Error("Confirmation expired"),
    );
    const command = vi.fn().mockResolvedValue(CONFIRMATION);
    const { result } = renderHook(() => useMatterCommandConfirm(command));

    await act(async () => {
      await result.current.request("12345", "lock");
    });
    await act(async () => {
      await expect(result.current.confirm()).rejects.toThrow(/expired/i);
    });

    // Still pending so the user can retry or cancel.
    await waitFor(() => expect(result.current.pending).not.toBeNull());
  });
});
