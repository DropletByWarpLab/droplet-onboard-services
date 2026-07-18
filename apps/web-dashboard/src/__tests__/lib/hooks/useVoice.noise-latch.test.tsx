/**
 * WARP-1060 (R2 from the WARP-1055 review) — the sustained-noise latch
 * in useVoiceSurfaceData runs on a wall-clock timer, but the payload it
 * reads is SWR's LAST poll. When polling pauses (hidden tab — SWR's
 * refreshWhenHidden is false — or a voice-io outage, where statusError
 * is set while stale data is retained) the latch must FREEZE instead of
 * re-counting the same frozen sample toward the drift banner.
 *
 * Pins:
 *   1. positive control — visible + healthy polls latch after
 *      NOISE_SUSTAIN_POLLS ticks;
 *   2. hidden tab — ticks don't count while hidden, resume on return;
 *   3. status fetch failing — ticks don't count against the retained
 *      stale payload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
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
import { NOISE_SUSTAIN_POLLS } from "@/components/voice/state";
import type { VoiceCalibrationInfo, VoiceStatusInfo } from "@/lib/types";

const statusMock = vi.mocked(fetchVoiceStatus);
const calibrationMock = vi.mocked(fetchVoiceCalibration);

const NOW = 1_751_000_000;

/** Noisy room: rms (-20) sits above floor (-41) + NOISE_DRIFT_DB (12). */
function noisyStatus(): VoiceStatusInfo {
  return {
    state: "listening",
    listening: true,
    wake_loaded: true,
    threshold: 0.7,
    input_rms_dbfs: -20,
    last_audio_at: NOW - 5,
    input_flatlined: false,
    last_wake_at: NOW - 3600,
  } as VoiceStatusInfo;
}

function calibration(): VoiceCalibrationInfo {
  return {
    calibrated: true,
    calibrated_at: NOW - 3 * 24 * 3600,
    input_gain: 2,
    noise_floor_dbfs: -41,
    speech_peak_dbfs: -18,
    wake_detections: 3,
    echo_ok: true,
    flags: [],
  } as VoiceCalibrationInfo;
}

function wrapper({ children }: { children: React.ReactNode }) {
  // Isolated SWR cache per test so poll state doesn't bleed across.
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

let visibility: DocumentVisibilityState = "visible";

async function flushInitialLoad() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function tickSeconds(n: number) {
  // One act() per 1 s tick so React re-renders (which refresh the
  // hook's statusError/status refs) flush BETWEEN poll ticks, the way
  // they do in a real browser — a single big advance would starve the
  // refs for the whole window.
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  statusMock.mockReset().mockImplementation(async () => noisyStatus());
  calibrationMock.mockReset().mockImplementation(async () => calibration());
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe("useVoiceSurfaceData — noise-latch tick gating (WARP-1060)", () => {
  it("latches after NOISE_SUSTAIN_POLLS ticks of live noisy polls (positive control)", async () => {
    const { result } = renderHook(() => useVoiceSurfaceData(), { wrapper });
    await flushInitialLoad();
    expect(result.current.noiseSustained).toBe(false);

    await tickSeconds(NOISE_SUSTAIN_POLLS);
    expect(result.current.noiseSustained).toBe(true);
  });

  it("does not count ticks while the tab is hidden; resumes when visible again", async () => {
    const { result } = renderHook(() => useVoiceSurfaceData(), { wrapper });
    await flushInitialLoad();

    // Tab hidden: SWR stops polling (refreshWhenHidden=false) but the
    // wall-clock timer keeps firing — those ticks must not count.
    visibility = "hidden";
    await tickSeconds(NOISE_SUSTAIN_POLLS + 5);
    expect(result.current.noiseSustained).toBe(false);

    // Back to visible: fresh polls resume and the latch works normally.
    visibility = "visible";
    await tickSeconds(NOISE_SUSTAIN_POLLS);
    expect(result.current.noiseSustained).toBe(true);
  });

  it("does not count ticks while the status fetch is failing (stale payload retained)", async () => {
    // First poll succeeds with the noisy payload; everything after
    // fails — SWR keeps the stale data AND sets statusError. Without
    // the gate the latch would pre-latch against the frozen sample.
    statusMock
      .mockImplementationOnce(async () => noisyStatus())
      .mockImplementation(async () => {
        throw new Error("fetch failed");
      });

    const { result } = renderHook(() => useVoiceSurfaceData(), { wrapper });
    await flushInitialLoad();
    expect(result.current.status).not.toBeNull();

    await tickSeconds(NOISE_SUSTAIN_POLLS + 5);
    expect(result.current.noiseSustained).toBe(false);
  });
});
