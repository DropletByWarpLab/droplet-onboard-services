"use client";

/** The configured internal DNS address for dashboard chrome, with the
 * registered display name as a best-effort fallback. */

import useSWR from "swr";
import { fetchTlsStatus, type TlsStatus } from "../api";
import { resolveBoxAddress } from "../box-identity";
import { useDevice } from "./useDevice";

export function useBoxAddress(): string {
  const { device } = useDevice();
  // The configured hostname rarely changes, so poll lazily.
  const { data } = useSWR<TlsStatus>(
    "/api/tls/status",
    () => fetchTlsStatus(),
    {
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );
  return resolveBoxAddress(device?.hostname, data?.internalHostname);
}
