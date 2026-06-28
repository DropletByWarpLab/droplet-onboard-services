"use client";
import { useSWRConfig } from "swr";
import type { EnrichedNetworkDevice } from "@/lib/types";
import { apiFetch } from "./apiFetch";
// WARP-105: single source of truth for typed-error -> friendly toast copy.
// Re-exported so the long-standing `import { toastForError } from
// "@/lib/hooks/useDeviceMutations"` call sites keep resolving.
import { toastForError } from "@/lib/toastForError";

export { toastForError };

export function useDeviceMutations() {
  const { mutate } = useSWRConfig();

  async function patchDevice(
    mac: string,
    patch: Partial<Pick<EnrichedNetworkDevice, "displayName" | "icon" | "notes">>,
  ) {
    await apiFetch(`/api/network/devices/${encodeURIComponent(mac)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    // Success-only revalidation. On error we let the caller roll back local
    // state and rely on SWR's refresh interval to eventually reconcile —
    // an immediate mutate() here would race with the local rollback and
    // could replace it with stale server state.
    await mutate((key) => typeof key === "string" && key.startsWith("/api/network/devices"));
  }

  async function forgetDevice(mac: string) {
    await apiFetch(`/api/network/devices/${encodeURIComponent(mac)}`, { method: "DELETE" });
    await mutate((key) => typeof key === "string" && key.startsWith("/api/network/devices"));
  }

  async function assignGroups(mac: string, groupIds: string[]) {
    await apiFetch(`/api/network/devices/${encodeURIComponent(mac)}/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupIds }),
    });
    await mutate((key) => typeof key === "string" && key.startsWith("/api/network/devices"));
  }

  return { patchDevice, forgetDevice, assignGroups, toastForError };
}
