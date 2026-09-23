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
 */
import Link from "next/link";
import {
  Car,
  Loader2,
  PawPrint,
  RefreshCw,
  Shield,
  ShieldAlert,
  User,
  Video,
  VideoOff,
  type LucideIcon,
} from "lucide-react";
import { formatRelativeTime } from "@/lib/relative-time";
import type { SecurityEvent, SecurityEventKind, SecurityHealthRow } from "@/lib/types";

export type SecurityView = "all" | "detections" | "health" | "network";

export const COPY = {
  notAlarm: "Droplet shows what happened here. Alerts come later.",
  sourcesTitle: "What this feed is listening to",
  feedTitle: "Activity",
  feedDown: "The security feed isn't answering",
  feedDownBody: "This is not the same as a quiet site. Try again in a moment.",
  emptyNotListening: "Droplet isn't hearing from your cameras",
  emptyNotListeningBody:
    "So an empty feed here doesn't mean nothing happened. The source list above says what's wrong.",
  emptyNoCameras: "No camera system is set up",
  emptyNoCamerasBody: "Network and sign-in warnings still show up here for owners and admins.",
  emptyQuiet: "Nothing to show",
  emptyQuietBody: "Everything above is reporting, and nothing matches this view yet. Events are kept for 30 days.",
  emptyPartialBody: "Some sources above are quiet or not reporting, so check them before reading this as a quiet site.",
  loadMore: "Show older",
  includeLow: "Include low-confidence",
  retry: "Retry",
} as const;

const SOURCE_LABEL: Record<SecurityHealthRow["id"], string> = {
  camera_ingest: "Camera events",
  camera_system: "Camera system",
  threat_mirror: "Network and sign-in warnings",
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
  network: "Network and sign-in",
};

/** The `kind` filter each view sends. `includeLow` widens detections only. */
export function kindsForView(view: SecurityView, includeLow: boolean): SecurityEventKind[] | undefined {
  switch (view) {
    case "all":
      return undefined;
    case "detections":
      return includeLow ? ["detection", "detection_low"] : ["detection"];
    case "health":
      return ["camera_offline", "camera_online", "source_offline", "source_online"];
    case "network":
      return ["threat"];
  }
}

function iconFor(e: SecurityEvent): LucideIcon {
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
  }
}

function subFor(e: SecurityEvent): string {
  const parts: string[] = [];
  if (e.kind === "threat") parts.push(e.labels[0] === "auth" ? "Sign-in" : "Network");
  if (e.camera) parts.push(e.camera);
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
  now?: Date;
}

export function SecurityFeed(props: SecurityFeedProps) {
  const now = props.now ?? new Date();
  const views: SecurityView[] = props.canSeeThreats
    ? ["all", "detections", "health", "network"]
    : ["all", "detections", "health"];

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

        <div className="chiprow" role="group" aria-label="Show" style={{ marginBottom: 12 }}>
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
        </div>

        <FeedBody {...props} now={now} />
      </section>
    </div>
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
    const ingest = props.sources?.find((s) => s.id === "camera_ingest");
    const allReporting = (props.sources ?? []).every((s) => s.state === "ok" || s.state === "not_configured");
    const [head, body, kind] =
      ingest?.state === "not_configured"
        ? [COPY.emptyNoCameras, COPY.emptyNoCamerasBody, "no-cameras"]
        : props.healthError || !ingest || ingest.state === "down"
          ? [COPY.emptyNotListening, COPY.emptyNotListeningBody, "not-reporting"]
          : allReporting
            ? [COPY.emptyQuiet, COPY.emptyQuietBody, "quiet"]
            : [COPY.emptyQuiet, COPY.emptyPartialBody, "partial"];
    return (
      <div className="empty" data-empty={kind}>
        <span className="ei">
          <Shield size={24} />
        </span>
        <span className="eh">{head}</span>
        <span style={{ maxWidth: "48ch" }}>{body}</span>
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
            <li className="lrow" key={e.id} data-kind={e.kind} style={low ? { opacity: 0.7 } : undefined}>
              <span className={`ri${e.severity === "info" ? "" : " brand"}`} aria-hidden>
                <Icon size={16} />
              </span>
              <span className="rt">
                <span className="nm">
                  {e.camera ? (
                    <Link href={`/cameras/${encodeURIComponent(e.camera)}`}>{e.summary}</Link>
                  ) : (
                    e.summary
                  )}
                </span>
                <span className="sub">{subFor(e)}</span>
              </span>
              {e.severity === "alert" && <span className="badge danger">Serious</span>}
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
