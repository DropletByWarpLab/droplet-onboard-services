"use client";

/**
 * WARP-2977 (ADR-059 §3.1–3.2) — the Security command center's feed.
 *
 * Presentational: the page wires SWR, this renders. Two rules shape it:
 *
 *   1. "Nothing happened" and "nothing is reporting" must never look the
 *      same (§3.2). The header lists every source the feed listens to with
 *      its state, and an empty feed says WHICH of the two it is.
 *   2. P2 is a feed, not an alarm system. The copy says so, and nothing on
 *      this page claims the site is being watched over.
 *
 * Camera rows arrive already filtered to the viewer's camera grants, and
 * network/sign-in rows only for owners and admins — the server decides; this
 * component only hides the filter chip that would always be empty.
 *
 * WARP-2977 P2b adds areas and the site mode:
 *   - an "All areas" select (only when the viewer can see an area) that the
 *     page turns into `?zone=`; each row carries the names of the viewer's
 *     VISIBLE areas it happened in, and its second line leads with them;
 *   - `mode_changed` rows (site-wide, never in an area), titled by their
 *     summary with the mode's glyph;
 *   - the empty state reads the health rows of the sources THIS view is fed
 *     by (a quiet network view says nothing about the cameras), and never
 *     mentions network and sign-in warnings to someone who can't see them;
 *   - an area nothing covers (no camera linked yet — every new area) is its
 *     own empty state, checked first: no health row can vouch for a place no
 *     camera watches, so it must never read as quiet.
 *
 * WARP-2977 P2b-2 adds door locks, for people with Devices view (the server
 * sends their rows and the `locks` header row to no one else):
 *   - a Doors view, offered while the header carries a `locks` row that isn't
 *     "No door locks paired";
 *   - lock rows with a padlock glyph (closed only for locked), "Door lock" in
 *     their second line, and "Found when Droplet checked" when the 60 s check
 *     found the change rather than the live stream (its time is then the
 *     check's, not the change's);
 *   - the empty state reads the `locks` row for the views lock rows feed, and
 *     an area is "not covered" per view: a camera view of an area only a lock
 *     covers, or the Doors view of one no lock covers, never reads as quiet.
 */
import Link from "next/link";
import {
  Car,
  Loader2,
  Lock,
  LockOpen,
  Moon,
  PawPrint,
  Plane,
  RefreshCw,
  Shield,
  ShieldAlert,
  Store,
  User,
  Video,
  VideoOff,
  type LucideIcon,
} from "lucide-react";
import { formatRelativeTime } from "@/lib/relative-time";
import type { SecurityEvent, SecurityEventKind, SecurityHealthRow, SecurityZoneRef } from "@/lib/types";

export type SecurityView = "all" | "detections" | "health" | "doors" | "network";

export const COPY = {
  notAlarm: "Droplet shows what happened here. Alerts come later.",
  sourcesTitle: "What this feed is listening to",
  feedTitle: "Activity",
  feedDown: "The security feed isn't answering",
  feedDownBody: "This is not the same as a quiet site. Try again in a moment.",
  emptyNotListening: "Droplet isn't hearing from your cameras",
  emptyNotListeningBody:
    "So an empty feed here doesn't mean nothing happened. The source list above says what's wrong.",
  // WARP-2977 P2b — which source stopped depends on the view.
  emptyNotCheckingNetwork: "Droplet isn't checking the network and sign-in log",
  emptyNotCheckingHours: "Droplet isn't checking the opening hours",
  emptyUnchecked: "Droplet couldn't check its sources",
  emptyNoCameras: "No camera system is set up",
  // Only ever shown to owners and admins: nobody else gets these warnings.
  emptyNoCamerasBody: "Network and sign-in warnings and changes to the site mode still show up here.",
  emptyNoCamerasFamilyBody: "Changes to the site mode still show up here.",
  emptyNoCamerasViewBody: "This view fills in once a camera system is set up.",
  emptyQuiet: "Nothing to show",
  emptyQuietBody: "Everything above is reporting, and nothing matches this view yet. Events are kept for 30 days.",
  // WARP-2977 P2b — this view's own sources report, but something else above doesn't.
  emptyQuietViewBody:
    "The sources this view depends on are reporting, and nothing matches it yet. Events are kept for 30 days.",
  emptyPartialBody: "Some sources above are quiet or not reporting, so check them before reading this as a quiet site.",
  loadMore: "Show older",
  includeLow: "Include low-confidence",
  retry: "Retry",
  allAreas: "All areas",
  areaLabel: "Area",
  // WARP-2977 P2b — an area with no camera linked: nothing can report there.
  emptyNotCovered: "No cameras cover {area} yet",
  emptyNotCoveredManageBody: "So nothing can show up here. Choose its cameras on the Areas page.",
  emptyNotCoveredBody: "So nothing can show up here. Someone who manages Security can choose which cameras cover it.",
  openAreas: "Open Areas",
  modeRowSub: "Site mode",
  // WARP-2977 P2b-2 — door locks.
  lockRowSub: "Door lock",
  polledSub: "Found when Droplet checked",
  emptyNotHearingLocks: "Droplet isn't hearing from the door locks",
  emptyNoLocksLinked: "No door locks are linked to {area} yet",
  emptyNoLocksLinkedManageBody: "So nothing can show up here. Choose its door locks on the Areas page.",
  emptyNoLocksLinkedBody: "So nothing can show up here. Someone who manages Security can link its door locks.",
} as const;

/**
 * What the server appends to a polled lock row's summary. The row's second
 * line already says it (`COPY.polledSub`), so the title drops it rather than
 * saying it twice. Unmatched (the server's words changed), the title is the
 * summary as sent.
 */
const POLLED_SUMMARY_SUFFIX = " (found when Droplet checked)";

export const SOURCE_LABEL: Record<SecurityHealthRow["id"], string> = {
  camera_ingest: "Camera events",
  camera_system: "Camera system",
  // WARP-2977 P2b-2 — the Matter lock adapter (only people with Devices view get this row).
  locks: "Door locks",
  threat_mirror: "Network and sign-in warnings",
  // WARP-2977 P2b — the ticker that follows the opening hours (the site mode).
  site_mode: "Opening hours",
  retention: "Record keeping",
};

const STATE_BADGE: Record<SecurityHealthRow["state"], { cls: string; text: string }> = {
  ok: { cls: "badge ok", text: "Reporting" },
  quiet: { cls: "badge muted", text: "Quiet" },
  down: { cls: "badge danger", text: "Not reporting" },
  not_configured: { cls: "badge muted", text: "Not set up" },
};

const VIEW_LABEL: Record<SecurityView, string> = {
  all: "Everything",
  detections: "People and vehicles",
  health: "Camera health",
  doors: "Doors",
  network: "Network and sign-in",
};

/** Every camera row — detections and camera health — needs BOTH to arrive. */
const CAMERA_SOURCES: readonly SecurityHealthRow["id"][] = ["camera_ingest", "camera_system"];

/**
 * WARP-2977 P2b-2 — whether to offer the Doors view: the header carries a
 * `locks` row (the viewer may read locks) and it isn't "No door locks paired".
 * A `down` row still offers it: the view then says the locks aren't heard.
 */
export function canShowDoors(sources: SecurityHealthRow[] | null): boolean {
  const row = sources?.find((s) => s.id === "locks");
  return row !== undefined && row.state !== "not_configured";
}

/**
 * The view the page asks for: a picked Doors view falls back to Everything
 * once the header has loaded and offers no Doors (the last lock was unpaired,
 * or this person's Devices view was taken away) — never a chip-less view
 * stuck on an empty list. While the header loads, the pick stands.
 */
export function viewFor(view: SecurityView, sources: SecurityHealthRow[] | null): SecurityView {
  return view === "doors" && sources !== null && !canShowDoors(sources) ? "all" : view;
}

/**
 * WARP-2977 P2b — the health rows whose sources feed each view's rows. An
 * empty view reads ONLY these (a stopped threat check says nothing about an
 * empty camera view, and the reverse). A camera view reads both camera rows:
 * detections reach Droplet as camera events, and only while the camera system
 * itself runs. `retention` feeds no rows. The threat row exists only for
 * owners and admins (the server drops it for everyone else). Threats and mode
 * changes are site-wide and never sit in an area.
 *
 * WARP-2977 P2b-2 — the `locks` row feeds Everything and Doors, for someone
 * who gets that row (`canSeeLocks`). An area holds lock rows as well as camera
 * rows, but only the kinds that cover it (review F6): Everything over a
 * camera-only area never reads the locks row, and over a lock-only area never
 * the camera rows. `areaLinks` absent = both kinds.
 */
export function sourcesForView(
  view: SecurityView,
  opts: {
    canSeeThreats: boolean;
    areaSelected: boolean;
    canSeeLocks?: boolean;
    areaLinks?: { cameras: number; locks: number };
  },
): SecurityHealthRow["id"][] {
  const cameras = [...CAMERA_SOURCES];
  const locks: SecurityHealthRow["id"][] = opts.canSeeLocks ? ["locks"] : [];
  switch (view) {
    case "all":
      if (opts.areaSelected) {
        const links = opts.areaLinks;
        return [...(!links || links.cameras > 0 ? cameras : []), ...(!links || links.locks > 0 ? locks : [])];
      }
      return opts.canSeeThreats ? [...cameras, ...locks, "threat_mirror", "site_mode"] : [...cameras, ...locks, "site_mode"];
    case "detections":
    case "health":
      return cameras;
    case "doors":
      return locks;
    case "network":
      return opts.canSeeThreats ? ["threat_mirror"] : [];
  }
}

/** The `kind` filter each view sends. `includeLow` widens detections only. */
export function kindsForView(view: SecurityView, includeLow: boolean): SecurityEventKind[] | undefined {
  switch (view) {
    case "all":
      return undefined;
    case "detections":
      return includeLow ? ["detection", "detection_low"] : ["detection"];
    case "health":
      return ["camera_offline", "camera_online", "source_offline", "source_online"];
    case "doors":
      return ["lock_state"];
    case "network":
      return ["threat"];
  }
}

/**
 * One glyph per row. Exhaustive over `SecurityEventKind` — a new kind fails
 * the type check here (the `never` below) instead of rendering no icon.
 */
export function iconFor(e: SecurityEvent): LucideIcon {
  switch (e.kind) {
    case "detection":
    case "detection_low": {
      const label = e.labels[0];
      if (label === "car") return Car;
      if (label === "dog" || label === "cat") return PawPrint;
      return User;
    }
    case "camera_offline":
    case "source_offline":
      return VideoOff;
    case "camera_online":
    case "source_online":
      return Video;
    case "threat":
      return ShieldAlert;
    case "mode_changed": {
      // WARP-2977 P2b — labels = [mode, modeSource, fromMode].
      const mode = e.labels[0];
      if (mode === "open") return Store;
      if (mode === "closed") return Moon;
      if (mode === "away") return Plane;
      return Shield;
    }
    case "lock_state": {
      // WARP-2977 P2b-2 — labels = [reading]. A closed padlock only when it IS
      // locked; an unknown reading gets the neutral glyph, never a padlock.
      const reading = e.labels[0];
      if (reading === "locked") return Lock;
      if (reading === "unlocked" || reading === "not_fully_locked" || reading === "unlatched") return LockOpen;
      return Shield;
    }
    default: {
      const unhandled: never = e.kind;
      void unhandled;
      return Shield;
    }
  }
}

/** Camera health reads better with the household's name for the camera in it. */
function titleFor(e: SecurityEvent, cameraLabel: (name: string) => string): string {
  if (e.camera && e.kind === "camera_offline") return `${cameraLabel(e.camera)} stopped reporting`;
  if (e.camera && e.kind === "camera_online") return `${cameraLabel(e.camera)} is reporting again`;
  if (e.observed === "polled" && e.summary.endsWith(POLLED_SUMMARY_SUFFIX)) {
    return e.summary.slice(0, -POLLED_SUMMARY_SUFFIX.length);
  }
  return e.summary;
}

function subFor(e: SecurityEvent, cameraLabel: (name: string) => string): string {
  const parts: string[] = [];
  if (e.kind === "threat") parts.push(e.labels[0] === "auth" ? "Sign-in" : "Network");
  if (e.kind === "mode_changed") parts.push(COPY.modeRowSub);
  if (e.kind === "lock_state") parts.push(COPY.lockRowSub);
  if (e.observed === "polled") parts.push(COPY.polledSub);
  if (e.camera) parts.push(cameraLabel(e.camera));
  if (e.score !== null && (e.kind === "detection" || e.kind === "detection_low")) {
    parts.push(`${Math.round(e.score * 100)}% sure`);
  }
  if (e.kind === "detection_low") parts.push("low confidence");
  return parts.join(" · ");
}

export interface SecurityFeedProps {
  sources: SecurityHealthRow[] | null;
  healthError?: Error;
  events: SecurityEvent[];
  isLoading: boolean;
  error?: Error;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  view: SecurityView;
  onViewChange: (v: SecurityView) => void;
  includeLow: boolean;
  onIncludeLowChange: (v: boolean) => void;
  /** Owners and admins — the only people the network/sign-in rows are for. */
  canSeeThreats: boolean;
  /** Frigate camera name → the name the household gave it. Defaults to the Frigate name. */
  cameraLabel?: (name: string) => string;
  /**
   * WARP-2977 P2b — the areas the viewer can see, for the area select. The
   * select is hidden when this is null or empty, and in the network view,
   * whose rows never sit in an area. `linkCount` = the viewer's visible active
   * links (SecurityZoneView.links): 0 means nothing covers the area, and the
   * server answers its filter with an empty page without looking.
   * WARP-2977 P2b-2 — `cameraLinkCount` / `lockLinkCount` split it, so a
   * camera view of an area only a lock covers (and the Doors view of one no
   * lock covers) says so instead of reading as quiet. Absent: every link is
   * a camera link.
   */
  areas?: Array<SecurityZoneRef & { linkCount: number; cameraLinkCount?: number; lockLinkCount?: number }> | null;
  /** Whether the viewer manages Security — the not-covered empty state then links to the Areas page. */
  canManageAreas?: boolean;
  /** The selected area id, or null for all areas. */
  zone?: string | null;
  onZoneChange?: (zone: string | null) => void;
  now?: Date;
}

export function SecurityFeed(props: SecurityFeedProps) {
  const now = props.now ?? new Date();
  const views: SecurityView[] = [
    "all",
    "detections",
    "health",
    ...(canShowDoors(props.sources) ? (["doors"] as const) : []),
    ...(props.canSeeThreats ? (["network"] as const) : []),
  ];
  const showAreaSelect =
    Boolean(props.areas && props.areas.length > 0 && props.onZoneChange) && props.view !== "network";

  return (
    <div className="security-feed" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p className="security-note" style={{ margin: 0, color: "var(--text-muted)", fontSize: 13 }}>
        {COPY.notAlarm}
      </p>

      <SourcesCard sources={props.sources} error={props.healthError} now={now} />

      <section className="card" aria-labelledby="security-feed-title">
        <div className="card-h">
          <span className="ci">
            <Shield size={16} />
          </span>
          <span className="ct" id="security-feed-title">
            {COPY.feedTitle}
          </span>
        </div>

        <div className="chiprow" role="group" aria-label="Show" style={{ marginBottom: 12, alignItems: "center" }}>
          {views.map((v) => (
            <button
              key={v}
              type="button"
              className={`chip${props.view === v ? " on" : ""}`}
              aria-pressed={props.view === v}
              onClick={() => props.onViewChange(v)}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
          {(props.view === "all" || props.view === "detections") && (
            <button
              type="button"
              className={`chip${props.includeLow ? " on" : ""}`}
              aria-pressed={props.includeLow}
              onClick={() => props.onIncludeLowChange(!props.includeLow)}
            >
              {COPY.includeLow}
            </button>
          )}
          {showAreaSelect && props.areas && props.onZoneChange && (
            <AreaSelect areas={props.areas} zone={props.zone ?? null} onChange={props.onZoneChange} />
          )}
        </div>

        <FeedBody {...props} now={now} />
      </section>
    </div>
  );
}

/** "All areas / <area>…" — a native select, so it behaves the same on a phone. */
function AreaSelect({
  areas,
  zone,
  onChange,
}: {
  areas: SecurityZoneRef[];
  zone: string | null;
  onChange: (zone: string | null) => void;
}) {
  return (
    <label style={{ display: "inline-flex", maxWidth: "100%", minWidth: 0 }}>
      <span className="sr-only">{COPY.areaLabel}</span>
      <select
        value={zone ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        style={{
          height: 32,
          maxWidth: "100%",
          minWidth: 0,
          padding: "0 12px",
          borderRadius: "var(--radius-pill)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          fontSize: 13,
          textOverflow: "ellipsis",
        }}
      >
        <option value="">{COPY.allAreas}</option>
        {areas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function SourcesCard({ sources, error, now }: { sources: SecurityHealthRow[] | null; error?: Error; now: Date }) {
  return (
    <section className="card" aria-labelledby="security-sources-title">
      <div className="card-h">
        <span className="ct" id="security-sources-title">
          {COPY.sourcesTitle}
        </span>
      </div>
      {error ? (
        <div className="rows">
          <div className="lrow">
            <span className="rt">
              <span className="nm">Droplet couldn't check its sources</span>
              <span className="sub">Treat the feed below as unconfirmed until this clears.</span>
            </span>
            <span className={STATE_BADGE.down.cls}>{STATE_BADGE.down.text}</span>
          </div>
        </div>
      ) : sources === null ? (
        <div className="rows" aria-busy="true">
          <div className="lrow">
            <Loader2 size={16} className="animate-spin" aria-hidden />
          </div>
        </div>
      ) : (
        <ul className="rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {sources.map((s) => (
            <li className="lrow" key={s.id} data-source={s.id} data-state={s.state}>
              <span className="rt">
                <span className="nm">{SOURCE_LABEL[s.id]}</span>
                <span className="sub">
                  {s.detail}
                  {s.lastSeenAt ? ` · last heard ${formatRelativeTime(s.lastSeenAt, now)}` : ""}
                </span>
              </span>
              <span className={STATE_BADGE[s.state].cls}>{STATE_BADGE[s.state].text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedBody(props: SecurityFeedProps & { now: Date }) {
  const cameraLabel = props.cameraLabel ?? ((name: string) => name);
  if (props.error) {
    return (
      <div className="empty" role="alert">
        <span className="ei">
          <ShieldAlert size={24} />
        </span>
        <span className="eh">{COPY.feedDown}</span>
        <span style={{ maxWidth: "44ch" }}>{COPY.feedDownBody}</span>
        <button type="button" className="btn" onClick={props.onRetry} style={{ marginTop: 8 }}>
          <RefreshCw size={16} />
          {COPY.retry}
        </button>
      </div>
    );
  }

  if (props.isLoading) {
    return (
      <div className="empty" aria-busy="true">
        <Loader2 size={20} className="animate-spin" aria-hidden />
      </div>
    );
  }

  if (props.events.length === 0) {
    // Until the header has loaded, an empty feed cannot say which kind of
    // empty it is — so it says nothing yet rather than guess "all quiet".
    if (props.sources === null && !props.healthError) {
      return (
        <div className="empty" aria-busy="true">
          <Loader2 size={20} className="animate-spin" aria-hidden />
        </div>
      );
    }
    const [head, body, kind] = emptyStateFor(props);
    return (
      <div className="empty" data-empty={kind}>
        <span className="ei">
          <Shield size={24} />
        </span>
        <span className="eh">{head}</span>
        <span style={{ maxWidth: "48ch" }}>{body}</span>
        {kind === "not-covered" && props.canManageAreas && (
          <Link className="btn" href="/security/zones" style={{ marginTop: 8 }}>
            {COPY.openAreas}
          </Link>
        )}
      </div>
    );
  }

  return (
    <>
      <ul className="rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {props.events.map((e) => {
          const Icon = iconFor(e);
          const low = e.kind === "detection_low";
          return (
            <li
              className="lrow"
              key={e.id}
              data-kind={e.kind}
              data-observed={e.observed}
              style={low ? { opacity: 0.7 } : undefined}
            >
              <span className={`ri${e.severity === "info" ? "" : " brand"}`} aria-hidden>
                <Icon size={16} />
              </span>
              <span className="rt">
                {/* The shell's row title is one ellipsised line; a security
                    event's title is the part that must never be cut off. */}
                <span className="nm" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                  {e.camera ? (
                    <Link href={`/cameras/${encodeURIComponent(e.camera)}`}>{titleFor(e, cameraLabel)}</Link>
                  ) : (
                    titleFor(e, cameraLabel)
                  )}
                </span>
                <span
                  className="sub"
                  style={e.zones.length > 0 ? { whiteSpace: "normal", overflowWrap: "anywhere" } : undefined}
                >
                  {/* In the second line, not beside the title: on a phone a
                      badge column squeezes the headline to a word per line.
                      The areas lead it (WARP-2977 P2b): where comes first. */}
                  {e.zones.map((z) => (
                    <span key={z.id} className="badge muted" data-area={z.id} style={{ margin: "0 6px 2px 0" }}>
                      {z.name}
                    </span>
                  ))}
                  {e.severity === "alert" && (
                    <span className="badge danger" style={{ marginRight: 6 }}>
                      Serious
                    </span>
                  )}
                  <span>{subFor(e, cameraLabel)}</span>
                </span>
              </span>
              <time className="rmeta mono" dateTime={e.startedAt} title={new Date(e.startedAt).toLocaleString()}>
                {formatRelativeTime(e.startedAt, props.now)}
              </time>
            </li>
          );
        })}
      </ul>
      {props.hasMore && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <button type="button" className="btn" onClick={props.onLoadMore} disabled={props.isLoadingMore}>
            {props.isLoadingMore ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
            {COPY.loadMore}
          </button>
        </div>
      )}
    </>
  );
}

type EmptyKind = "not-covered" | "no-cameras" | "not-reporting" | "quiet" | "partial";

const isReporting = (row: SecurityHealthRow | undefined): boolean =>
  row?.state === "ok" || row?.state === "not_configured";

/**
 * Which empty an empty view is, read off the health rows of the sources that
 * feed THIS view (`sourcesForView`). A row the view depends on that the
 * header does not carry counts as not reporting: an empty view is called
 * quiet only when every source it depends on vouches for it.
 */
function emptyStateFor(props: SecurityFeedProps): [string, string, EmptyKind] {
  const areaSelected = Boolean(props.zone) && props.view !== "network";
  // First: the health rows say nothing about a place nothing of THIS view's
  // kind covers — no camera for a camera view, no lock for Doors (P2b-2),
  // nothing at all for Everything.
  const area = areaSelected ? props.areas?.find((a) => a.id === props.zone) : undefined;
  if (area) {
    if (props.view === "doors") {
      if ((area.lockLinkCount ?? 0) === 0) {
        return [
          COPY.emptyNoLocksLinked.replace("{area}", area.name),
          props.canManageAreas ? COPY.emptyNoLocksLinkedManageBody : COPY.emptyNoLocksLinkedBody,
          "not-covered",
        ];
      }
    } else if ((props.view === "all" ? area.linkCount : (area.cameraLinkCount ?? area.linkCount)) === 0) {
      return [
        COPY.emptyNotCovered.replace("{area}", area.name),
        props.canManageAreas ? COPY.emptyNotCoveredManageBody : COPY.emptyNotCoveredBody,
        "not-covered",
      ];
    }
  }
  if (props.healthError) return [COPY.emptyUnchecked, COPY.emptyNotListeningBody, "not-reporting"];
  const sources = props.sources ?? [];
  // The server sends the `locks` row only to someone who may read locks.
  const canSeeLocks = sources.some((s) => s.id === "locks");
  const ids = sourcesForView(props.view, {
    canSeeThreats: props.canSeeThreats,
    areaSelected,
    canSeeLocks,
    // Counted per kind by the page; absent counts (a caller that doesn't split them) read as both kinds.
    areaLinks:
      area && area.cameraLinkCount !== undefined && area.lockLinkCount !== undefined
        ? { cameras: area.cameraLinkCount, locks: area.lockLinkCount }
        : undefined,
  });

  // With no camera system neither camera row can report (camera_system is
  // not even sent); the view's OTHER sources still count.
  const noCameras = sources.find((s) => s.id === "camera_ingest")?.state === "not_configured";
  const expected = ids.filter((id) => !(noCameras && CAMERA_SOURCES.includes(id)));
  const rows = expected.map((id) => ({ id, row: sources.find((s) => s.id === id) }));

  // Checked BEFORE "no camera system": that copy promises the view's other
  // rows still show up, which is only true while their sources report.
  const down = rows.find(({ row }) => !row || row.state === "down");
  if (down) {
    const head =
      down.id === "threat_mirror"
        ? COPY.emptyNotCheckingNetwork
        : down.id === "site_mode"
          ? COPY.emptyNotCheckingHours
          : down.id === "locks"
            ? COPY.emptyNotHearingLocks
            : COPY.emptyNotListening;
    return [head, COPY.emptyNotListeningBody, "not-reporting"];
  }
  if (noCameras && ids.includes("camera_ingest")) {
    const body =
      props.view !== "all" || areaSelected
        ? COPY.emptyNoCamerasViewBody
        : props.canSeeThreats
          ? COPY.emptyNoCamerasBody
          : COPY.emptyNoCamerasFamilyBody;
    return [COPY.emptyNoCameras, body, "no-cameras"];
  }
  if (!rows.every(({ row }) => isReporting(row))) return [COPY.emptyQuiet, COPY.emptyPartialBody, "partial"];
  // "Everything above is reporting" is a claim about the WHOLE header. When
  // a source this view doesn't read is down or quiet, say only what is true.
  return sources.every((s) => isReporting(s))
    ? [COPY.emptyQuiet, COPY.emptyQuietBody, "quiet"]
    : [COPY.emptyQuiet, COPY.emptyQuietViewBody, "quiet"];
}
