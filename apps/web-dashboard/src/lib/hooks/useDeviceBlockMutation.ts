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
 * WARP-291: the UI now flips immediately via snapshot-and-rollback. The
 * per-MAC SWR cache key (`/api/network/devices/:mac`) is written with the
 * new `isBlocked` (and `manualBlock`) value before the POST, so the
 * Block/Unblock button and detail panel show the new state right away. On
 * failure the cache is rolled back to the original snapshot so the
 * affordance returns to truth. On success we then trigger SWR revalidation
 * across the `/api/network/devices*` family so the reconciler-derived
 * `isBlocked` eventually wins (the optimistic value matches what the
 * reconciler will write, so there's no visible flicker on the happy path).
 */
export function useDeviceBlockMutation() {
  const { mutate, cache } = useSWRConfig();

  async function toggleBlock(
    device: EnrichedNetworkDevice,
  ): Promise<{ operationId?: string } | void> {
    const blocked = !device.isBlocked;
    const path = `/api/network/devices/${encodeURIComponent(device.mac)}/manualBlock`;
    const detailKey = `/api/network/devices/${encodeURIComponent(device.mac)}`;

    // Snapshot the pre-flip detail-key payload so we can roll back on
    // error. SWR's `cache.get(key)` returns the cache entry envelope —
    // we only care about `.data` (the actual payload). If the key
    // hasn't been populated yet (e.g. the user opened the card before
    // the detail SWR fetched), there's nothing to roll back, which is
    // fine — `mutate(key, undefined)` resets it cleanly.
    const snapshot = cache.get(detailKey)?.data as
      | { device: EnrichedNetworkDevice; presence?: unknown }
      | undefined;

    // Optimistic write — flip both `isBlocked` (what the UI reads) and
    // `manualBlock` (what the reconciler reads on its next tick). When
    // the snapshot is missing we synthesize a minimal entry from the
    // device argument so the immediate-revalidate paths still see the
    // flipped flag.
    const optimistic = snapshot
      ? {
          ...snapshot,
          device: {
            ...snapshot.device,
            isBlocked: blocked,
            manualBlock: blocked,
          },
        }
      : { device: { ...device, isBlocked: blocked, manualBlock: blocked } };
    await mutate(detailKey, optimistic, { revalidate: false });

    let body: { operationId?: string };
    try {
      body = await apiFetch<{ operationId?: string }>(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked }),
      });
    } catch (err) {
      // Rollback. Restore the exact snapshot we captured pre-flip. If
      // there was nothing to snapshot, clear the optimistic synthetic
      // entry instead so the next read fetches fresh.
      await mutate(detailKey, snapshot, { revalidate: false });

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

    // Trigger SWR refresh on all device listings/detail — keeps the
    // reconciler-truth in sync without re-fetching the per-MAC key we
    // just wrote (SWR dedupes by key, the optimistic write is
    // authoritative until the revalidation completes).
    await mutate(
      (key) => typeof key === "string" && key.startsWith("/api/network/devices"),
    );

    return { operationId: body?.operationId };
  }

  return { toggleBlock };
}
