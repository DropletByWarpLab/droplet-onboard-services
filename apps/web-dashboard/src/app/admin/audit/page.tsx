/**
 * WARP-246 — /admin/audit: the signed activity log, for humans.
 *
 * Data source is the WARP-456 activity surface (GET /api/activity —
 * kind/from/to/q/limit/cursor), NOT a parallel audit API. Hash-chain
 * verification runs SERVER-side via GET /api/activity/verify (the
 * HMAC key never leaves the box); the badge here renders that result
 * on page load and on demand.
 *
 * CSV export is generated client-side from the rows already fetched
 * and filtered (audit-csv.ts hardens quoting + formula injection).
 * The sealed, verifiable JSONL bundle remains POST /api/activity/export.
 *
 * Role gate mirrors /admin/claude-activity: client check here, real
 * enforcement in the orchestrator's owner/admin middleware.
 *
 * WARP-1058: `?kind=<ActivityKind>` pre-selects the kind filter so
 * other surfaces can deep-link a filtered view (the /voice page's
 * "See all in Activity" points at /admin/audit?kind=voice). Initial
 * value only — the dropdown stays local state after load.
 */

"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, FileLock2, ScrollText, Search, ShieldOff } from "lucide-react";
import { useAuth, authFetch } from "@/lib/auth";
import { fetchUsers } from "@/lib/api";
import { ShellPage } from "@/components/shell/ShellPage";
import { AuditTimeline } from "@/components/audit/AuditTimeline";
import { AgentRunsPanel } from "@/components/audit/AgentRunsPanel";
import {
  BrokenChainBanner,
  ChainVerificationBadge,
} from "@/components/audit/ChainVerification";
import {
  ACTIVITY_KINDS,
  ACTIVITY_ACTOR_TYPES,
  ACTOR_TYPE_LABELS,
  KIND_LABELS,
  type ActivityItem,
  type ActivityListResponse,
  type VerifyResult,
  type VerifyState,
} from "@/components/audit/types";
import { activityRowsToCsv } from "@/lib/audit-csv";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const RANGES = [
  { key: "24h", label: "24 hours", ms: 24 * 3_600_000 },
  { key: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { key: "30d", label: "30 days", ms: 30 * 86_400_000 },
  { key: "all", label: "All time", ms: null },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

/** Homeowner-calm failure copy; the raw cause rides in a title attribute. */
const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";

interface LoadError {
  message: string;
  detail?: string;
}

function isAdminRole(role?: string): boolean {
  return role === "owner" || role === "admin";
}

/** WARP-1058: validate a ?kind= deep-link value against the wire enum
 *  — anything else falls back to "All kinds". */
function parseKindParam(value: string | null | undefined): string {
  return value && (ACTIVITY_KINDS as readonly string[]).includes(value)
    ? value
    : "";
}

// useSearchParams must be read under a Suspense boundary (Next.js
// app-router) — mirror the /network pattern: a thin outer component
// holds the boundary, the inner component owns all the page logic.
export default function AuditPage() {
  return (
    <Suspense fallback={<AuditPageSkeleton />}>
      <AuditPageInner />
    </Suspense>
  );
}

function AuditPageSkeleton() {
  return (
    <ShellPage
      icon={<ScrollText size={15} />}
      label="Audit log"
      title="Audit log"
    >
      <div
        className="card"
        aria-busy="true"
        style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}
      >
        Loading…
      </div>
    </ShellPage>
  );
}

function AuditPageInner() {
  const { user, isLoading: authLoading } = useAuth();
  const searchParams = useSearchParams();

  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);

  // Request generation: bumped by every first-page (filter) fetch and on
  // unmount, and captured by loadMore — a load-more that resolves after
  // the filters changed must not append old-filter rows or clobber the
  // fresh nextCursor.
  const fetchGenRef = useRef(0);

  // WARP-1058: deep-linked pre-filter (e.g. /admin/audit?kind=voice
  // from the /voice feed's "See all in Activity").
  const [kind, setKind] = useState(() =>
    parseKindParam(searchParams?.get("kind")),
  );
  // WARP-2180 — `?run=<id>` opens that background run's detail (a parked
  // run's approval prompt is deep-linkable from chat or a notification).
  const initialRunId = searchParams?.get("run") ?? null;
  const [actorType, setActorType] = useState("");
  const [rangeKey, setRangeKey] = useState<RangeKey>("all");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");

  const [verify, setVerify] = useState<VerifyState>({ phase: "checking" });
  const [exportingSealed, setExportingSealed] = useState(false);

  // WARP-1009: actorId (user UUID) → display name for the timeline's
  // "who did this" line. Progressive enhancement — if the directory
  // fetch fails, rows fall back to the actor's short id.
  const [userNames, setUserNames] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );

  const isAdmin = !authLoading && isAdminRole(user?.role);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    fetchUsers()
      .then(({ users }) => {
        if (!alive) return;
        setUserNames(
          new Map(users.map((u) => [u.id, u.displayName || u.username])),
        );
      })
      .catch(() => {
        /* names are optional — short ids render instead */
      });
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  /** The active filter set, shared verbatim by the list query (URL
   *  params) and the sealed export (POST body) so the bundle always
   *  matches what the operator is looking at. */
  const buildFilters = useCallback(() => {
    const filters: Record<string, string> = {};
    if (kind) filters.kind = kind;
    if (actorType) filters.actorType = actorType;
    const range = RANGES.find((r) => r.key === rangeKey);
    if (range?.ms) {
      filters.from = new Date(Date.now() - range.ms).toISOString();
    }
    const needle = qDebounced.trim();
    if (needle) filters.q = needle;
    return filters;
  }, [kind, actorType, rangeKey, qDebounced]);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams(buildFilters());
    params.set("limit", String(PAGE_SIZE));
    return params;
  }, [buildFilters]);

  // First page — refetched whenever a filter changes. Bumping the
  // generation invalidates any in-flight fetch AND any in-flight
  // load-more from the previous filter state.
  useEffect(() => {
    if (!isAdmin) return;
    const gen = ++fetchGenRef.current;
    const fresh = () => fetchGenRef.current === gen;
    setLoading(true);
    (async () => {
      try {
        const res = await authFetch(`/api/activity?${buildParams()}`);
        if (!fresh()) return;
        if (!res.ok) {
          setError({ message: CALM_ERROR, detail: `HTTP ${res.status}` });
          return;
        }
        const json = (await res.json()) as ActivityListResponse;
        if (!fresh()) return;
        setItems(json.items);
        setNextCursor(json.nextCursor);
        setError(null);
      } catch (err) {
        if (!fresh()) return;
        setError({
          message: CALM_ERROR,
          detail: err instanceof Error ? err.message : undefined,
        });
      } finally {
        if (fresh()) setLoading(false);
      }
    })();
    return () => {
      fetchGenRef.current++;
    };
  }, [isAdmin, buildParams]);

  // Hash-chain verification — on render, and on demand via the badge.
  const runVerify = useCallback(async () => {
    setVerify({ phase: "checking" });
    try {
      const res = await authFetch("/api/activity/verify");
      if (!res.ok) {
        setVerify({
          phase: "error",
          message:
            res.status === 503
              ? "The signing service isn't available right now."
              : CALM_ERROR,
          detail: `HTTP ${res.status}`,
        });
        return;
      }
      const json = (await res.json()) as VerifyResult;
      setVerify(
        json.ok
          ? { phase: "ok", rowsChecked: json.rowsChecked, verifiedAt: json.verifiedAt }
          : {
              phase: "broken",
              rowsChecked: json.rowsChecked,
              brokenAtId: json.brokenAtId ?? "unknown",
              verifiedAt: json.verifiedAt,
            },
      );
    } catch (err) {
      setVerify({
        phase: "error",
        message: CALM_ERROR,
        detail: err instanceof Error ? err.message : undefined,
      });
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void runVerify();
  }, [isAdmin, runVerify]);

  async function loadMore() {
    // `loading` closes the stale-cursor REQUEST window: after a filter
    // change, nextCursor still holds the previous filter's cursor until
    // the new first page resolves — a click in that window would issue
    // new-filter params with the old cursor under the CURRENT generation
    // and append a gapped page the response-side guard can't catch.
    if (loading || !nextCursor || loadingMore) return;
    // Capture the generation: if the filters change (or the page
    // unmounts) while this request is in flight, the result is stale
    // and must be dropped, not appended.
    const gen = fetchGenRef.current;
    const fresh = () => fetchGenRef.current === gen;
    setLoadingMore(true);
    try {
      const params = buildParams();
      params.set("cursor", nextCursor);
      const res = await authFetch(`/api/activity?${params}`);
      if (!fresh()) return;
      if (!res.ok) {
        setError({ message: CALM_ERROR, detail: `HTTP ${res.status}` });
        return;
      }
      const json = (await res.json()) as ActivityListResponse;
      if (!fresh()) return;
      setItems((prev) => [...prev, ...json.items]);
      setNextCursor(json.nextCursor);
    } catch (err) {
      if (!fresh()) return;
      setError({
        message: CALM_ERROR,
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoadingMore(false);
    }
  }

  function exportCsv() {
    const csv = activityRowsToCsv(
      items.map(({ id, at, kind: k, severity, what, sub }) => ({
        id,
        at,
        kind: k,
        severity,
        what,
        sub,
      })),
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Row count in the name keeps the partial-export honest: this is the
    // loaded view, not the whole table (the sealed full export lives at
    // POST /api/activity/export).
    a.download = `droplet-audit-${new Date().toISOString().slice(0, 10)}-${items.length}rows.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // WARP-1009: the sealed, offline-verifiable bundle — server-generated
  // (POST /api/activity/export streams NDJSON with a manifest line),
  // unlike the CSV which is a client-side snapshot of the loaded view.
  // Carries the ACTIVE filters so the download matches the screen.
  async function exportSealedBundle() {
    if (exportingSealed) return;
    setExportingSealed(true);
    try {
      const res = await authFetch("/api/activity/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildFilters()),
      });
      if (!res.ok) {
        setError({ message: CALM_ERROR, detail: `HTTP ${res.status}` });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "droplet-activity-bundle.jsonl";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError({
        message: CALM_ERROR,
        detail: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setExportingSealed(false);
    }
  }

  const hasFilters =
    kind !== "" || actorType !== "" || rangeKey !== "all" || qDebounced.trim() !== "";
  const icon = <ScrollText size={15} />;
  const SUB =
    "Every important action on this box, signed and chained so the history can't be quietly rewritten.";

  if (authLoading) {
    return (
      <ShellPage icon={icon} label="Audit log" title="Audit log" sub={SUB}>
        <div className="card" aria-busy="true" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
          Loading…
        </div>
      </ShellPage>
    );
  }

  if (!isAdmin) {
    return (
      <ShellPage icon={icon} label="Audit log" title="Audit log">
        <div className="card">
          <div className="empty">
            <span className="ei">
              <ShieldOff size={24} />
            </span>
            <span className="eh">Admin access required</span>
            <span>
              The audit log is only visible to <code>admin</code> / <code>owner</code>{" "}
              roles, since it can include other workspace members&apos; activity.
            </span>
          </div>
        </div>
      </ShellPage>
    );
  }

  return (
    <ShellPage
      icon={icon}
      label="Audit log"
      title="Audit log"
      sub={SUB}
      actions={
        <>
          <button
            type="button"
            className="btn sm"
            onClick={exportCsv}
            disabled={items.length === 0}
            title="Download the rows currently loaded in this view as CSV"
          >
            <Download size={13} aria-hidden />
            Export view
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => void exportSealedBundle()}
            disabled={exportingSealed}
            title="Download the signed, offline-verifiable bundle of every matching entry (server-generated NDJSON)"
          >
            <FileLock2 size={13} aria-hidden />
            {exportingSealed ? "Exporting…" : "Export sealed bundle"}
          </button>
        </>
      }
    >
      <div style={{ marginBottom: 16 }}>
        <ChainVerificationBadge state={verify} onReverify={() => void runVerify()} />
      </div>

      {verify.phase === "broken" && (
        <BrokenChainBanner brokenAtId={verify.brokenAtId} rowsChecked={verify.rowsChecked} />
      )}

      <div className="toolbar">
        <select
          aria-label="Filter by kind"
          className="px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
          style={{
            width: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--text)",
          }}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All kinds</option>
          {ACTIVITY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        {/* WARP-1009: actorType filter. NOTE the API only matches signed
            (v2+) rows for actor predicates — filtered views exclude
            pre-upgrade unattributed rows by design. */}
        <select
          aria-label="Filter by actor"
          className="px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
          style={{
            width: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--text)",
          }}
          value={actorType}
          onChange={(e) => setActorType(e.target.value)}
        >
          <option value="">All actors</option>
          {ACTIVITY_ACTOR_TYPES.map((a) => (
            <option key={a} value={a}>
              {ACTOR_TYPE_LABELS[a]}
            </option>
          ))}
        </select>
        <div className="pills" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={rangeKey === r.key ? "active" : undefined}
              aria-pressed={rangeKey === r.key}
              onClick={() => setRangeKey(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            aria-label="Search activity"
            placeholder="Search actions and details"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </div>

      {/* WARP-2180 — background runs live on the Activity surface, not in
          the nav. Their tool calls are the `tool_call` rows below, grouped
          by refs.agentRunId; this panel is the run-level view of them. */}
      <AgentRunsPanel initialRunId={initialRunId} />
      {error && (
        <div className="card" role="alert" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "var(--text)" }} title={error.detail}>
            Couldn&apos;t load the audit log. {error.message}
          </p>
        </div>
      )}

      <AuditTimeline
        items={items}
        loading={loading}
        hasFilters={hasFilters}
        userNames={userNames}
        onClearFilters={() => {
          setKind("");
          setActorType("");
          setRangeKey("all");
          setQ("");
        }}
      />

      {nextCursor && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
          <button
            type="button"
            className="btn ghost"
            onClick={() => void loadMore()}
            disabled={loadingMore || loading}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </ShellPage>
  );
}
