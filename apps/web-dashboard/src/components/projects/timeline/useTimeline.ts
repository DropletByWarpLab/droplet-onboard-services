"use client";

import useSWR from "swr";
import { pmGet } from "../calendar/pmGet";
import type { DateOnly } from "../calendar/dateOnly";
import type { PmTimeline } from "./types";

/**
 * One call for everything the Timeline draws in a window: items, BLOCKS edges and
 * module target dates (no per-item or per-edge request). The previous window's
 * data stays on screen while the next one loads, so panning and zooming never
 * blank the chart.
 */
export function useTimeline(projectId: string | null, range: { from: DateOnly; to: DateOnly }) {
  const key = projectId ? `/api/pm/projects/${projectId}/timeline?from=${range.from}&to=${range.to}` : null;
  const { data, error, isLoading, mutate } = useSWR(key, (u: string) => pmGet<PmTimeline>(u), {
    keepPreviousData: true,
  });
  return { timeline: data, error, isLoading, mutate };
}
