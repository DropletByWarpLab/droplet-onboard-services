"use client";

/**
 * WARP-246 — the audit timeline list for /admin/audit.
 *
 * Presentational: rows in, day-grouped `.lrow` timeline out. The page
 * owns fetching, filters, and pagination. Severity is conveyed twice
 * (tinted icon container AND a text badge for warn/err) so the state
 * survives color-blindness and grayscale screens.
 */

import * as Icons from "lucide-react";
import { Badge } from "@/components/shell/primitives";
import { KIND_LABELS, type ActivityItem } from "./types";

/** WARP-1009 — homeowner-readable "who did this" line. Directory names
 *  are progressive enhancement: with no `userNames` entry the user's
 *  short id still identifies the actor; a v1 pre-upgrade row (null
 *  actor — its actor columns are outside the signature) states that
 *  explicitly rather than rendering a blank. */
function actorLabel(
  item: ActivityItem,
  userNames?: ReadonlyMap<string, string>,
): string {
  switch (item.actorType) {
    case "user": {
      const name = item.actorId ? userNames?.get(item.actorId) : undefined;
      if (name) return `by ${name}`;
      return item.actorId ? `by user ${item.actorId.slice(0, 8)}…` : "by a person";
    }
    case "ai":
      return "by Droplet AI";
    case "system":
      return "by the system";
    case "anonymous":
      return "by an anonymous visitor";
    default:
      return "unattributed (recorded before actor tracking)";
  }
}

/** kebab-case wire icon name ("shield-alert") → lucide component. */
function iconFor(name: string): Icons.LucideIcon {
  const pascal = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const candidate = (Icons as unknown as Record<string, Icons.LucideIcon>)[pascal];
  return candidate ?? Icons.Activity;
}

/** `.sev-ic.<x>` classes live in droplet-shell.css, mirroring the badge palette. */
const SEVERITY_CLASS: Record<string, string | undefined> = {
  warn: "sev-ic warn",
  err: "sev-ic err",
};

function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round(
    (startOf(now).getTime() - startOf(d).getTime()) / 86_400_000,
  );
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function SkeletonRows() {
  return (
    <div aria-hidden className="animate-pulse">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="lrow">
          <span className="ri" style={{ background: "var(--inset)" }} />
          <span className="rt">
            <span
              style={{
                display: "block",
                height: 12,
                width: `${52 - (i % 3) * 9}%`,
                borderRadius: 6,
                background: "var(--inset)",
              }}
            />
            <span
              style={{
                display: "block",
                height: 10,
                width: `${30 - (i % 2) * 8}%`,
                borderRadius: 6,
                background: "var(--inset)",
                marginTop: 6,
              }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

export function AuditTimeline({
  items,
  loading,
  hasFilters,
  onClearFilters,
  userNames,
}: {
  items: ActivityItem[];
  loading: boolean;
  hasFilters: boolean;
  onClearFilters: () => void;
  /** actorId (user UUID) → display name, resolved by the page. */
  userNames?: ReadonlyMap<string, string>;
}) {
  if (loading && items.length === 0) {
    return (
      <div className="card" aria-busy="true">
        <SkeletonRows />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <span className="ei">
            <Icons.ScrollText size={24} />
          </span>
          <span className="eh">
            {hasFilters ? "Nothing matches these filters" : "No activity yet"}
          </span>
          <span>
            {hasFilters
              ? "Try a wider time range or fewer filters."
              : "Sign-ins, file changes, and device actions will appear here as your Droplet is used."}
          </span>
          {hasFilters && (
            <button type="button" className="btn sm ghost" onClick={onClearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </div>
    );
  }

  // Group consecutive rows by calendar day. Rows arrive newest-first,
  // so groups render Today → Yesterday → older.
  const now = new Date();
  const groups: Array<{ label: string; rows: ActivityItem[] }> = [];
  for (const item of items) {
    const label = dayLabel(item.at, now);
    const tail = groups[groups.length - 1];
    if (tail && tail.label === label) tail.rows.push(item);
    else groups.push({ label, rows: [item] });
  }

  return (
    <div className="card">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h2
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              padding: "10px 2px 2px",
            }}
          >
            {group.label}
          </h2>
          <ul aria-label={`Activity on ${group.label}`} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {group.rows.map((item) => {
              const Icon = iconFor(item.sourceIcon);
              const sevClass = SEVERITY_CLASS[item.severity];
              return (
                <li key={item.id} className="lrow">
                  <span className={"ri " + (sevClass ?? "brand")} aria-hidden>
                    <Icon size={16} />
                  </span>
                  <span className="rt">
                    <span className="nm">{item.what}</span>
                    {item.sub ? <span className="sub">{item.sub}</span> : null}
                    <span className="sub" style={{ fontStyle: "italic" }}>
                      {actorLabel(item, userNames)}
                    </span>
                  </span>
                  {item.severity === "err" && <Badge kind="danger">error</Badge>}
                  {item.severity === "warn" && <Badge kind="warn">warning</Badge>}
                  {/* The kind chip duplicates the kind filter's vocabulary;
                      on narrow phones it loses to the `what` text (CSS
                      utility hides it ≤480px). */}
                  <span className="hide-narrow">
                    <Badge kind="muted">{KIND_LABELS[item.kind] ?? item.kind}</Badge>
                  </span>
                  <span className="rmeta mono" title={new Date(item.at).toLocaleString()}>
                    {timeLabel(item.at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
