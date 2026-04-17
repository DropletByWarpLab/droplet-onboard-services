"use client";
import { useSWRConfig } from "swr";
import { apiFetch } from "./apiFetch";
import type { Schedule, ScheduleWindow } from "@/lib/types";

type CreateScheduleInput = Omit<
  Schedule,
  "id" | "createdAt" | "updatedAt" | "lastFiredAt" | "nextTransitionAt" | "windows"
> & {
  windows: Omit<ScheduleWindow, "id">[];
};

export function useScheduleMutations() {
  const { mutate } = useSWRConfig();

  const invalidate = () =>
    mutate(
      (key) =>
        typeof key === "string" &&
        (key.startsWith("/api/network/schedules") ||
          key.startsWith("/api/network/schedule-events")),
    );

  async function createSchedule(input: CreateScheduleInput) {
    const res = await apiFetch<{ schedule: Schedule }>(
      "/api/network/schedules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    await invalidate();
    return res.schedule;
  }

  async function updateSchedule(
    id: string,
    patch: { name?: string; enabled?: boolean; windows?: Schedule["windows"] },
  ) {
    const res = await apiFetch<{ schedule: Schedule }>(
      `/api/network/schedules/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    await invalidate();
    return res.schedule;
  }

  async function deleteSchedule(id: string) {
    await apiFetch(`/api/network/schedules/${id}`, { method: "DELETE" });
    await invalidate();
  }

  async function toggleSchedule(id: string, enabled: boolean) {
    return updateSchedule(id, { enabled });
  }

  return { createSchedule, updateSchedule, deleteSchedule, toggleSchedule };
}
