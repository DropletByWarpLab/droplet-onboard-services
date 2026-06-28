"use client";
import { useSWRConfig } from "swr";
import { apiFetch } from "./apiFetch";
// WARP-105: the group CRUD toast copy now lives in the shared map. Re-exported
// under the historic `groupToastForError` name so `GroupTypeahead` and
// `GroupManagerDialog` keep resolving without touching their call sites.
import { toastForError } from "@/lib/toastForError";

const groupToastForError = toastForError;
export { groupToastForError };

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
