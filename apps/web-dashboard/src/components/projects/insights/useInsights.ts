// Data hook for the Insights view: one SWR read of GET /api/pm/insights.
//
// Its own file rather than another export in usePm.ts, which several slices
// edit at once. The fetcher mirrors usePm's `getJson` (same PmRequestError, so
// `error.status` and `error.code` mean what they mean everywhere else in
// Projects).

import useSWR from "swr";
import { authFetch } from "@/lib/auth";
import { PmRequestError } from "../usePm";
import type { InsightsGroupBy, PmInsights } from "./types";

export type InsightsRangeId = "4w" | "12w" | "6m" | "12m";

export interface InsightsRange {
  id: InsightsRangeId;
  label: string;
  /** How many days back the picker asks for, today included. */
  days: number;
  /** The bucket the two time series are counted in. A year of weeks is 52 bars; months read better. */
  groupBy: InsightsGroupBy;
}

export const INSIGHTS_RANGES: readonly InsightsRange[] = [
  { id: "4w", label: "4 weeks", days: 28, groupBy: "week" },
  { id: "12w", label: "12 weeks", days: 84, groupBy: "week" },
  { id: "6m", label: "6 months", days: 182, groupBy: "week" },
  { id: "12m", label: "12 months", days: 364, groupBy: "month" },
];

export const DEFAULT_INSIGHTS_RANGE: InsightsRangeId = "12w";

/** `YYYY-MM-DD` of `n` days before `ymd`, by calendar arithmetic (no time zone involved). */
export function ymdMinusDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - n));
  return t.toISOString().slice(0, 10);
}

/** The viewer's own calendar day, as `YYYY-MM-DD`. */
function localYmd(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The request for a range. `to` is left out on purpose: the server's default is
 * "today in the workspace's own time zone", which is the day its numbers are
 * about, and which may not be the viewer's. `from` is counted back from the
 * viewer's day, so the range is a day or so off at worst — and the server
 * reports the range it actually measured in `meta`.
 */
export function insightsUrl(projectId: string | null, range: InsightsRange, now: Date): string {
  const q = new URLSearchParams();
  if (projectId) q.set("projectId", projectId);
  q.set("from", ymdMinusDays(localYmd(now), range.days - 1));
  q.set("groupBy", range.groupBy);
  return `/api/pm/insights?${q.toString()}`;
}

async function getInsightsJson(url: string): Promise<PmInsights> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PmRequestError(body.error ?? `Request failed (${res.status})`, res.status, body.error);
  }
  return ((await res.json()) as { insights: PmInsights }).insights;
}

/**
 * Insights for one project (`projectId`) or the whole workspace (`null`).
 * The server caches an answer for five minutes, so there is nothing to gain
 * from polling faster than that; SWR's revalidate-on-focus is enough.
 */
export function useInsights(projectId: string | null, range: InsightsRange) {
  // `new Date()` is read every render, but the URL it yields only changes when
  // the viewer's calendar day does, so the SWR key is stable all day.
  const url = insightsUrl(projectId, range, new Date());
  const { data, error, isLoading, mutate } = useSWR(url, getInsightsJson);
  return { insights: data, error: error as (Error & { status?: number; code?: string }) | undefined, isLoading, mutate };
}
