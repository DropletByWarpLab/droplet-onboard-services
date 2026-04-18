"use client";
import { useSWRConfig } from "swr";
import type { EnrichedNetworkDevice } from "@/lib/types";
import { apiFetch, type TypedError } from "./apiFetch";

/**
 * Hook for toggling a device's manual-block state.
 *
 * WARP-98 migration: previously this POSTed `/api/network/firewall/{block,
 * unblock}`, which spoke directly to the routing service. It now POSTs
 * `/api/network/devices/:mac/manualBlock` with body `{ blocked: boolean }`,
 * the WARP-94 endpoint that writes `NetworkDevice.manualBlock`. The
 * reconciler picks that flag up on its next tick (~30s) and derives the
 * firewall state from the full schedule + override + manualBlock pipeline.
 *
 * `device.isBlocked` reflects the reconciler-synced firewall state, so the
 * card won't visibly flip until the next reconciliation pass — we simply
 * invalidate the devices SWR keys so any mutated `manualBlock` surface
 * refreshes right away.
 *
 * TODO(WARP-41): wire Tier 2 token-bound confirm flow once the
 * `useTierConfirm` hook lands. Today a direct POST is the only path — if the
 * orchestrator returns `requiresConfirmation` the caller currently sees a
 * thrown error (we preserve the loud-fail path here for that case).
 */
export function useDeviceBlockMutation() {
  const { mutate } = useSWRConfig();

  async function toggleBlock(
    device: EnrichedNetworkDevice,
  ): Promise<{ operationId?: string } | void> {
    const blocked = !device.isBlocked;
    const path = `/api/network/devices/${encodeURIComponent(device.mac)}/manualBlock`;

    let body: { operationId?: string };
    try {
      body = await apiFetch<{ operationId?: string }>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked }),
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

    // Trigger SWR refresh on all device listings/detail — `manualBlock`
    // surfaces show new state immediately; `isBlocked` reconciles via ticker
    // within ~30s.
    await mutate(
      (key) => typeof key === "string" && key.startsWith("/api/network/devices"),
    );

    return { operationId: body?.operationId };
  }

  return { toggleBlock };
}
