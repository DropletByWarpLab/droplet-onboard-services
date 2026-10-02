"use client";

/**
 * WARP-2976 (ADR-059 §2.4) — the REAL sources a department widget or a
 * Business overview tile may read. Every one of them is an endpoint the
 * dashboard already calls somewhere else; nothing here is new on the server
 * and nothing here is a placeholder.
 *
 * Each hook takes `enabled` and passes useSWR a null key when it is false —
 * the caller passes the module gate, so a switched-off module is never asked.
 * Keys are shared with the surfaces that already read them (`/api/cameras`
 * with `useCameras`, `/api/money` with `/money`, `/api/orchestrator/health`
 * with the health chip), so a tile adds no request those pages had not made.
 */
import useSWR from "swr";

import { formatMinor, type CrmStageSummary } from "@/components/crm/types";
import type { PmWorkItem } from "@/components/projects/types";
import type { MoneySummary } from "@/app/money/useMoney";
import { fetchCameras, fetchSystemHealth, type SystemHealth } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import { useSecurityIncidentSummary } from "@/lib/hooks/useSecurity";
import type { CameraInfo } from "@/lib/types";

interface StatusError extends Error {
  status?: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(body.error ?? `Request failed (${res.status})`) as StatusError;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

/* ── Work (PM, WARP-2717 `departmentId`) ─────────────────────────────────── */

/** The PM search reader's own ceiling (`searchWorkItems` clamps per_page to
 *  200). A full page means there may be more, and the count says "200+". */
export const WORK_PAGE_SIZE = 200;

export function departmentWorkKey(departmentId: string): string {
  return `/api/pm/work-items?department=${encodeURIComponent(departmentId)}&per_page=${WORK_PAGE_SIZE}`;
}

/** Open = not completed and not cancelled. A stateless item counts as open,
 *  the same rule the orchestrator's `/api/pm/summary` applies. */
export function isOpenWorkItem(item: Pick<PmWorkItem, "state">): boolean {
  const g = item.state?.group;
  return g === undefined || g === "backlog" || g === "unstarted" || g === "started";
}

/**
 * Work owned by a department — `GET /api/pm/work-items?department=<id>`,
 * which already rolls a department's TEAMs into it (`expandDepartmentScope`)
 * and resolves an item's own department over its project's. Archived items
 * are excluded server-side; completed and cancelled ones are dropped here.
 */
export function useDepartmentWork(departmentId: string, enabled: boolean) {
  const { data, error, isLoading } = useSWR<{ work_items: PmWorkItem[] }, StatusError>(
    enabled ? departmentWorkKey(departmentId) : null,
    getJson,
    { refreshInterval: 60_000, shouldRetryOnError: false },
  );
  const rows = data?.work_items;
  return {
    open: rows ? rows.filter(isOpenWorkItem) : undefined,
    /** The page came back full, so the open count is a floor. */
    capped: (rows?.length ?? 0) >= WORK_PAGE_SIZE,
    error,
    isLoading,
  };
}

/* ── Cameras ─────────────────────────────────────────────────────────────── */

/** Online = reporting anything but `offline`. `/api/cameras` already returns
 *  only the cameras this viewer is granted (`CameraAccessGrant`). */
export function countOnline(cameras: readonly Pick<CameraInfo, "status">[]): number {
  return cameras.filter((c) => c.status !== "offline").length;
}

/**
 * The camera list alone. `useCameras` also polls discovery and the recent
 * detections, neither of which a count needs; this shares its `/api/cameras`
 * key and fetcher, so the two read the same cache.
 */
export function useCameraFleet(enabled: boolean) {
  const { data, error, isLoading } = useSWR<CameraInfo[]>(
    enabled ? "/api/cameras" : null,
    fetchCameras,
    { refreshInterval: 30_000, shouldRetryOnError: false },
  );
  return {
    online: data ? countOnline(data) : undefined,
    total: data?.length,
    error,
    isLoading,
  };
}

/* ── Money ───────────────────────────────────────────────────────────────── */

export function useMoneyOverdue(enabled: boolean) {
  const { data, error, isLoading } = useSWR<MoneySummary, StatusError>(
    enabled ? "/api/money" : null,
    getJson,
    { refreshInterval: 300_000, shouldRetryOnError: false },
  );
  return {
    /** Overdue INVOICES — what the business is owed and has not been paid. */
    overdueInvoices: data?.receivable.overdueCount,
    lastReadAt: data?.lastReadAt ?? null,
    error,
    isLoading,
  };
}

/* ── Health ──────────────────────────────────────────────────────────────── */

export function useServiceHealth() {
  const { data, error, isLoading } = useSWR<SystemHealth>(
    "/api/orchestrator/health",
    fetchSystemHealth,
    { refreshInterval: 15_000 },
  );
  return {
    total: data?.components.length,
    unhealthy: data ? data.components.filter((c) => c.status !== "ok").length : undefined,
    error,
    isLoading,
  };
}

/* ── Sales (CRM) ─────────────────────────────────────────────────────────── */

export interface SalesFigure {
  openDeals: number;
  /** The pipeline's value, only when every open stage with deals is priced in
   *  one currency. Adding 500 EUR to 500 USD is not a number. */
  value: string | null;
  /** Why there is no value, in words — never a "0". */
  note: string | null;
}

export function salesFigure(stages: readonly CrmStageSummary[]): SalesFigure {
  const open = stages.filter((s) => s.kind === "OPEN");
  const openDeals = open.reduce((n, s) => n + s.dealCount, 0);
  const withDeals = open.filter((s) => s.dealCount > 0);
  if (withDeals.length === 0) return { openDeals, value: null, note: null };

  const allPriced = withDeals.every((s) => s.valuation === "priced" && s.currency);
  const currencies = new Set(withDeals.map((s) => s.currency));
  if (allPriced && currencies.size === 1) {
    const total = withDeals.reduce((sum, s) => sum + BigInt(s.amountMinor), BigInt(0));
    return {
      openDeals,
      value: formatMinor(total.toString(), withDeals[0].currency),
      note: null,
    };
  }
  const mixed =
    withDeals.some((s) => s.valuation === "mixed_currencies") ||
    (allPriced && currencies.size > 1);
  return {
    openDeals,
    value: null,
    note: mixed ? "mixed currencies" : "not every deal is priced yet",
  };
}

/* ── Security incidents (WARP-2978, ADR-059 P3 §8) ──────────────────────── */

/** The words the Security widget and headline share (P6's native Security home reuses them). */
export const OPEN_INCIDENTS_COPY = {
  nothing: "Nothing needs attention",
  notReady: "Alerts need opening hours and an Inside area",
  loadFailed: "Couldn't load incidents",
  off: "Security is off on this box",
  openSecurity: "Open Security",
} as const;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The figure for what needs attention, as number + label — or null when
 * nothing is open (the caller says `Nothing needs attention`). Never a 0:
 * `2 open alerts · 1 notice`, or `1 open notice` when no alert is open.
 */
export function openIncidentsFigure(openAlerts: number, openNotices: number): { n: string; label: string } | null {
  if (openAlerts > 0) {
    const label = openAlerts === 1 ? "open alert" : "open alerts";
    return { n: String(openAlerts), label: openNotices > 0 ? `${label} · ${count(openNotices, "notice", "notices")}` : label };
  }
  if (openNotices > 0) return { n: String(openNotices), label: openNotices === 1 ? "open notice" : "open notices" };
  return null;
}

/**
 * GET /api/security/incidents/summary, shared with /security (same SWR key).
 * `off`: the box answered 404 — the Security module is off (box-wide or for
 * this person) and the nav gate hadn't caught up yet. Any other failure is
 * `error`: the caller says it couldn't load, never a zero.
 */
export function useOpenIncidents(enabled: boolean) {
  const { summary, error, isLoading } = useSecurityIncidentSummary(enabled);
  const status = (error as StatusError | undefined)?.status;
  return { summary, off: status === 404, error: status === 404 ? undefined : error, isLoading };
}
