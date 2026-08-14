"use client";

/**
 * WARP-1993 — the three tiles backed by endpoints that already exist:
 * the number strip (/api/home), Folders (/api/admin/files/usage) and
 * Activity (/api/activity + /activity/verify).
 *
 * Shared shapes live at the top because the page's coherence comes from
 * every tile failing, emptying and locking the same way. A tile that
 * invents its own empty state is the thing to avoid.
 */

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Blocks,
  CheckCircle2,
  Cpu,
  FolderOpen,
  HardDrive,
  Lock,
  Network,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { fetchAdminFilesUsage } from "@/lib/api";
import type { AdminUsageDepartmentRow } from "@/lib/types";
import type { ActivityItem } from "@/components/audit/types";
import {
  ForbiddenError,
  fetchActivityRange,
  fetchArSummary,
  fetchChainVerify,
  fetchDailyReportRuns,
  fetchIntegrations,
  reportFromRun,
  runDailyReport,
  type ArSummary,
  type DailyReport,
  type HomeTile,
  type IntegrationSummary,
  type VerifySummary,
} from "./api";
import {
  PILL,
  providerMark,
  providerName,
  relativeSince,
  statusLine,
  statusWeight,
} from "./connectors";
import type { DateRange } from "./date-scope";
import { UNREADABLE, formatBigint, formatBytes, quotaTone, sumBytes, usedPercent } from "./bytes";

// ── Shared states ────────────────────────────────────────────────────────

/**
 * Brief §7 — one treatment everywhere. The tile keeps its header and its
 * dimensions; a bento with holes reads as broken, a bento with locked tiles
 * reads as designed.
 *
 * No CTA and no hint at what the tile would contain: describing the data to
 * someone who may not see it leaks its shape.
 */
export function LockedBody() {
  return (
    <div className="rp-state">
      <Lock size={24} aria-hidden="true" />
      <p>Your role doesn&apos;t include this.</p>
    </div>
  );
}

export function ErrorBody({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div className="rp-state">
      <AlertTriangle size={24} className="rp-state-err" aria-hidden="true" />
      <p>{what}</p>
      {onRetry ? (
        <button type="button" className="rp-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function EmptyBody({ icon, text, children }: { icon?: ReactNode; text: string; children?: ReactNode }) {
  return (
    <div className="rp-state">
      {icon}
      <p>{text}</p>
      {children}
    </div>
  );
}

function SkeletonRows({ n, heights }: { n: number; heights?: number }) {
  const widths = ["92%", "86%", "78%", "64%", "70%", "58%"];
  return (
    <div className="rp-skel-stack" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="rp-skel" style={{ width: widths[i % widths.length], height: heights ?? 12 }} />
      ))}
    </div>
  );
}

// ── B1–B4 · number strip ─────────────────────────────────────────────────

const NUMBER_ICON: Record<string, LucideIcon> = {
  files: FolderOpen,
  cameras: Video,
  devices: Cpu,
  network: Network,
};

/**
 * `status` is exactly ok | warn | offline | unknown. The last two render the
 * count as an em-dash: the endpoint could not read that subsystem, and a
 * zero there would be a fabricated fact — "no cameras" instead of "we
 * couldn't ask".
 */
export function NumberBody({
  which,
  tile,
  loading,
  failed,
}: {
  which: keyof typeof NUMBER_ICON;
  tile: HomeTile | null;
  loading: boolean;
  failed: boolean;
}) {
  const Icon = NUMBER_ICON[which];
  const label = which[0].toUpperCase() + which.slice(1);

  if (loading) {
    return (
      <>
        <div className="rp-num-label">
          <Icon size={16} aria-hidden="true" />
          <span>{label}</span>
        </div>
        <SkeletonRows n={2} heights={22} />
      </>
    );
  }

  const unreadable = failed || tile === null;
  const status = unreadable ? "unknown" : tile.status;
  const known = status === "ok" || status === "warn";

  return (
    <>
      <div className="rp-num-label">
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="rp-num-count">{known ? tile!.count.toLocaleString() : UNREADABLE}</div>
      <div className="rp-num-sub">
        {unreadable ? "Not reporting" : tile!.sub}
      </div>
      <span className={`rp-dot is-${status}`} aria-hidden="true" />
      <span className="rp-sr">{`status ${status}`}</span>
    </>
  );
}

// ── C1 · Folders & storage ───────────────────────────────────────────────

export function FoldersBody({ canRead }: { canRead: boolean }) {
  const [rows, setRows] = useState<AdminUsageDepartmentRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!canRead) return;
    let live = true;
    setFailed(false);
    fetchAdminFilesUsage()
      .then((r) => live && setRows(r.departments))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [canRead, nonce]);

  if (!canRead) return <LockedBody />;
  if (failed) {
    return <ErrorBody what="Couldn't read storage usage" onRetry={() => setNonce((n) => n + 1)} />;
  }
  if (rows === null) return <SkeletonRows n={4} />;
  if (rows.length === 0) {
    return (
      <EmptyBody icon={<FolderOpen size={28} aria-hidden="true" />} text="No shared folders yet">
        <a href="/admin/files" className="rp-state-link">
          Set one up →
        </a>
      </EmptyBody>
    );
  }

  // Biggest first — the folder about to hit its quota is the one worth seeing.
  const sorted = [...rows].sort((a, b) => {
    const av = usedPercent(a.sizeBytes, a.quotaBytes);
    const bv = usedPercent(b.sizeBytes, b.quotaBytes);
    // Rows with no ratio (unlimited or unreadable) sort last: they can't be
    // near a limit they don't have.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });

  const total = sumBytes(rows.map((r) => r.sizeBytes));

  return (
    <>
      <div className="rp-rows">
        {sorted.map((d) => {
          const pct = usedPercent(d.sizeBytes, d.quotaBytes);
          return (
            <div className="rp-folder" key={d.id}>
              <div className="rp-folder-name">
                <span className="rp-folder-title">{d.name}</span>
                <span className="rp-folder-kind">{d.kind}</span>
              </div>
              <span className="rp-mono">{formatBytes(d.sizeBytes)}</span>
              <span className="rp-mono rp-muted">{formatBytes(d.quotaBytes)}</span>
              {/* No quota → no bar at all. An empty track would read as 0%
                  used, which is the opposite of unlimited. */}
              {pct === null ? (
                <span />
              ) : (
                <span className="rp-bar" role="presentation">
                  <span
                    className={`rp-bar-fill is-${quotaTone(pct)}`}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="rp-foot">
        <span className="rp-mono">{rows.length}</span> folders ·{" "}
        <span className="rp-mono">{formatBigint(total)}</span> used across the box
      </div>
    </>
  );
}

// ── D1 · Activity ────────────────────────────────────────────────────────

const SOURCE_ICON: Record<string, LucideIcon> = {
  FolderOpen,
  HardDrive,
  Video,
  Network,
  Cpu,
  Blocks,
  ShieldCheck,
  RefreshCw,
  Activity: ActivityIcon,
};

const MAX_ROWS = 8;

export function ActivityBody({ range, canRead }: { range: DateRange | null; canRead: boolean }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!canRead || !range) return;
    let live = true;
    setFailed(false);
    setItems(null);
    fetchActivityRange(range, 50)
      .then((r) => live && setItems(r.items))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ForbiddenError) setForbidden(true);
        else setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [canRead, range, nonce]);

  if (!canRead || forbidden) return <LockedBody />;
  // No range means Custom with no picker yet — say so rather than showing
  // today's events under a label the user changed.
  if (!range) return <EmptyBody text="Pick a date range to see activity" />;
  if (failed) {
    return <ErrorBody what="Couldn't read activity" onRetry={() => setNonce((n) => n + 1)} />;
  }
  if (items === null) return <SkeletonRows n={5} />;
  if (items.length === 0) {
    // A quiet day is a good day: no icon, no CTA, no suggestion that
    // something went wrong.
    return <EmptyBody text="Nothing recorded in this range" />;
  }

  return (
    <>
      <div className="rp-rows">
        {items.slice(0, MAX_ROWS).map((e) => {
          const Icon = SOURCE_ICON[e.sourceIcon] ?? ActivityIcon;
          return (
            <div className="rp-evt" key={e.id}>
              <span className="rp-mono rp-evt-time">
                {new Date(e.at).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className={`rp-dot is-${e.severity}`} aria-hidden="true" />
              <Icon size={16} className="rp-evt-ico" aria-hidden="true" />
              <div className="rp-evt-tx">
                <div>{e.what}</div>
                {e.sub ? <div className="rp-evt-sub">{e.sub}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
      {items.length > MAX_ROWS ? (
        <a href="/admin/audit" className="rp-foot rp-state-link">
          View all {items.length} events →
        </a>
      ) : null}
    </>
  );
}

// ── A1 · Daily report ────────────────────────────────────────────────────

/** Up to this many source chips before the rest collapse to "+N". */
const MAX_CHIPS = 5;

export function ReportBody({
  range,
  canRead,
  now,
}: {
  range: DateRange | null;
  canRead: boolean;
  now: Date | null;
}) {
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let live = true;
    setLoaded(false);
    setError(null);
    fetchDailyReportRuns()
      .then((runs) => {
        if (!live) return;
        // The newest run that actually produced prose. A failed run in front
        // of a good one must not hide the good one.
        const found = runs.map(reportFromRun).find((r): r is DailyReport => r !== null);
        setReport(found ?? null);
        setLoaded(true);
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ForbiddenError ? "forbidden" : "Couldn't read the report");
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [canRead]);

  const write = useCallback(async () => {
    setWriting(true);
    setError(null);
    try {
      const run = await runDailyReport();
      const next = run ? reportFromRun(run) : null;
      if (next) setReport(next);
      // A run that produced no prose is a failure, not an empty report —
      // never leave a stale paragraph on screen pretending it is new.
      else setError(run?.error ?? "Couldn't write the report");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWriting(false);
    }
  }, []);

  if (!canRead || error === "forbidden") return <LockedBody />;

  if (writing) {
    return (
      <div className="rp-report is-writing" aria-live="polite" aria-busy="true">
        <span className="rp-report-writing">Writing…</span>
        <SkeletonRows n={4} />
      </div>
    );
  }

  if (!loaded) return <SkeletonRows n={4} />;

  if (error) {
    return (
      <div className="rp-report">
        <ErrorBody what="Couldn't write the report" onRetry={write} />
        {/* The returned reason verbatim — never paraphrased into something
            more reassuring than what actually happened. */}
        <div className="rp-report-reason">{error}</div>
      </div>
    );
  }

  if (!report) {
    return (
      <EmptyBody icon={<Sparkles size={28} aria-hidden="true" />} text="No report for this range yet">
        <button type="button" className="rp-retry" onClick={write}>
          Write report
        </button>
      </EmptyBody>
    );
  }

  // Stale = the report predates the range now selected. Its facts are about a
  // different span, so the timestamp is marked rather than the prose hidden.
  const stale = Boolean(range && new Date(report.at).getTime() < new Date(range.from).getTime());
  const shown = report.sources.slice(0, MAX_CHIPS);
  const overflow = report.sources.length - shown.length;

  return (
    <div className="rp-report">
      {/* Announced once on settle, not per token. */}
      <div className="rp-report-prose" aria-live="polite">
        {report.prose.split(/\n{2,}/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>

      <div className="rp-report-foot">
        <span className={`rp-report-stamp${stale ? " is-stale" : ""}`}>
          Written by Droplet from <span className="rp-mono">{report.sources.length}</span> tool
          result{report.sources.length === 1 ? "" : "s"} ·{" "}
          <span className="rp-mono">
            {now
              ? new Date(report.at).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : ""}
          </span>
        </span>
        <span className="rp-report-chips">
          {/* Provenance, not navigation — static, no hover lift. A generated
              paragraph that looks like a hand-written fact is the failure
              mode this footer exists to prevent. */}
          {shown.map((s) => (
            <span className="rp-src-chip" key={s}>
              {s}
            </span>
          ))}
          {overflow > 0 ? <span className="rp-src-chip">+{overflow}</span> : null}
        </span>
      </div>

      {stale ? (
        <div className="rp-report-stale">Out of date for this range — rewrite to refresh.</div>
      ) : null}
    </div>
  );
}

// ── A2 · Money ───────────────────────────────────────────────────────────

/**
 * Currency for the money figure. Locale-formatted, always two decimals, so
 * `$0.00` and a blank are never confusable.
 */
function money(n: number): string {
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** The half that has no data source, ever. Brief §9.1. */
function MoneyOutHalf() {
  return (
    <div className="rp-money-half">
      <div className="rp-money-label">
        <TrendingDown size={14} aria-hidden="true" />
        Paid out
      </div>
      <div className="rp-money-note">No accounting system connected</div>
      <div className="rp-money-sub">Connect one to see money going out.</div>
      <a href="/integrations" className="rp-state-link">
        Browse connectors →
      </a>
      {/* Present so the two halves stay balanced, but obviously inert. */}
      <span className="rp-money-bar is-inert" />
    </div>
  );
}

export function MoneyBody({
  canRead,
  now,
  onSource,
}: {
  canRead: boolean;
  now: Date | null;
  /** Lets the page put the source/staleness chip in the tile header. */
  onSource?: (chip: { label: string; stale: boolean }) => void;
}) {
  const [ar, setAr] = useState<ArSummary | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [failed, setFailed] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let live = true;
    setFailed(false);
    fetchArSummary()
      .then((r) => live && setAr(r))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ForbiddenError) setForbidden(true);
        else setFailed(true);
      });
    // The staleness chip needs the connector's last successful read, which
    // WARP-1998 put on the hub list. A failure here is not a money failure —
    // the figure still renders, just without a staleness claim.
    fetchIntegrations()
      .then((rows) => {
        if (!live) return;
        const connected = rows.filter((r) => r.lastSyncedAt);
        const newest = connected
          .map((r) => r.lastSyncedAt!)
          .sort()
          .pop();
        setSyncedAt(newest ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [canRead]);

  const rel = now ? relativeSince(syncedAt, now) : null;
  // "Stale" is a claim about age, so it is only made when the age is known.
  const stale = Boolean(syncedAt && now && Date.now() - new Date(syncedAt).getTime() > 3_600_000);

  useEffect(() => {
    if (!onSource) return;
    if (forbidden || !canRead) return;
    if (ar && !ar.connected) onSource({ label: "Not connected", stale: false });
    else if (ar && stale && rel) onSource({ label: `Stale · ${rel}`, stale: true });
    else if (ar) onSource({ label: "Eaglesoft", stale: false });
  }, [ar, stale, rel, forbidden, canRead, onSource]);

  if (!canRead || forbidden) return <LockedBody />;
  if (failed) return <ErrorBody what="Couldn't read the money figure" />;

  return (
    <>
      <div className="rp-money-half">
        <div className="rp-money-label">
          <TrendingUp size={14} aria-hidden="true" />
          Owed to you
        </div>
        {ar === null ? (
          <span className="rp-skel" style={{ width: "76%", height: 34 }} />
        ) : ar.connected && ar.totalBalance !== null ? (
          <>
            {/* Greyed when stale — shown, never hidden. A degraded figure the
                user can see and distrust beats one silently withheld. */}
            <div
              className={`rp-money-fig${stale ? " is-stale" : ""}`}
              aria-label={`${money(ar.totalBalance)} owed to you`}
            >
              {money(ar.totalBalance)}
            </div>
            <div className="rp-money-sub">
              across <span className="rp-mono">{ar.accountCount ?? 0}</span> accounts
            </div>
            <span className="rp-money-bar is-in" />
          </>
        ) : (
          <>
            <div className="rp-money-note">No practice system connected</div>
            <div className="rp-money-sub">Connect one to see money coming in.</div>
            <a href="/integrations" className="rp-state-link">
              Browse connectors →
            </a>
            <span className="rp-money-bar is-inert" />
          </>
        )}
      </div>
      <MoneyOutHalf />
    </>
  );
}

// ── C2 · Integrations ────────────────────────────────────────────────────

const PILL_ICON = {
  check: CheckCircle2,
  warn: AlertTriangle,
  lock: Lock,
  refresh: RefreshCw,
  plug: Plug,
} as const;

export function IntegrationsBody({ now }: { now: Date | null }) {
  const [rows, setRows] = useState<IntegrationSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchIntegrations()
      .then((r) => live && setRows(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [nonce]);

  if (failed) {
    return <ErrorBody what="Couldn't read connectors" onRetry={() => setNonce((n) => n + 1)} />;
  }
  if (rows === null) return <SkeletonRows n={4} />;
  if (rows.length === 0) {
    return (
      <EmptyBody icon={<Blocks size={28} aria-hidden="true" />} text="Nothing connected yet">
        <a href="/integrations" className="rp-state-link">
          Connect a system →
        </a>
      </EmptyBody>
    );
  }

  // Problems first. Stable within a weight so the list doesn't reshuffle
  // between polls for connectors in the same state.
  const sorted = [...rows].sort((a, b) => {
    const d = statusWeight(a.status) - statusWeight(b.status);
    return d !== 0 ? d : a.provider.localeCompare(b.provider);
  });

  return (
    <div className="rp-rows rp-conns">
      {sorted.map((c) => {
        const pill = PILL[c.status] ?? PILL.NOT_CONFIGURED;
        const PillIcon = PILL_ICON[pill.icon];
        return (
          <div className="rp-conn" key={c.provider}>
            <span className="rp-conn-mark">{providerMark(c.provider)}</span>
            <div className="rp-conn-tx">
              <div className="rp-conn-name">
                {providerName(c.provider)}
                {/* Read-only is the norm and gets no chip — absence is the
                    quiet default; only the riskier posture is announced. */}
                {c.writeEnabled ? <span className="rp-chip is-writes">Writes on</span> : null}
              </div>
              <div className="rp-conn-sub">{now ? statusLine(c, now) : " "}</div>
            </div>
            <span className={`rp-pill is-${pill.tone}`}>
              <PillIcon size={11} aria-hidden="true" />
              {pill.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The chain chip. Renders `GET /api/activity/verify` — a server-side fact,
 * not a control. Verification cannot run client-side: the chain is
 * HMAC-signed with a key that never leaves the box.
 */
export function ChainChip({ canRead }: { canRead: boolean }) {
  const [result, setResult] = useState<VerifySummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let live = true;
    fetchChainVerify()
      .then((r) => live && setResult(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [canRead]);

  if (!canRead || failed || result === null) return null;

  return (
    <span className={`rp-chip ${result.ok ? "is-ok" : "is-broken"}`}>
      <ShieldCheck size={12} aria-hidden="true" />
      {result.ok ? "Chain verified" : "Chain broken"}
    </span>
  );
}
