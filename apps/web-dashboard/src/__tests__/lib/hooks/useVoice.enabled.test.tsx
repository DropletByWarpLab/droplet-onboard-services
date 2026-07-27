/**
 * WARP-1599 — `useVoiceSurfaceData.enabled`: the one wire between the
 * box's authoritative `status.enabled` and every consumer of the /voice
 * surface. The page passes it straight into VoiceSurface, so if it ever
 * reads back "on" for a silenced box the hero says Droplet is listening
 * when it isn't.
 *
 * Pins the three shapes `isVoiceOn` distinguishes, through the hook
 * rather than through the pure function: a silenced box, a live one,
 * and a payload that predates the field (an older box, and the loading
 * flash before the first poll lands) — the last two must read ON,
 * because a box we can't ask must never be rendered as deliberately
 * silenced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchVoiceStatus: vi.fn(),
  fetchVoiceCalibration: vi.fn(),
  isVoiceUnavailableError: (err: unknown) =>
    err instanceof Error &&
    (err as Error & { code?: string }).code === "voice_unavailable",
}));

import { fetchVoiceCalibration, fetchVoiceStatus } from "@/lib/api";
import { useVoiceSurfaceData } from "@/lib/hooks/useVoice";
import type { VoiceCalibrationInfo, VoiceStatusInfo } from "@/lib/types";

const statusMock = vi.mocked(fetchVoiceStatus);
const calibrationMock = vi.mocked(fetchVoiceCalibration);

const NOW = 1_751_000_000;

function status(overrides: Partial<VoiceStatusInfo> = {}): VoiceStatusInfo {
  return {
    enabled: true,
    state: "listening",
    listening: true,
    wake_loaded: true,
    threshold: 0.7,
    input_rms_dbfs: -52,
    last_audio_at: NOW - 5,
    input_flatlined: false,
    last_wake_at: NOW - 3600,
    ...overrides,
  } as VoiceStatusInfo;
}

function wrapper({ children }: { children: React.ReactNode }) {
  // Isolated SWR cache per test so one test's payload can't answer the
  // next one's poll.
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  statusMock.mockReset().mockImplementation(async () => status());
  calibrationMock
    .mockReset()
    .mockImplementation(async () => ({ calibrated: false }) as VoiceCalibrationInfo);
});

describe("useVoiceSurfaceData.enabled (WARP-1599)", () => {
  it("reports OFF for a box whose flag says so", async () => {
    statusMock.mockImplementation(async () =>
      status({ enabled: false, state: "off", listening: false }),
    );
    const { result } = renderHook(() => useVoiceSurfaceData(), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.enabled).toBe(false);
  });

  it("reports ON for a live box", async () => {
    const { result } = renderHook(() => useVoiceSurfaceData(), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.enabled).toBe(true);
  });

  it("reports ON before the first poll lands and for a box without the field", async () => {
    // Loading flash: no payload at all yet.
    const { result } = renderHook(() => useVoiceSurfaceData(), { wrapper });
    expect(result.current.status).toBeNull();
    expect(result.current.enabled).toBe(true);

    // ...and an older box that predates the switch sends no `enabled`.
    const { enabled: _dropped, ...legacy } = status();
    statusMock.mockImplementation(async () => legacy as VoiceStatusInfo);
    const older = renderHook(() => useVoiceSurfaceData(), { wrapper });
    await waitFor(() => expect(older.result.current.status).not.toBeNull());
    expect(older.result.current.enabled).toBe(true);
  });
});
