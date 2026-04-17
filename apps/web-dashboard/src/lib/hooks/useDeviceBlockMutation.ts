"use client";
import { useSWRConfig } from "swr";
import type { EnrichedNetworkDevice } from "@/lib/types";

type TypedError = { code: string; message: string };

/**
 * Hook for toggling a device's firewall block state.
 *
 * Posts to the existing `/api/network/firewall/{block,unblock}` endpoints
 * (Next.js same-origin proxy → orchestrator). The WARP-81 reconciler updates
 * `NetworkDevice.isBlocked` within ~10 s of the rule change, so after a
 * successful toggle we just kick SWR to revalidate and let the next refresh
 * (or the 10 s SWR refreshInterval) reflect the new state.
 *
 * TODO(WARP-41): wire Tier 2 token-bound confirm flow once the
 * `useTierConfirm` hook lands. Today a direct POST is the only path — if the
 * orchestrator returns `requiresConfirmation` the caller currently sees a
 * thrown error.
 */
export function useDeviceBlockMutation() {
  const { mutate } = useSWRConfig();

  async function toggleBlock(
    device: EnrichedNetworkDevice,
  ): Promise<{ operationId?: string } | void> {
    const shouldBlock = !device.isBlocked;
    const path = shouldBlock
      ? "/api/network/firewall/block"
      : "/api/network/firewall/unblock";

    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mac: device.mac }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const typed =
        (body as { error?: TypedError })?.error ?? {
          code: "UNKNOWN",
          message: `HTTP ${res.status}`,
        };
      const e: Error & { code?: string; status?: number } = new Error(
        typed.message ?? `HTTP ${res.status}`,
      );
      e.code = typed.code;
      e.status = res.status;
      throw e;
    }

    // Trigger SWR refresh — the WARP-81 reconciler will confirm the flipped
    // `isBlocked` within ~10 s, so the next fetch picks up the new state.
    await mutate(
      (key) => typeof key === "string" && key.startsWith("/api/network/devices"),
    );

    return { operationId: (body as { operationId?: string })?.operationId };
  }

  return { toggleBlock };
}
