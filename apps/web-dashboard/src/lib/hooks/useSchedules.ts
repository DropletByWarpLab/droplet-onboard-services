"use client";
import useSWR from "swr";
import type { Schedule } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function useSchedules() {
  return useSWR<{ schedules: Schedule[] }>("/api/network/schedules", fetcher, {
    refreshInterval: 30_000,
  });
}
