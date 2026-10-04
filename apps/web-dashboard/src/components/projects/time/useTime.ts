// Data layer for time tracking (WARP-3526): SWR reads and mutation helpers
// against the orchestrator's /api/pm time routes.
//
// Self-contained beside the time components rather than more lines in usePm.ts,
// which several slices edit at once. It borrows only `PmRequestError`, so a
// failed request carries the same `status` and `code` every other Projects error
// does and `translateError` can dispatch on it.

import useSWR, { useSWRConfig } from "swr";
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/auth";
import { PmRequestError } from "../usePm";
import type {
  PmTimer,
  PmTimeReport,
  PmTimesheet,
  PmWorklog,
  PmWorklogList,
  ReportQuery,
} from "./types";

export const TIMER_KEY = "/api/pm/timer";

async function failure(res: Response): Promise<PmRequestError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new PmRequestError(body.error ?? `Request failed (${res.status})`, res.status, body.error);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
  return res.json().catch(() => ({})) as Promise<T>;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** An item's entries, newest first, with the total over every entry. */
export function useWorklogs(workItemId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    workItemId ? `/api/pm/work-items/${workItemId}/worklogs` : null,
    (u: string) => getJson<PmWorklogList>(u),
  );
  return { list: data, error, isLoading, mutate };
}

/**
 * The caller's running timer, or null. Re-read every 20 seconds so a timer
 * started or stopped on another tab or device shows up here too; the elapsed
 * clock itself is local (`useNow`), so this is not a per-second poll.
 */
export function useRunningTimer() {
  const { data, error, isLoading, mutate } = useSWR(
    TIMER_KEY,
    (u: string) => getJson<{ timer: PmTimer | null }>(u),
    { refreshInterval: 20_000 },
  );
  return { timer: data?.timer ?? null, loaded: data !== undefined, error, isLoading, mutate };
}

export function timesheetUrl(userId: string, weekStart: string, tz: string): string {
  const q = new URLSearchParams({ userId, weekStart, tz });
  return `/api/pm/timesheet?${q.toString()}`;
}

export function useTimesheet(userId: string | null, weekStart: string, tz: string) {
  const { data, error, isLoading, mutate } = useSWR(
    userId ? timesheetUrl(userId, weekStart, tz) : null,
    (u: string) => getJson<{ timesheet: PmTimesheet }>(u),
  );
  return { timesheet: data?.timesheet, error, isLoading, mutate };
}

export function reportUrl(q: ReportQuery, format?: "csv"): string {
  const params = new URLSearchParams({ from: q.from, to: q.to, groupBy: q.groupBy, tz: q.tz });
  if (q.projectId) params.set("projectId", q.projectId);
  if (format) params.set("format", format);
  return `/api/pm/time/report?${params.toString()}`;
}

export function useTimeReport(q: ReportQuery | null) {
  const { data, error, isLoading, mutate } = useSWR(
    q ? reportUrl(q) : null,
    (u: string) => getJson<{ report: PmTimeReport }>(u),
  );
  return { report: data?.report, error, isLoading, mutate };
}

/** A clock that ticks every `intervalMs`, or stands still when it is null. */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ── Mutations ───────────────────────────────────────────────────────────────

/** Every cached read a time write can change: the timer, any item's entries and
 *  activity feed, every timesheet and every report. */
function isTimeKey(key: unknown): boolean {
  if (typeof key !== "string") return false;
  return (
    key === TIMER_KEY ||
    key.startsWith("/api/pm/timesheet") ||
    key.startsWith("/api/pm/time/report") ||
    (key.startsWith("/api/pm/work-items/") && (key.endsWith("/worklogs") || key.endsWith("/activity")))
  );
}

export interface WorklogBody {
  minutes: number;
  started_at?: string;
  note?: string;
}

export function useTimeActions() {
  const { mutate } = useSWRConfig();
  return useMemo(() => {
    /** A time write has landed: refresh every view of it, then hand back. */
    const settle = async <T>(result: T): Promise<T> => {
      await mutate(isTimeKey);
      return result;
    };
    return {
      logTime: async (workItemId: string, body: WorklogBody): Promise<PmWorklog> =>
        settle(
          (await send<{ worklog: PmWorklog }>(`/api/pm/work-items/${workItemId}/worklogs`, "POST", body))
            .worklog,
        ),
      updateEntry: async (id: string, patch: Partial<WorklogBody>): Promise<PmWorklog> =>
        settle((await send<{ worklog: PmWorklog }>(`/api/pm/worklogs/${id}`, "PATCH", patch)).worklog),
      deleteEntry: async (id: string): Promise<void> => {
        await send<{ deleted: string }>(`/api/pm/worklogs/${id}`, "DELETE");
        await settle(undefined);
      },
      startTimer: async (workItemId: string) =>
        settle(
          await send<{ timer: PmTimer; stopped: PmWorklog | null }>("/api/pm/timer/start", "POST", {
            work_item_id: workItemId,
          }),
        ),
      stopTimer: async () =>
        settle(await send<{ worklog: PmWorklog; capped: boolean }>("/api/pm/timer/stop", "POST", {})),
      /** Fetch the report as CSV through the signed-in session and hand it to the browser as a file. */
      downloadReportCsv: async (q: ReportQuery): Promise<void> => {
        const res = await authFetch(reportUrl(q, "csv"));
        if (!res.ok) throw await failure(res);
        const blob = await res.blob();
        const named = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = named?.[1] ?? `droplet-time-${q.groupBy}-${q.from}-to-${q.to}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
    };
  }, [mutate]);
}
