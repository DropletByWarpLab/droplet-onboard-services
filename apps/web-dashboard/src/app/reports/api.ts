/**
 * WARP-1993 — the Reports surface's own wire types and fetchers.
 *
 * Co-located rather than added to `lib/api.ts`, the same way the audit
 * surface keeps its types in `components/audit/types.ts`. `lib/api.ts` is
 * already ~6k lines and nothing outside `/reports` consumes these.
 *
 * `fetchAdminFilesUsage` is NOT re-declared here — it already exists in
 * `lib/api.ts` and the Folders tile imports it from there.
 */

import { authFetch } from "@/lib/auth";
import type { ActivityListResponse } from "@/components/audit/types";
import type { DateRange } from "./date-scope";

// ── GET /api/home ────────────────────────────────────────────────────────
//
// Worth knowing before you touch this: /api/home exists, is tested, and is
// currently called by NOTHING. Its header says it backs the Home page, but
// Home builds its widgets from individual hooks (useRecents, useCameras, …)
// and never adopted it. Reports is its first consumer.
//
// It is Redis-cached 30 s per user, and it is POINT-IN-TIME: the timeline it
// returns filters `at >= startOfDay`, and the tile values are current totals,
// not range aggregates. That is why the date scope does not drive it, and why
// the provenance strip says counts are as of now (WARP-1999).

/** Exactly four states. `offline`/`unknown` render an em-dash, not a zero. */
export type HomeTileStatus = "ok" | "warn" | "offline" | "unknown";

export interface HomeTile {
  count: number;
  /** Pre-composed one-liner from the server, e.g. "1284 files indexed". */
  sub: string;
  status: HomeTileStatus;
}

export interface HomeTiles {
  files: HomeTile;
  cameras: HomeTile;
  network: HomeTile;
  devices: HomeTile;
}

export interface HomeSystemChip {
  label: string;
  severity: "ok" | "warn" | "degraded";
}

export interface HomePayload {
  greeting: { text: string; timeOfDay: "morning" | "afternoon" | "evening" };
  systemChip: HomeSystemChip;
  tiles: HomeTiles;
  timeline: Array<{
    at: string;
    severity: "ok" | "warn" | "err" | "info";
    sourceIcon: string;
    what: string;
    sub: string | null;
    kind: string;
  }>;
  suggestedTools: Array<{ slug: string; name: string; description: string }>;
  suggestionChips: string[];
}

export async function fetchHome(): Promise<HomePayload> {
  const res = await authFetch("/api/home");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch home summary: ${res.status}`);
  }
  return res.json();
}

// ── GET /api/activity ────────────────────────────────────────────────────

/** Owner/admin only — a lower role gets 403, which the tile renders as its
 *  forbidden state rather than as an error. */
export const ACTIVITY_FORBIDDEN = 403;

export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Range-scoped activity. `to` is EXCLUSIVE on the server (`at < to`), which
 * is why `date-scope` emits half-open ranges — the two have to agree.
 *
 * `limit` is capped at 200 server-side. The tile shows 8 and offers a link
 * out, so it asks for a page rather than the whole range.
 */
export async function fetchActivityRange(
  range: DateRange,
  limit = 50,
): Promise<ActivityListResponse> {
  const params = new URLSearchParams({
    from: range.from,
    to: range.to,
    limit: String(limit),
  });
  const res = await authFetch(`/api/activity?${params}`);
  if (res.status === ACTIVITY_FORBIDDEN) throw new ForbiddenError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch activity: ${res.status}`);
  }
  return res.json();
}

// ── GET /api/integrations ────────────────────────────────────────────────
//
// Returns a BARE ARRAY, not an envelope. `lastSyncedAt` is new in WARP-1998 —
// before that the hub list carried no timestamp at all and the only way to
// get one was the provider-specific /api/integrations/eaglesoft route.

/** The seven explicit lifecycle states. A provider with no row reports
 *  NOT_CONFIGURED — it is never absent-meaning-off. */
export type IntegrationStatusName =
  | "NOT_CONFIGURED"
  | "PROVISIONING"
  | "CONNECTED"
  | "DEGRADED"
  | "DRIFT_LOCKED"
  | "ERROR"
  | "DISABLED";

export interface IntegrationSummary {
  provider: string;
  status: IntegrationStatusName;
  configured: boolean;
  writeEnabled: boolean;
  /** ISO, or null when the provider has never synced (WARP-1998). */
  lastSyncedAt: string | null;
}

export async function fetchIntegrations(): Promise<IntegrationSummary[]> {
  const res = await authFetch("/api/integrations");
  if (res.status === ACTIVITY_FORBIDDEN) throw new ForbiddenError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch integrations: ${res.status}`);
  }
  return res.json();
}

// ── The daily report — /api/tools/daily-report/runs ──────────────────────
//
// There is no /api/reports/* route and none is needed. The report is a
// tool-spec RUN: POST generates, GET is the archive. That is what lets the
// Yesterday chip show yesterday's actual prose instead of re-summarizing old
// data with today's model.
//
// The narrative lives in the LAST step's `result` — the `summarize` step
// added in WARP-1996. No column stores prose; the trace does.

export const DAILY_REPORT_SLUG = "daily-report";

/** Reserved trace `tool` for the step that calls no tool. Must match the
 *  orchestrator's SUMMARIZE_PSEUDO_TOOL. */
export const SUMMARIZE_PSEUDO_TOOL = "(summarize)";

export interface RunTraceEntry {
  idx: number;
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolRunRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: "ok" | "failed" | "cancelled";
  error: string | null;
  trace: RunTraceEntry[] | null;
}

/** A run projected into what the tile actually renders. */
export interface DailyReport {
  runId: string;
  at: string;
  prose: string;
  /** Tool names that fed it — provenance, derived from the run, not fixed. */
  sources: string[];
  status: ToolRunRow["status"];
}

/**
 * Pull the narrative out of a run.
 *
 * Returns null when the run produced no prose — a failed run, or one whose
 * summarize step didn't complete. The tile renders its failure state rather
 * than a partial paragraph, so a half-written report never reaches the page.
 */
export function reportFromRun(run: ToolRunRow): DailyReport | null {
  const trace = run.trace ?? [];
  const summary = trace.find((t) => t.tool === SUMMARIZE_PSEUDO_TOOL && t.ok);
  if (!summary || typeof summary.result !== "string" || !summary.result.trim()) {
    return null;
  }
  return {
    runId: run.id,
    at: run.endedAt ?? run.startedAt,
    prose: summary.result.trim(),
    // Every tool that actually ran, in run order. Derived so a spec change
    // updates the chips without anyone editing the tile.
    sources: trace.filter((t) => t.tool !== SUMMARIZE_PSEUDO_TOOL).map((t) => t.tool),
    status: run.status,
  };
}

export async function fetchDailyReportRuns(limit = 10): Promise<ToolRunRow[]> {
  const res = await authFetch(`/api/tools/${DAILY_REPORT_SLUG}/runs?limit=${limit}`);
  // A box that has never had the spec seeded 404s. That is "no report yet",
  // not an error — the tile offers to write one.
  if (res.status === 404) return [];
  if (res.status === ACTIVITY_FORBIDDEN) throw new ForbiddenError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch report history: ${res.status}`);
  }
  const body = await res.json();
  return (body.runs ?? []) as ToolRunRow[];
}

export async function runDailyReport(): Promise<ToolRunRow | null> {
  const res = await authFetch(`/api/tools/${DAILY_REPORT_SLUG}/runs`, { method: "POST" });
  if (res.status === ACTIVITY_FORBIDDEN) throw new ForbiddenError();
  // 207 = the run completed with a failed step. Still a run; the tile reads
  // its trace and decides whether prose came out.
  if (!res.ok && res.status !== 207) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Couldn't write the report (${res.status})`);
  }
  const body = await res.json();
  return {
    id: body.runId,
    startedAt: body.startedAt ?? new Date().toISOString(),
    endedAt: body.endedAt ?? null,
    status: body.status,
    error: body.error ?? null,
    trace: body.trace ?? null,
  };
}

// ── GET /api/erp/ar-summary ──────────────────────────────────────────────
//
// Accounts RECEIVABLE — money owed TO the business. There is no
// accounts-payable, expense, payroll or accounting connector anywhere in the
// registry, so there is no money-OUT figure to fetch and the tile's lower
// half ships permanently not-connected (brief §9.1).
//
// Role floor is family-and-up AND an AccessRoleConnectorGrant for the
// provider. A role without the grant gets 403 — common, not exotic.

export interface ArSummary {
  connected: boolean;
  reason?: string;
  /**
   * BOTH are null whenever `connected` is false — never zero-as-a-stand-in.
   * `$0.00` means genuinely zero; null means we don't know. The tile must
   * render those differently, and that distinction is the whole point of
   * this shape.
   */
  totalBalance: number | null;
  accountCount: number | null;
}

export async function fetchArSummary(): Promise<ArSummary> {
  const res = await authFetch("/api/erp/ar-summary");
  if (res.status === ACTIVITY_FORBIDDEN) throw new ForbiddenError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch AR summary: ${res.status}`);
  }
  return res.json();
}

// ── GET /api/activity/verify ─────────────────────────────────────────────
//
// Server-side by necessity: the chain is HMAC-signed with a key that never
// leaves the box, so the chip renders THIS result and cannot re-derive it.

export interface VerifySummary {
  ok: boolean;
  rowsChecked: number;
  brokenAtId?: string;
  verifiedAt: string;
}

export async function fetchChainVerify(): Promise<VerifySummary> {
  const res = await authFetch("/api/activity/verify");
  if (res.status === ACTIVITY_FORBIDDEN) throw new ForbiddenError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to verify chain: ${res.status}`);
  }
  return res.json();
}
