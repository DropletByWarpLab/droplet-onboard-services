"use client";
import { useSWRConfig } from "swr";
import type { EnrichedNetworkDevice } from "@/lib/types";
import { apiFetch, type TypedError } from "./apiFetch";

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

    let body: { operationId?: string };
    try {
      body = await apiFetch<{ operationId?: string }>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mac: device.mac }),
      });
    } catch (err) {
      // Loud fail for requires-confirmation until WARP-41 confirm flow lands.
      // Without this the user just sees a generic "HTTP 428" / upstream message
      // and has no idea the action was actually paused on a Tier 2 gate. We
      // detect via either the typed `error.code` (populated on `err.code` by
      // apiFetch) or the envelope-level `requiresConfirmation` flag (exposed
      // via `err.body` so callers don't re-parse the response).
      const e = err as TypedError;
      const envelope = e?.body as { requiresConfirmation?: boolean } | undefined;
      const needsConfirm =
        e?.code === "REQUIRES_CONFIRMATION" || envelope?.requiresConfirmation === true;
      if (needsConfirm) {
        const loud: TypedError = new Error(
          "This action requires Tier 2 confirmation (WARP-41)",
        );
        loud.code = "REQUIRES_CONFIRMATION";
        loud.status = e?.status;
        throw loud;
      }
      throw err;
    }

    // Trigger SWR refresh — the WARP-81 reconciler will confirm the flipped
    // `isBlocked` within ~10 s, so the next fetch picks up the new state.
    await mutate(
      (key) => typeof key === "string" && key.startsWith("/api/network/devices"),
    );

    return { operationId: body?.operationId };
  }

  return { toggleBlock };
}
