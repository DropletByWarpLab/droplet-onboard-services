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
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, ScrollText, Search, ShieldOff } from "lucide-react";
import { useAuth, authFetch } from "@/lib/auth";
import { ShellPage } from "@/components/shell/ShellPage";
import { AuditTimeline } from "@/components/audit/AuditTimeline";
import {
  BrokenChainBanner,
  ChainVerificationBadge,
} from "@/components/audit/ChainVerification";
import {
  ACTIVITY_KINDS,
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

function isAdminRole(role?: string): boolean {
  return role === "owner" || role === "admin";
}

export default function AuditPage() {
  const { user, isLoading: authLoading } = useAuth();

  const [items, setItems] = useState<ActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState("");
  const [rangeKey, setRangeKey] = useState<RangeKey>("all");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");

  const [verify, setVerify] = useState<VerifyState>({ phase: "checking" });

  const isAdmin = !authLoading && isAdminRole(user?.role);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    if (kind) params.set("kind", kind);
    const range = RANGES.find((r) => r.key === rangeKey);
    if (range?.ms) {
      params.set("from", new Date(Date.now() - range.ms).toISOString());
    }
    const needle = qDebounced.trim();
    if (needle) params.set("q", needle);
    return params;
  }, [kind, rangeKey, qDebounced]);

  // First page — refetched whenever a filter changes.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await authFetch(`/api/activity?${buildParams()}`);
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ActivityListResponse;
        setItems(json.items);
        setNextCursor(json.nextCursor);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load activity");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, buildParams]);

  // Hash-chain verification — on render, and on demand via the badge.
  const runVerify = useCallback(async () => {
    setVerify({ phase: "checking" });
    try {
      const res = await authFetch("/api/activity/verify");
      if (!res.ok) {
        throw new Error(
          res.status === 503
            ? "The signing service isn't available right now."
            : `HTTP ${res.status}`,
        );
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
        message: err instanceof Error ? err.message : "Request failed",
      });
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void runVerify();
  }, [isAdmin, runVerify]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = buildParams();
      params.set("cursor", nextCursor);
      const res = await authFetch(`/api/activity?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ActivityListResponse;
      setItems((prev) => [...prev, ...json.items]);
      setNextCursor(json.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
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
    a.download = `droplet-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const hasFilters = kind !== "" || rangeKey !== "all" || qDebounced.trim() !== "";
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
              roles, since it can include other household members&apos; activity.
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
        <button
          type="button"
          className="btn sm"
          onClick={exportCsv}
          disabled={items.length === 0}
        >
          <Download size={13} aria-hidden />
          Export CSV
        </button>
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
          className="dp-input"
          style={{ width: "auto" }}
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

      {error && (
        <div className="card" role="alert" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "var(--text)" }}>
            Couldn&apos;t load the audit log ({error}).
          </p>
        </div>
      )}

      <AuditTimeline
        items={items}
        loading={loading}
        hasFilters={hasFilters}
        onClearFilters={() => {
          setKind("");
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
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </ShellPage>
  );
}
