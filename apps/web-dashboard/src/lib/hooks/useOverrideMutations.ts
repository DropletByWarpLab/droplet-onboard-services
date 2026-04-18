"use client";
import { useSWRConfig } from "swr";
import { apiFetch } from "./apiFetch";
import type { ScheduleOverride } from "@/lib/types";

/**
 * Create + cancel one-off schedule overrides. Mirrors the pattern in
 * `useScheduleMutations`: after each write we broadcast-invalidate every SWR
 * key whose fetcher URL could be affected — override lists, device lists
 * (effective block state flows from overrides), and the schedule-events
 * feed (override apply/revert lands as an event row).
 */
export function useOverrideMutations() {
  const { mutate } = useSWRConfig();

  const invalidate = () =>
    mutate(
      (key) =>
        typeof key === "string" &&
        (key.startsWith("/api/network/overrides") ||
          key.startsWith("/api/network/devices") ||
          key.startsWith("/api/network/schedule-events")),
    );

  async function createOverride(input: {
    subjectType: "device" | "group";
    deviceMac?: string;
    groupId?: string;
    action: "allow" | "block";
    startAt?: string;
    endAt: string;
    note?: string;
  }): Promise<ScheduleOverride> {
    const res = await apiFetch<{ override: ScheduleOverride }>(
      "/api/network/overrides",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    await invalidate();
    return res.override;
  }

  async function cancelOverride(id: string): Promise<void> {
    await apiFetch(`/api/network/overrides/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    await invalidate();
  }

  return { createOverride, cancelOverride };
}
