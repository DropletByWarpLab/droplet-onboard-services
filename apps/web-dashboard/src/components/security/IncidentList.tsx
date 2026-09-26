"use client";

/**
 * WARP-2978 (ADR-059 P3 §8) — the Incidents tab on /security: the feed,
 * grouped. Presentational — the page wires SWR, this renders.
 *
 *   · `Needs attention` (state=attention: open, nobody on it yet) and `All`;
 *     the area select the feed uses; newest activity first, `Show older`.
 *   · Each row is an IncidentCard — the box's answer for this viewer (DS-005).
 *   · An empty list says WHICH empty it is (P2a's rule, `incidentsEmpty`):
 *     never "Nothing needs attention" while the incident engine, a camera
 *     source, the opening hours or (for owners and admins) the threat check
 *     is down, and nothing at all until the source header has loaded.
 *   · A failed read is an error with Retry, never an empty list.
 */
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import type { IncidentSummary, SecurityHealthRow, SecurityZoneRef } from "@/lib/types";
import { IncidentCard } from "./IncidentCard";
import { INCIDENT_COPY, incidentsEmpty } from "./incident-copy";
import { AreaSelect } from "./SecurityFeed";
import { useShowOlder } from "./show-older";

export type IncidentFilter = "attention" | "all";

export const COPY = {
  // The two tabs on /security (the page reads these; a page file may not export copy).
  tabIncidents: "Incidents",
  tabEverything: "Everything",
  tabsLabel: "Security",
  tabAttention: "{label}, {n} need attention",
  filterLabel: "Show",
  all: "All",
  loadError: "Droplet can't read the incidents right now",
  loadErrorBody: "This is not the same as a quiet site. Try again in a moment.",
  // WARP-3185 — a refresh that failed with incidents already shown: they stay, and say how old they are.
  refreshFailed: "Couldn't refresh the incidents just now. This is the last list Droplet sent.",
  retry: "Retry",
  loadMore: "Show older",
  showEverything: "Show everything",
} as const;

export interface IncidentListProps {
  /** null until the first page has loaded. */
  incidents: IncidentSummary[] | null;
  isLoading: boolean;
  error?: Error;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  filter: IncidentFilter;
  onFilterChange: (f: IncidentFilter) => void;
  /** The areas the viewer can see; `linkCount` = their visible active links (0 = nothing covers it). */
  areas?: Array<SecurityZoneRef & { linkCount: number }> | null;
  zone?: string | null;
  onZoneChange?: (zone: string | null) => void;
  /** The health header (GET /api/security/health) — what an empty list is read against. */
  sources: SecurityHealthRow[] | null;
  healthError?: Error;
  /** Owners and admins: the threat check counts for them. */
  canSeeThreats: boolean;
  cameraLabel?: (name: string) => string;
  timezone: string;
  now?: Date;
  /** Switch to the Everything tab, where each source says what's wrong. */
  onShowEverything?: () => void;
}

export function IncidentList(props: IncidentListProps) {
  const now = props.now ?? new Date();
  const showAreaSelect = Boolean(props.areas && props.areas.length > 0 && props.onZoneChange);
  const filters: Array<[IncidentFilter, string]> = [
    ["attention", INCIDENT_COPY.needsAttention],
    ["all", COPY.all],
  ];
  return (
    <section className="card" data-incident-list>
      <div className="chiprow" role="group" aria-label={COPY.filterLabel} style={{ marginBottom: 12, alignItems: "center" }}>
        {filters.map(([f, label]) => (
          <button
            key={f}
            type="button"
            className={`chip${props.filter === f ? " on" : ""}`}
            aria-pressed={props.filter === f}
            onClick={() => props.onFilterChange(f)}
          >
            {label}
          </button>
        ))}
        {showAreaSelect && props.areas && props.onZoneChange && (
          <AreaSelect areas={props.areas} zone={props.zone ?? null} onChange={props.onZoneChange} />
        )}
      </div>
      <ListBody {...props} now={now} />
    </section>
  );
}

function Busy() {
  return (
    <div className="empty" aria-busy="true">
      <Loader2 size={20} className="animate-spin" aria-hidden />
    </div>
  );
}

function ListBody(props: IncidentListProps & { now: Date }) {
  // Before any early return: a hook runs on every render.
  const older = useShowOlder({
    count: props.incidents?.length ?? 0,
    hasMore: props.hasMore,
    isLoadingMore: props.isLoadingMore,
    onLoadMore: props.onLoadMore,
  });
  if (props.error && !props.incidents?.length) {
    return (
      <div className="empty" role="alert">
        <span className="ei">
          <ShieldAlert size={24} />
        </span>
        <span className="eh">{COPY.loadError}</span>
        <span style={{ maxWidth: "44ch" }}>{COPY.loadErrorBody}</span>
        <button type="button" className="btn" onClick={props.onRetry} style={{ marginTop: 8 }}>
          <RefreshCw size={16} aria-hidden />
          {COPY.retry}
        </button>
      </div>
    );
  }
  if (props.incidents === null) return <Busy />;

  if (props.incidents.length === 0) {
    // Until the header has loaded, an empty list can't say which empty it is.
    if (props.sources === null && !props.healthError) return <Busy />;
    const area = props.zone ? props.areas?.find((a) => a.id === props.zone) ?? null : null;
    const empty = incidentsEmpty({
      filter: props.filter,
      sources: props.sources,
      healthError: Boolean(props.healthError),
      canSeeThreats: props.canSeeThreats,
      area,
    });
    return (
      <div className="empty" data-empty={empty.kind}>
        <span className="ei">
          <ShieldAlert size={24} />
        </span>
        <span className="eh">{empty.head}</span>
        <span style={{ maxWidth: "48ch" }}>{empty.body}</span>
        {(empty.kind === "not-reporting" || empty.kind === "partial") && props.onShowEverything && (
          <button type="button" className="btn" onClick={props.onShowEverything} style={{ marginTop: 8 }}>
            {COPY.showEverything}
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {props.error && (
        <p
          role="status"
          data-refresh-failed
          style={{ margin: "0 0 8px", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 13, color: "var(--text-muted)" }}
        >
          <span style={{ flex: "1 1 220px" }}>{COPY.refreshFailed}</span>
          <button type="button" className="btn sm" onClick={props.onRetry}>
            <RefreshCw size={14} aria-hidden />
            {COPY.retry}
          </button>
        </p>
      )}
      <ul ref={older.listRef} className="rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {props.incidents.map((i) => (
          <IncidentCard key={i.id} incident={i} cameraLabel={props.cameraLabel} timezone={props.timezone} now={props.now} />
        ))}
      </ul>
      {props.hasMore && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          {/* aria-disabled, never disabled: the pressed button keeps focus (WARP-3185 B). */}
          <button type="button" className="btn" onClick={older.onClick} aria-disabled={props.isLoadingMore || undefined}>
            {props.isLoadingMore ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
            {COPY.loadMore}
          </button>
        </div>
      )}
    </>
  );
}
