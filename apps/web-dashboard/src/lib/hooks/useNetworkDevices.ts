"use client";
import useSWR from "swr";
import type { EnrichedNetworkDevice } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export function useNetworkDevices(opts: { onlineOnly?: boolean; groupId?: string } = {}) {
  const qs = new URLSearchParams();
  if (opts.onlineOnly) qs.set("onlineOnly", "1");
  if (opts.groupId) qs.set("groupId", opts.groupId);
  const key = `/api/network/devices${qs.toString() ? "?" + qs.toString() : ""}`;
  return useSWR<{ devices: EnrichedNetworkDevice[] }>(key, fetcher, { refreshInterval: 10_000 });
}
