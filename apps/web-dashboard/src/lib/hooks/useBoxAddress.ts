"use client";

/**
 * WARP-1342 — the box address for dashboard chrome (ShellPage status chip,
 * Home header).
 *
 * Merges the Device row's registered hostname with the issued ADR-023
 * per-device FQDN from the public `GET /api/tls/status`, via
 * `resolveBoxAddress` (see lib/box-identity.ts for the priority order).
 * The tls-status fetch is best-effort: while it's in flight or failing,
 * the hook degrades to exactly what `boxDisplayHost` showed before.
 */

import useSWR from "swr";
import { fetchTlsStatus, type TlsStatus } from "../api";
import { resolveBoxAddress } from "../box-identity";
import { useDevice } from "./useDevice";

export function useBoxAddress(): string {
  const { device } = useDevice();
  // The FQDN only changes on issuance/renewal — poll lazily (5 min), and a
  // failed fetch just leaves the LAN-name fallback in place. The fetcher
  // resolves `fetchTlsStatus` lazily (not by reference) so a partial
  // `vi.mock("@/lib/api")` without this export degrades to the fallback
  // inside SWR's error handling instead of crashing the page render.
  const { data } = useSWR<TlsStatus>(
    "/api/tls/status",
    () => fetchTlsStatus(),
    {
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );
  return resolveBoxAddress(device?.hostname, data?.fqdn);
}
