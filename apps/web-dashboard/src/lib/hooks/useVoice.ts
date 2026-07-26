"use client";

/**
 * WARP-1055 — SWR wiring for the /voice surface + the Home health row.
 *
 * The surface polls `/api/voice/status` at ~1 s while the page is open
 * (the live meter is proof-of-life, §3.1); SWR's default
 * `refreshWhenHidden: false` stops the poll when the tab is hidden.
 * The calibration record revalidates on focus + after the wizard's
 * apply. Sustained-noise drift is tracked client-side: the rolling RMS
 * must sit `NOISE_DRIFT_DB` above the calibrated floor for
 * `NOISE_SUSTAIN_POLLS` consecutive polls — bursty speech dips between
 * utterances and never latches it; a fan or music does.
 */

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  fetchVoiceCalibration,
  fetchVoiceStatus,
  isVoiceUnavailableError,
} from "@/lib/api";
import {
  deriveVoiceSurfaceState,
  isVoiceOn,
  nextNoiseCount,
  NOISE_SUSTAIN_POLLS,
  type VoiceSurfaceState,
} from "@/components/voice/state";
import type { VoiceCalibrationInfo, VoiceStatusInfo } from "@/lib/types";

export const VOICE_STATUS_KEY = "/api/voice/status";
export const VOICE_CALIBRATION_KEY = "/api/voice/calibration";

const SURFACE_POLL_MS = 1_000;
const HOME_POLL_MS = 30_000;

export interface VoiceSurfaceData {
  status: VoiceStatusInfo | null;
  calibration: VoiceCalibrationInfo | null;
  /** voice-io not deployed / container down (503 voice_unavailable). */
  unavailable: boolean;
  /** Generic fetch failure — render the standard offline pattern. */
  offline: boolean;
  /** WARP-1599 — the admin kill switch; true unless the box says
   *  otherwise (see `isVoiceOn`). */
  enabled: boolean;
  loading: boolean;
  noiseSustained: boolean;
  refresh: () => void;
  onCalibrationApplied: () => void;
}

export function useVoiceSurfaceData(): VoiceSurfaceData {
  const {
    data: status,
    error: statusError,
    isLoading: statusLoading,
    mutate: mutateStatus,
  } = useSWR<VoiceStatusInfo>(VOICE_STATUS_KEY, () => fetchVoiceStatus(), {
    refreshInterval: SURFACE_POLL_MS,
    // The 1 s interval is already the retry loop; SWR's exponential
    // error retry on top would double-fire.
    shouldRetryOnError: false,
  });
  const unavailable = isVoiceUnavailableError(statusError);

  const {
    data: calibration,
    error: calibrationError,
    isLoading: calibrationLoading,
    mutate: mutateCalibration,
  } = useSWR<VoiceCalibrationInfo>(
    // No point fetching calibration while voice-io itself is down.
    unavailable ? null : VOICE_CALIBRATION_KEY,
    () => fetchVoiceCalibration(),
  );

  // Sustained-noise drift latch. Runs on its own wall-clock timer
  // (review F9): SWR keeps the data reference stable when payloads are
  // deep-equal, so an effect keyed on data identity would stall in a
  // steady room and double-count around calibration revalidations.
  // The tick decision itself is the pure nextNoiseCount (state.ts),
  // where the raw/pre-gain domain contract is regression-pinned (F1).
  const statusRef = useRef<VoiceStatusInfo | null>(null);
  statusRef.current = status ?? null;
  const statusErrorRef = useRef<unknown>(null);
  statusErrorRef.current = statusError ?? null;
  const calibrationRef = useRef<VoiceCalibrationInfo | null>(null);
  calibrationRef.current = calibration ?? null;
  const consecutiveRef = useRef(0);
  const [noiseSustained, setNoiseSustained] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => {
      // WARP-1060 (R2 from the WARP-1055 review): the latch reads SWR's
      // LAST payload — when polling is paused (hidden tab: SWR's
      // refreshWhenHidden=false; voice-io outage: statusError set while
      // the stale data is retained) a tick would re-count the same
      // frozen sample and could pre-latch the drift banner. Freeze the
      // count until fresh polls resume.
      if (
        statusErrorRef.current != null ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      const next = nextNoiseCount(
        consecutiveRef.current,
        statusRef.current,
        calibrationRef.current,
      );
      consecutiveRef.current = next;
      // Same-value setState is a React no-op — no per-tick re-render.
      setNoiseSustained(next >= NOISE_SUSTAIN_POLLS);
    }, SURFACE_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  // Review F8 — a calibration fetch failure with NO record in hand must
  // not fall through to the "Not calibrated yet" hero on a calibrated
  // box; the honest render is the offline retry card. (Once a record
  // has loaded, SWR keeps the stale data across transient errors.)
  const calibrationUnavailable = isVoiceUnavailableError(calibrationError);
  const calibrationOffline =
    calibrationError != null && !calibration && !calibrationUnavailable;

  return {
    status: status ?? null,
    calibration: calibration ?? null,
    unavailable,
    offline: (statusError != null && !unavailable) || calibrationOffline,
    // WARP-1599 — the status poll above keeps running while voice is
    // off (it is the only thing that reports the switch), so flipping
    // it back on from anywhere shows up here within one poll.
    enabled: isVoiceOn(status),
    loading:
      (statusLoading && !status && !statusError) ||
      (!unavailable && calibrationLoading && !calibration && !calibrationError),
    noiseSustained,
    refresh: () => {
      void mutateStatus();
      void mutateCalibration();
    },
    onCalibrationApplied: () => {
      void mutateCalibration();
      void mutateStatus();
    },
  };
}

/**
 * Coarse voice health for the Home system-status tile — one row, low
 * poll cadence, same derivation as the page so the two never disagree.
 * `state: null` while loading or when the dashboard can't reach the
 * orchestrator at all (the tile renders an em-dash).
 */
export function useVoiceHealthSummary(): {
  state: VoiceSurfaceState | null;
  unavailable: boolean;
} {
  const { data: status, error } = useSWR<VoiceStatusInfo>(
    VOICE_STATUS_KEY,
    () => fetchVoiceStatus(),
    { refreshInterval: HOME_POLL_MS, shouldRetryOnError: false },
  );
  const unavailable = isVoiceUnavailableError(error);
  const { data: calibration } = useSWR<VoiceCalibrationInfo>(
    unavailable || !status ? null : VOICE_CALIBRATION_KEY,
    () => fetchVoiceCalibration(),
    { refreshInterval: 60_000, shouldRetryOnError: false },
  );

  if (error && !unavailable) return { state: null, unavailable: false };
  if (!status && !unavailable) return { state: null, unavailable: false };
  return {
    state: deriveVoiceSurfaceState({
      status: status ?? null,
      calibration: calibration ?? null,
      unavailable,
      enabled: isVoiceOn(status),
      noiseSustained: false,
      nowS: Math.floor(Date.now() / 1000),
    }),
    unavailable,
  };
}
