"use client";
import useSWR from "swr";
import type { DeviceGroupWithCount } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function useNetworkGroups() {
  return useSWR<{ groups: DeviceGroupWithCount[] }>("/api/network/groups", fetcher, { refreshInterval: 30_000 });
}
