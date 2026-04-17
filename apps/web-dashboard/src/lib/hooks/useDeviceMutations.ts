"use client";
import { useSWRConfig } from "swr";
import type { EnrichedNetworkDevice } from "@/lib/types";

type TypedError = { code: string; message: string; status?: number };

const TOAST_COPY: Record<string, string> = {
  INVALID_ICON: "Pick a different icon",
  INVALID_MAC: "Device address is invalid",
  NOT_FOUND: "Device was forgotten or never seen",
  DUPLICATE_GROUP_NAME: "A group with that name already exists",
  GROUP_IN_USE: "Can't delete — group still has devices",
  // WARP-41 will wire the confirm flow; until then we want the user to know
  // why the action didn't go through rather than seeing a raw upstream error.
  REQUIRES_CONFIRMATION: "This action requires confirmation — not wired yet",
};

export function toastForError(err: TypedError | unknown, fallback = "Something went wrong"): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    const code = (err as { code: string }).code;
    return TOAST_COPY[code] ?? fallback;
  }
  return fallback;
}

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const typed =
      (body as { error?: TypedError })?.error ?? { code: "UNKNOWN", message: `HTTP ${r.status}` };
    const e: Error & { code?: string; status?: number } = new Error(
      typed.message ?? `HTTP ${r.status}`,
    );
    e.code = typed.code;
    e.status = r.status;
    throw e;
  }
  return body;
}

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
