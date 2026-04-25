"use client";

import useSWR from "swr";
import { apiFetch } from "./apiFetch";

export interface Clip {
  id: string;
  camera: string;
  label: string;
  score: number;
  start_time: number;     // Frigate epoch seconds
  end_time: number | null;
  thumbnail_url: string;
  clip_url: string;
}

export function useClips(opts: { camera?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.camera) params.set("camera", opts.camera);
  if (opts.limit) params.set("limit", String(opts.limit));
  const url = `/api/cameras/clips${params.toString() ? `?${params}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR<{ clips: Clip[] }>(
    url,
    (u: string) => apiFetch<{ clips: Clip[] }>(u, { credentials: "same-origin" }),
    { refreshInterval: 30_000 },
  );
  return { clips: data?.clips ?? [], error, isLoading, refresh: mutate };
}

export async function exportClip(camera: string, startsAt: string, endsAt: string) {
  return apiFetch<{ ncPath: string; bytes: number; durationSec: number }>(
    `/api/cameras/${encodeURIComponent(camera)}/clips/export`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ starts_at: startsAt, ends_at: endsAt }),
    },
  );
}

export async function shareClip(ncPath: string, ttlMinutes = 60) {
  return apiFetch<{ url: string; expires_at: string }>(
    "/api/cameras/clips/share",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ nc_path: ncPath, ttl_minutes: ttlMinutes }),
    },
  );
}
