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

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Blocks,
  Cpu,
  FolderOpen,
  HardDrive,
  Lock,
  Network,
  RefreshCw,
  ShieldCheck,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { fetchAdminFilesUsage } from "@/lib/api";
import type { AdminUsageDepartmentRow } from "@/lib/types";
import type { ActivityItem } from "@/components/audit/types";
import {
  ForbiddenError,
  fetchActivityRange,
  fetchChainVerify,
  type HomeTile,
  type VerifySummary,
} from "./api";
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
