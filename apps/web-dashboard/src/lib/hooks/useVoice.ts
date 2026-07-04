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
  NOISE_DRIFT_DB,
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

  // Sustained-noise drift latch (client-side; see NOISE_* docs).
  const consecutiveRef = useRef(0);
  const [noiseSustained, setNoiseSustained] = useState(false);
  useEffect(() => {
    const rms = status?.input_rms_dbfs;
    const floor = calibration?.noise_floor_dbfs;
    if (
      rms == null ||
      floor == null ||
      !calibration?.calibrated ||
      status?.input_flatlined
    ) {
      consecutiveRef.current = 0;
      setNoiseSustained(false);
      return;
    }
    if (rms > floor + NOISE_DRIFT_DB) {
      consecutiveRef.current += 1;
      if (consecutiveRef.current >= NOISE_SUSTAIN_POLLS) {
        setNoiseSustained(true);
      }
    } else {
      consecutiveRef.current = 0;
      setNoiseSustained(false);
    }
  }, [status, calibration]);

  return {
    status: status ?? null,
    calibration: calibration ?? null,
    unavailable,
    offline: statusError != null && !unavailable,
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
      noiseSustained: false,
      nowS: Math.floor(Date.now() / 1000),
    }),
    unavailable,
  };
}
