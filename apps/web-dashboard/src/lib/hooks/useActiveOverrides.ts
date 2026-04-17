"use client";
import useSWR from "swr";
import type { ScheduleOverride } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function useActiveOverrides(
  opts: { deviceMac?: string; groupId?: string } = {},
) {
  const qs = new URLSearchParams({ active: "1" });
  if (opts.deviceMac) qs.set("deviceMac", opts.deviceMac);
  if (opts.groupId) qs.set("groupId", opts.groupId);
  return useSWR<{ overrides: ScheduleOverride[] }>(
    `/api/network/overrides?${qs.toString()}`,
    fetcher,
    { refreshInterval: 15_000 },
  );
}
