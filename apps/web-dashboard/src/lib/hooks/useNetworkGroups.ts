"use client";
import useSWR from "swr";
import { authFetch } from "@/lib/auth";
import type { DeviceGroupWithCount } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await authFetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function useNetworkGroups() {
  return useSWR<{ groups: DeviceGroupWithCount[] }>("/api/network/groups", fetcher, { refreshInterval: 30_000 });
}
