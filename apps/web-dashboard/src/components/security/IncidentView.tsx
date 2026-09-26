"use client";

/**
 * WARP-2978 (ADR-059 P3 §8) — one incident, at /security/incidents/:id.
 *
 *   1. Header: title, span and the mode it opened in, the state, and — at
 *      act — Acknowledge and Resolve….
 *   2. Why Droplet flagged this: the visible codes first, with evidence.
 *   3. What happened: the visible events (the feed's row), each with its
 *      thumbnail, Clip (or Clip expired) and the other areas it was in; once
 *      the events are trimmed, the sentence that says what is kept.
 *   4. Who was told: the notices the box returned (owner/admin: all; anyone
 *      else: their own).
 *   5. Acknowledgements.
 *
 * Rules:
 *   · DS-005 — everything is the box's answer for THIS viewer. A section with
 *     nothing in it is left out; nothing is filled in. A missing incident and
 *     a hidden one read the same (404 → not found).
 *   · The controls render only at act — the module level (which fails
 *     closed) AND the box's own `viewer.level` — only when the box says the
 *     incident is `actionable` for this viewer, and only while it is open or
 *     acknowledged. Acknowledge also needs this person not to have yet
 *     (D23: each person's first acknowledgement is recorded). Never rendered
 *     and then refused: a refused click is an auth/warn row the threat mirror
 *     would show as a threat.
 *   · An open or acknowledged incident the box says is NOT actionable says
 *     so in one sentence — the same sentence whatever the cause (a view-only
 *     level, or a partial view: an alert on a camera this person can't see),
 *     so the words never tell a hidden camera apart from a level (DS-005).
 *     A partial view keeps this person's own acknowledgement: the box sends
 *     it, and it is shown like any other.
 *   · A person still in view (WARP-2978 PR-D, `detection_ongoing`) is its own
 *     row, marked "Still in view": their picture while their finished row
 *     isn't listed to carry it, and never a Clip — Frigate's clip is whole
 *     only once they've left, on the finished row.
 *   · In flight, both buttons are aria-disabled — never `disabled` — and a ref
 *     refuses a second press. When the button that was pressed goes away
 *     (Acknowledge after acknowledging, both after resolving), focus moves to
 *     Resolve… or to the state line, never to <body>.
 *   · A failure is a toast through `translateError(err, "security")`, never
 *     the server's message, then a re-read (a 409 means the incident moved).
 *   · Acknowledge sends the notification the page was opened from (`?n=`,
 *     set by the toaster and the service worker); the box keeps it only when
 *     it is this person's own notice for this incident.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, RefreshCw } from "lucide-react";
import { Phead } from "@/components/shell/primitives";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useCameraDisplayNames, useSecurityIncident, useSecurityMode } from "@/lib/hooks/useSecurity";
import { deviceTimeZone } from "@/lib/security-time";
import type { IncidentActionResult, IncidentDetail, IncidentMemberView } from "@/lib/types";
import { AckHistory } from "./AckHistory";
import { NoticeList } from "./NoticeList";
import { ReasonList } from "./ReasonList";
import { RESOLVE_COPY, ResolveDialog } from "./ResolveDialog";
import { SecurityEventRow } from "./SecurityFeed";
import { fill } from "./TimezoneSelect";
import {
  alertCameras,
  clipExpired,
  incidentTitle,
  openedInLine,
  severityBadge,
  spanText,
  stateChip,
  INCIDENT_COPY,
} from "./incident-copy";

export const COPY = {
  ...RESOLVE_COPY,
  back: "Security",
  acknowledge: "Acknowledge",
  // One sentence for every reason the box gives `actionable: false` (DS-005).
  cantAct: "You can't acknowledge or resolve this incident. An owner or admin can.",
  resolve: "Resolve…",
  acknowledgedToast: "Acknowledged",
  resolvedToast: "Resolved",
  whyTitle: "Why Droplet flagged this",
  whatTitle: "What happened",
  toldTitle: "Who was told",
  acksTitle: "Acknowledgements",
  clip: "Clip",
  clipExpired: "Clip expired",
  alsoIn: "Also in {areas}",
  trimmed:
    "The events behind this were removed after 30 days. Droplet keeps incidents for a year: when and where it happened, why it was flagged, who was told and who acknowledged it.",
  partlyTrimmed: "Some of the events behind this were removed after 30 days.",
  moreEvents: "Showing the latest {n} events.",
  noEvents: "No events to show.",
  timesIn: "Times are in {tz}.",
  notFound: "There's no such incident, or you can't see it",
  notFoundBody: "It may have been removed after a year, or it's about cameras you can't see.",
  backToSecurity: "Back to Security",
  loadError: "Droplet can't read this incident right now",
  loadErrorBody: "Try again in a moment.",
  refreshFailed: "Couldn't refresh this incident just now. This is the last version Droplet sent.",
  retry: "Retry",
  loading: "Loading the incident",
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A NotificationLog id (cuid): the shape route 19 accepts. */
const NOTIFICATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `?n=` as route 19 accepts it, or null — anything else would fail the box's strict body. */
export function notificationIdFrom(raw: string | null | undefined): string | null {
  return raw && NOTIFICATION_ID_RE.test(raw) ? raw : null;
}

const isNotFound = (err: unknown): boolean => {
  const e = err as { code?: unknown; status?: unknown } | undefined;
  return e?.code === "INCIDENT_NOT_FOUND" || e?.status === 404;
};
const errorCode = (err: unknown): string | undefined => {
  const c = (err as { code?: unknown } | undefined)?.code;
  return typeof c === "string" ? c : undefined;
};

export interface IncidentViewProps {
  id: string;
  /** The alert notification the page was opened from, already validated (`notificationIdFrom`). */
  notificationId: string | null;
  now?: Date;
}

export function IncidentView({ id, notificationId, now: nowProp }: IncidentViewProps) {
  const valid = UUID_RE.test(id);
  const q = useSecurityIncident(valid ? id : null);
  if (!valid) return <NotFound />;
  return <IncidentBody {...q} notificationId={notificationId} now={nowProp} />;
}

function NotFound() {
  return (
    <section className="card" data-testid="incident-not-found">
      <div className="empty">
        <span className="eh">{COPY.notFound}</span>
        <span style={{ maxWidth: "48ch" }}>{COPY.notFoundBody}</span>
        <Link className="btn" href="/security" style={{ marginTop: 8 }}>
          {COPY.backToSecurity}
        </Link>
      </div>
    </section>
  );
}

type Query = ReturnType<typeof useSecurityIncident>;

function IncidentBody({
  incident,
  error,
  refresh,
  acknowledge,
  resolve,
  notificationId,
  now: nowProp,
}: Query & { notificationId: string | null; now?: Date }) {
  const now = nowProp ?? new Date();
  const level = useModuleLevel("security");
  const { mode } = useSecurityMode();
  const cameraLabel = useCameraDisplayNames();
  const { toast } = useToast();
  const device = deviceTimeZone();
  const timezone = mode?.displayTimezone ?? device ?? "UTC";

  const [busy, setBusy] = useState<null | "acknowledge" | "resolve">(null);
  // The in-flight guard itself: the buttons stay focusable (aria-disabled), so
  // a second press between renders is refused here, not by `disabled`.
  const busyRef = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [focusAfter, setFocusAfter] = useState<null | "acknowledge" | "resolve">(null);
  const ackRef = useRef<HTMLButtonElement | null>(null);
  const resolveRef = useRef<HTMLButtonElement | null>(null);
  const stateRef = useRef<HTMLDivElement | null>(null);

  const ids = { why: useId(), what: useId(), told: useId(), acks: useId() };

  // After a write lands, the button that was pressed may be gone: put focus
  // where the person can carry on, never on <body>.
  useEffect(() => {
    if (!focusAfter) return;
    if (focusAfter === "acknowledge" && ackRef.current) {
      // Still there (nothing changed): focus never left it.
    } else if (resolveRef.current) {
      resolveRef.current.focus();
    } else {
      stateRef.current?.focus();
    }
    setFocusAfter(null);
  }, [focusAfter, incident]);

  const run = useCallback(
    async (action: "acknowledge" | "resolve", write: () => Promise<IncidentActionResult>): Promise<string | null> => {
      if (busyRef.current) return "BUSY";
      busyRef.current = true;
      setBusy(action);
      try {
        const r = await write();
        // `changed:false` (already done) is silent.
        if (r.changed) toast(action === "acknowledge" ? COPY.acknowledgedToast : COPY.resolvedToast, "success");
        return null;
      } catch (err) {
        // Typed copy only (409 INCIDENT_CONFLICT / NOT_ACTIONABLE, 503
        // AUDIT_UNAVAILABLE, …) — never err.message. Then re-read, and WAIT
        // for it (WARP-3185 A): a refusal can take the buttons away, and focus
        // is placed only once the page shows the incident as it now stands —
        // placed earlier, it lands on a button about to vanish, then <body>.
        toast(translateError(err, "security"), "error");
        try {
          await refresh();
        } catch {
          // A failed re-read is the page's own "couldn't refresh" line.
        }
        return errorCode(err) ?? "UNKNOWN";
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [toast, refresh],
  );

  if (error && (isNotFound(error) || !incident)) {
    if (isNotFound(error)) return <NotFound />;
    return (
      <section className="card" role="alert" data-testid="incident-error">
        <div className="empty">
          <span className="eh">{COPY.loadError}</span>
          <span style={{ maxWidth: "48ch" }}>{COPY.loadErrorBody}</span>
          <button type="button" className="btn" onClick={() => void refresh()} style={{ marginTop: 8 }}>
            <RefreshCw size={16} aria-hidden />
            {COPY.retry}
          </button>
        </div>
      </section>
    );
  }
  if (!incident) {
    return (
      <section className="card" aria-busy="true" data-testid="incident-loading">
        <div className="empty">
          <Loader2 size={20} className="animate-spin" aria-hidden />
          <span className="sr-only">{COPY.loading}</span>
        </div>
      </section>
    );
  }

  const i: IncidentDetail = incident;
  const canAct = levelAtLeast(level, "act") && levelAtLeast(i.viewer.level, "act") && i.actionable === true;
  const live = i.state === "open" || i.state === "acknowledged";
  const showAck = canAct && live && !i.viewer.acknowledged;
  const showResolve = canAct && live;
  // The box's answer alone decides the sentence, never the module level: that
  // reads `view` while it loads, and the sentence would flash for someone who can act.
  const cantAct = live && i.actionable !== true;
  const badge = severityBadge(i.severity);
  const chip = stateChip(i.state, i.severity);
  const title = incidentTitle(i, cameraLabel);

  const onAcknowledge = () => {
    void run("acknowledge", () => acknowledge({ notificationId })).then((failed) => {
      if (failed !== "BUSY") setFocusAfter("acknowledge");
    });
  };
  const onResolve = (note: string) => {
    void run("resolve", () => resolve({ note })).then((failed) => {
      if (failed === "BUSY") return;
      // A note the box refused, or an outage: keep the dialog (and the note) to try again.
      // The incident moved or went away: close it; the re-read shows where it stands.
      if (failed === null || failed === "INCIDENT_CONFLICT" || failed === "NOT_ACTIONABLE" || failed === "INCIDENT_NOT_FOUND") {
        setDialogOpen(false);
        setFocusAfter("resolve");
      }
    });
  };

  const actions =
    showAck || showResolve ? (
      <>
        {showAck && (
          <button
            ref={ackRef}
            type="button"
            className={i.state === "open" ? "btn primary" : "btn"}
            aria-disabled={busy !== null || undefined}
            onClick={onAcknowledge}
          >
            {COPY.acknowledge}
          </button>
        )}
        {showResolve && (
          <button
            ref={resolveRef}
            type="button"
            className="btn"
            aria-disabled={busy !== null || undefined}
            aria-haspopup="dialog"
            onClick={() => {
              if (busyRef.current) return;
              setDialogOpen(true);
            }}
          >
            {COPY.resolve}
          </button>
        )}
      </>
    ) : undefined;

  const alertCams = alertCameras(i.reasons, cameraLabel);

  return (
    <>
      <Link
        href="/security"
        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, color: "var(--text-muted)", alignSelf: "flex-start" }}
      >
        <ChevronLeft size={14} aria-hidden />
        {COPY.back}
      </Link>
      <Phead title={title} sub={`${spanText(i.firstActivityAt, i.lastActivityAt, timezone, now)} · ${openedInLine(i.openedInMode)}`} actions={actions} />
      <div
        ref={stateRef}
        tabIndex={-1}
        data-testid="incident-state"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-muted)", outlineOffset: 4 }}
      >
        {badge && <span className={badge.cls}>{badge.text}</span>}
        {chip && <span className={chip.cls}>{chip.text}</span>}
        {i.grouping === "collecting" && <span>{INCIDENT_COPY.stillHappening}</span>}
        {timezone !== device && <span>{fill(COPY.timesIn, { tz: timezone })}</span>}
        {error && (
          <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {COPY.refreshFailed}
            <button type="button" className="btn sm" onClick={() => void refresh()}>
              <RefreshCw size={14} aria-hidden />
              {COPY.retry}
            </button>
          </span>
        )}
      </div>
      {cantAct && (
        <p data-testid="incident-cant-act" style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", maxWidth: "70ch" }}>
          {COPY.cantAct}
        </p>
      )}

      {i.reasons.length > 0 && (
        <>
          <SectTitle id={ids.why} title={COPY.whyTitle} />
          <section className="card" aria-labelledby={ids.why}>
            <ReasonList reasons={i.reasons} cameraLabel={cameraLabel} timezone={timezone} now={now} labelledBy={ids.why} />
          </section>
        </>
      )}

      <SectTitle id={ids.what} title={COPY.whatTitle} />
      <section className="card" aria-labelledby={ids.what}>
        <WhatHappened incident={i} cameraLabel={cameraLabel} now={now} />
      </section>

      {i.notices.length > 0 && (
        <>
          <SectTitle id={ids.told} title={COPY.toldTitle} />
          <section className="card" aria-labelledby={ids.told}>
            <NoticeList notices={i.notices} cameras={alertCams} timezone={timezone} now={now} labelledBy={ids.told} />
          </section>
        </>
      )}

      {i.acks.length > 0 && (
        <>
          <SectTitle id={ids.acks} title={COPY.acksTitle} />
          <section className="card" aria-labelledby={ids.acks}>
            <AckHistory acks={i.acks} timezone={timezone} now={now} labelledBy={ids.acks} />
          </section>
        </>
      )}

      {showResolve && (
        <ResolveDialog
          open={dialogOpen}
          busy={busy === "resolve"}
          triggerRef={resolveRef}
          onClose={() => {
            if (!busyRef.current) setDialogOpen(false);
          }}
          onConfirm={onResolve}
        />
      )}
    </>
  );
}

/** A `.sect` heading (the shell's section label), with an id for its card to point at. */
function SectTitle({ id, title }: { id: string; title: string }) {
  return (
    <div className="sect">
      <h2 id={id}>{title}</h2>
    </div>
  );
}

function WhatHappened({
  incident: i,
  cameraLabel,
  now,
}: {
  incident: IncidentDetail;
  cameraLabel: (name: string) => string;
  now: Date;
}) {
  if (i.eventsKept === "removed") {
    return (
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-muted)", maxWidth: "70ch" }} data-trimmed="removed">
        {COPY.trimmed}
      </p>
    );
  }
  // The Frigate events whose finished row is listed: a person's early "still
  // in view" row leaves the picture to it.
  const finished = new Set(i.events.filter((e) => isFinishedDetection(e) && e.frigateEventId).map((e) => e.frigateEventId));
  return (
    <>
      {i.events.length > 0 ? (
        <ul className="rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {i.events.map((e) => (
            <SecurityEventRow key={e.id} event={e} cameraLabel={cameraLabel} now={now} testId={`incident-event-${e.id}`}>
              <EventMedia event={e} now={now} finishedRowListed={finished.has(e.frigateEventId)} />
            </SecurityEventRow>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--text-muted)" }}>{COPY.noEvents}</p>
      )}
      {(i.moreEvents || i.eventsKept === "partly_removed") && (
        <p style={{ margin: "12px 0 0", fontSize: 12.5, color: "var(--text-muted)" }}>
          {[i.moreEvents ? fill(COPY.moreEvents, { n: String(i.events.length) }) : null, i.eventsKept === "partly_removed" ? COPY.partlyTrimmed : null]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
    </>
  );
}

const isFinishedDetection = (e: Pick<IncidentMemberView, "kind">): boolean => e.kind === "detection" || e.kind === "detection_low";

/**
 * Thumbnail, Clip (or Clip expired) and the other areas this event was in.
 * An `alsoIn` area the row already names as a badge (its `zones`) isn't
 * repeated. A person still in view (PR-D) gets their picture only while their
 * finished row isn't listed (that row carries it), and never a Clip.
 */
function EventMedia({ event: e, now, finishedRowListed }: { event: IncidentMemberView; now: Date; finishedRowListed: boolean }) {
  const [thumbGone, setThumbGone] = useState(false);
  const fromFrigate = e.source === "frigate" && Boolean(e.frigateEventId);
  const clip = fromFrigate && isFinishedDetection(e);
  const thumb = clip || (fromFrigate && e.kind === "detection_ongoing" && !finishedRowListed);
  const shown = new Set((e.zones ?? []).map((z) => z.id));
  const alsoIn = e.alsoIn.filter((z) => !shown.has(z.id));
  if (!thumb && alsoIn.length === 0) return null;
  const expired = clipExpired(e.startedAt, now);
  const ref = e.frigateEventId ? encodeURIComponent(e.frigateEventId) : "";
  return (
    <span className="sub" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", marginTop: 8, whiteSpace: "normal" }}>
      {thumb && !expired && !thumbGone && (
        // A camera snapshot proxied by the box under its own camera guard; not a static asset next/image could optimise.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/cameras/events/${ref}/thumbnail`}
          alt={e.summary}
          width={96}
          height={54}
          loading="lazy"
          onError={() => setThumbGone(true)}
          style={{ width: 96, height: 54, objectFit: "cover", borderRadius: 8, background: "var(--inset)", flexShrink: 0 }}
        />
      )}
      {clip &&
        (expired ? (
          <span>{COPY.clipExpired}</span>
        ) : (
          <a href={`/api/cameras/clips/event/${ref}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)" }}>
            {COPY.clip}
          </a>
        ))}
      {alsoIn.length > 0 && <span>{fill(COPY.alsoIn, { areas: alsoIn.map((z) => z.name).join(", ") })}</span>}
    </span>
  );
}
