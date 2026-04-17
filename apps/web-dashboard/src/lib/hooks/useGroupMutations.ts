"use client";
import { useSWRConfig } from "swr";

// WARP-85: friendly toast copy for typed errors from the group CRUD endpoints.
// The orchestrator returns `{ error: { code, message } }` on failures; we map
// the known codes to user-facing strings and fall back to a generic message
// for anything unrecognized.
export const GROUP_TOAST_COPY: Record<string, string> = {
  DUPLICATE_GROUP_NAME: "A group with that name already exists",
  GROUP_IN_USE: "Can't delete — group still has devices",
  NOT_FOUND: "Group not found",
  INVALID_ICON: "Pick a different icon",
};

export function groupToastForError(err: unknown, fallback = "Something went wrong"): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    const code = (err as { code: string }).code;
    return GROUP_TOAST_COPY[code] ?? fallback;
  }
  return fallback;
}

type TypedError = { code: string; message: string; status?: number };

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

export function useGroupMutations() {
  const { mutate } = useSWRConfig();

  async function invalidateGroups() {
    // Group mutations can change device enrichment (a rename flows into every
    // device card that belongs to the group), so invalidate both key families.
    await mutate(
      (key) =>
        typeof key === "string" &&
        (key.startsWith("/api/network/groups") || key.startsWith("/api/network/devices")),
    );
  }

  async function createGroup(
    name: string,
    color?: string,
    icon?: string,
  ): Promise<{ id: string; name: string; color?: string; icon?: string }> {
    const body = await apiFetch("/api/network/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color, icon }),
    });
    await invalidateGroups();
    return body as { id: string; name: string; color?: string; icon?: string };
  }

  async function renameGroup(
    id: string,
    patch: { name?: string; color?: string | null; icon?: string | null },
  ): Promise<unknown> {
    const body = await apiFetch(`/api/network/groups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await invalidateGroups();
    return body;
  }

  async function deleteGroup(id: string): Promise<void> {
    await apiFetch(`/api/network/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
    await invalidateGroups();
  }

  return { createGroup, renameGroup, deleteGroup, groupToastForError };
}
