"use client";

import useSWR from "swr";
import { fetchApDevices, fetchApWirelessDetail, type ApWirelessDetail } from "@/lib/api";
import type { ApDeviceInfo } from "@/lib/types";

/**
 * Coverage-AP reads for the Network → Overview topology tree.
 *
 * Both hooks wrap fetchers that already exist (`fetchApDevices`,
 * `fetchApWirelessDetail`) under the SAME SWR keys and cadences as the Coverage
 * Extenders panel and its `ApRadioDetail`, so whichever surfaces are mounted
 * share one request and one cache entry. The keys also sit under `/api/aps`,
 * which keeps them inside `isNetworkSurfaceKey`'s sweep — the page's Refresh
 * button revalidates them with everything else.
 */

/** Same cadence as the orchestrator's AP-discovery poller (10s). */
const AP_LIST_REFRESH_MS = 10_000;
/** Same cadence as `ApRadioDetail`: the orchestrator dials the AP per request. */
const AP_RADIOS_REFRESH_MS = 30_000;

export interface UseCoverageApsResult {
  aps: ApDeviceInfo[];
  isLoading: boolean;
  error: Error | undefined;
}

export function useCoverageAps(): UseCoverageApsResult {
  const { data, isLoading, error } = useSWR("/api/aps", fetchApDevices, {
    refreshInterval: AP_LIST_REFRESH_MS,
  });
  return {
    aps: data?.aps ?? [],
    isLoading: isLoading && data === undefined,
    error: error as Error | undefined,
  };
}

export interface UseApRadiosResult {
  detail: ApWirelessDetail | undefined;
  error: Error | undefined;
}

/**
 * One AP's live radios. `enabled: false` makes no request at all — the read is
 * owner/admin only (the body carries the Wi-Fi passphrase), and asking as
 * anyone else would just collect a 403.
 */
export function useApRadios(mac: string, enabled: boolean): UseApRadiosResult {
  const { data, error } = useSWR<ApWirelessDetail>(
    enabled ? `/api/aps/${mac}/wireless` : null,
    () => fetchApWirelessDetail(mac),
    { refreshInterval: AP_RADIOS_REFRESH_MS },
  );
  return { detail: data, error: error as Error | undefined };
}
