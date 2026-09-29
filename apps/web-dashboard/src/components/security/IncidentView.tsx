"use client";

/**
 * WARP-2978 (ADR-059 P3 §8) — one incident, at /security/incidents/:id.
 *
 *   1. Header: title, span and the mode it opened in, the state, and — at
 *      act — Acknowledge and Resolve….
 *   2. Why Droplet flagged this: the visible codes first, with evidence.
 *   2b. Summary by Droplet (WARP-2979 P4 PR-2, NarrativeSection): AFTER the
 *      codes, never before them — the reasons are the record; the summary
 *      is the box's own model's words, shown only when the box sends it
 *      for this viewer (DS-005). Regenerate / Summarise now at act, on any
 *      state (a resolved incident too).
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
 *   · WARP-3195 (P4 §6.7.1, §8) — under the reasons, each camera only Droplet
 *     linked to this area (`dropletLinks`): "Droplet linked this camera. Keep
 *     the link to get alerts from it." with Keep (route 24). Manage only —
 *     the module level AND the box's `viewer.level`; the box itself sends the
 *     list only then. The section is there for these lines alone when nothing
 *     was flagged: that is the case they explain (Droplet's links never
 *     alert). Keep follows the rules above — aria-disabled and a ref guard in
 *     flight; `translateError`, then a re-read, on a refusal; focus stays on
 *     Keep while its line is there, and goes to the state line once it isn't.
 *
 * WARP-2980 (ADR-059 P5 PR-C) — patterns on the incident page:
 *   · the pattern flags (route 18's `patternFlags`: trial, or kept quiet by
 *     expected activity) sit in the reasons card after the counted reasons
 *     (PatternFlagList). With flags and no counted reason the card is headed
 *     "What Droplet would have flagged": it flagged nothing;
 *   · a trial flag is shown to an owner or admin only (spec §6.13, D19) —
 *     the box sends flags to nobody else, and the page drops a trial flag for
 *     any other role (or none yet) even if a box did;
 *   · "Was this expected?" (VerdictBar) follows the reasons, gated by the
 *     module level, the box's `viewer.level` and `viewer.canGiveVerdict`;
 *     it shares the page's one-write-at-a-time guard, because a verdict and
 *     an acknowledgement race the incident's version.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Link2, Loader2, RefreshCw } from "lucide-react";
import { Phead } from "@/components/shell/primitives";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { useAuth } from "@/lib/auth";
import { levelAtLeast, useModuleLevel } from "@/lib/hooks/useModuleGate";
import { useCameraDisplayNames, useSecurityHealth, useSecurityIncident, useSecurityMode } from "@/lib/hooks/useSecurity";
import { deviceTimeZone } from "@/lib/security-time";
import type {
  IncidentActionResult,
  IncidentDetail,
  IncidentDropletLinkView,
  IncidentMemberView,
  IncidentVerdict,
} from "@/lib/types";
import { AckHistory } from "./AckHistory";
import { sourcePhrase } from "./link-evidence-copy";
import { ALERTING_KINDS } from "./LinkWhyPopover";
import { NarrativeSection, narrativeAskable } from "./NarrativeSection";
import { NoticeList } from "./NoticeList";
import { PatternFlagList } from "./PatternFlagList";
import { ReasonList } from "./ReasonList";
import { RESOLVE_COPY, ResolveDialog } from "./ResolveDialog";
import { SecurityEventRow } from "./SecurityFeed";
import { fill } from "./TimezoneSelect";
import { VERDICT_COPY, VerdictBar } from "./VerdictBar";
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
  // Act-level members can act (the box folds level ≥ act into `actionable`), so not "an owner or admin" (WARP-3185).
  cantAct: "You can't acknowledge or resolve this incident. Someone who can respond to Security events can.",
  resolve: "Resolve…",
  acknowledgedToast: "Acknowledged",
  resolvedToast: "Resolved",
  whyTitle: "Why Droplet flagged this",
  // WARP-2980: only pattern flags (trial, or kept quiet by expected activity) — nothing was flagged.
  wouldHaveTitle: "What Droplet would have flagged",
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

/** The writes this page makes; one at a time. */
type Write = "acknowledge" | "resolve" | "verdict";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A NotificationLog id (cuid): the shape route 19 accepts. */
const NOTIFICATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `?n=` as route 19 accepts it, or null — anything else would fail the box's strict body. */
export function notificationIdFrom(raw: string | null | undefined): string | null {
  return raw && NOTIFICATION_ID_RE.test(raw) ? raw : null;
}

/** The /security tab the incident page was opened from (`?from=`), validated: anything else is Incidents. */
export type BackTab = "incidents" | "everything";
export function backTabFrom(raw: string | null | undefined): BackTab {
  return raw === "everything" ? "everything" : "incidents";
}
/** Where "‹ Security" goes: back to the tab the person came from. */
export function backHref(tab: BackTab | undefined): string {
  return tab === "everything" ? "/security?tab=everything" : "/security";
}

const isNotFound = (err: unknown): boolean => {
  const e = err as { code?: unknown; status?: unknown } | undefined;
  return e?.code === "INCIDENT_NOT_FOUND" || e?.status === 404;
};
/** What a refused write said: its typed code and HTTP status, when it had them. */
interface WriteFailure {
  code?: string;
  status?: number;
}
const failureOf = (err: unknown): WriteFailure => {
  const e = err as { code?: unknown; status?: unknown } | undefined;
  return {
    code: typeof e?.code === "string" ? e.code : undefined,
    status: typeof e?.status === "number" ? e.status : undefined,
  };
};
const upperFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export interface IncidentViewProps {
  id: string;
  /** The alert notification the page was opened from, already validated (`notificationIdFrom`). */
  notificationId: string | null;
  /** The /security tab to go back to (`backTabFrom`). Incidents when absent. */
  backTab?: BackTab;
  now?: Date;
}

export function IncidentView({ id, notificationId, backTab, now: nowProp }: IncidentViewProps) {
  const valid = UUID_RE.test(id);
  const q = useSecurityIncident(valid ? id : null);
  const back = backHref(backTab);
  if (!valid) return <NotFound back={back} />;
  return <IncidentBody {...q} notificationId={notificationId} back={back} now={nowProp} />;
}

function NotFound({ back }: { back: string }) {
  return (
    <section className="card" data-testid="incident-not-found">
      <div className="empty">
        <span className="eh">{COPY.notFound}</span>
        <span style={{ maxWidth: "48ch" }}>{COPY.notFoundBody}</span>
        <Link className="btn" href={back} style={{ marginTop: 8 }}>
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
  summarise,
  keepLink,
  giveVerdict,
  notificationId,
  back,
  now: nowProp,
}: Query & { notificationId: string | null; back: string; now?: Date }) {
  const now = nowProp ?? new Date();
  const level = useModuleLevel("security");
  const { user } = useAuth();
  // The trial rule (spec §6.13, D19): owner/admin only. Unknown yet → nobody.
  const ownerOrAdmin = user?.role === "owner" || user?.role === "admin";
  const { mode } = useSecurityMode();
  // WARP-2979: the `summaries` row says whether the on-box model is Paused (a pending summary then says so).
  const { sources } = useSecurityHealth();
  const cameraLabel = useCameraDisplayNames();
  const { toast } = useToast();
  const device = deviceTimeZone();
  const timezone = mode?.displayTimezone ?? device ?? "UTC";

  const [busy, setBusy] = useState<null | Write>(null);
  // The in-flight guard itself: the buttons stay focusable (aria-disabled), so
  // a second press between renders is refused here, not by `disabled`.
  const busyRef = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [focusAfter, setFocusAfter] = useState<null | Write>(null);
  const ackRef = useRef<HTMLButtonElement | null>(null);
  const resolveRef = useRef<HTMLButtonElement | null>(null);
  const stateRef = useRef<HTMLDivElement | null>(null);
  const verdictGroupRef = useRef<HTMLDivElement | null>(null);
  const verdictAnswerRef = useRef<HTMLParagraphElement | null>(null);

  const ids = { why: useId(), what: useId(), told: useId(), acks: useId() };

  // WARP-3195 — Keep, one link at a time: the same in-flight rules as the header's buttons.
  const [keeping, setKeeping] = useState<string | null>(null);
  const keepingRef = useRef(false);
  const keepRefs = useRef(new Map<string, HTMLButtonElement>());
  const [keepFocusAfter, setKeepFocusAfter] = useState<string | null>(null);

  // After a write lands, the button that was pressed may be gone: put focus
  // where the person can carry on, never on <body>.
  useEffect(() => {
    if (!focusAfter) return;
    if (focusAfter === "verdict") {
      // The buttons stay while the box still takes an answer from this person; if they went, the answer line.
      if (!verdictGroupRef.current) (verdictAnswerRef.current ?? stateRef.current)?.focus();
    } else if (focusAfter === "acknowledge" && ackRef.current) {
      // Still there (nothing changed): focus never left it.
    } else if (resolveRef.current) {
      resolveRef.current.focus();
    } else {
      stateRef.current?.focus();
    }
    setFocusAfter(null);
  }, [focusAfter, incident]);

  // After a Keep and its re-read: its line still there (a refusal) → focus never left Keep; gone (kept, or decided
  // by someone else first) → the state line.
  useEffect(() => {
    if (!keepFocusAfter) return;
    if (!keepRefs.current.has(keepFocusAfter)) stateRef.current?.focus();
    setKeepFocusAfter(null);
  }, [keepFocusAfter, incident]);

  const run = useCallback(
    async (action: Write, write: () => Promise<IncidentActionResult>, done: string): Promise<"BUSY" | WriteFailure | null> => {
      if (busyRef.current) return "BUSY";
      busyRef.current = true;
      setBusy(action);
      try {
        const r = await write();
        // `changed:false` (already done) is silent.
        if (r.changed) toast(done, "success");
        return null;
      } catch (err) {
        // Typed copy only (409 INCIDENT_CONFLICT / NOT_ACTIONABLE / NOT_JUDGEABLE, 503
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
        return failureOf(err);
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [toast, refresh],
  );

  if (error && (isNotFound(error) || !incident)) {
    if (isNotFound(error)) return <NotFound back={back} />;
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
  // WARP-2979 — Summarise now / Regenerate: act (both levels), in any state; the box sends a summary only to a
  // viewer who can see all of it, so a partial view never gets the section at all.
  const canSummarise = levelAtLeast(level, "act") && levelAtLeast(i.viewer.level, "act");
  const summariesPaused = (sources ?? []).some((s) => s.id === "summaries" && s.state === "down" && s.detail.startsWith("Paused"));
  // WARP-3195 — Keep is route 24, a manage route: both levels, like the header's act controls. The box sends the list
  // only to a manage-level viewer who sees everything; this is the second fence, and `?? []` a box before WARP-3195.
  const canKeep = levelAtLeast(level, "manage") && levelAtLeast(i.viewer.level, "manage");
  const dropletLinks = canKeep ? (i.dropletLinks ?? []) : [];
  const badge = severityBadge(i.severity);
  const chip = stateChip(i.state, i.severity);
  const title = incidentTitle(i, cameraLabel);

  const onAcknowledge = () => {
    void run("acknowledge", () => acknowledge({ notificationId }), COPY.acknowledgedToast).then((failed) => {
      if (failed !== "BUSY") setFocusAfter("acknowledge");
    });
  };
  const onResolve = (note: string) => {
    void run("resolve", () => resolve({ note }), COPY.resolvedToast).then((failed) => {
      if (failed === "BUSY") return;
      // A note the box refused, or an outage: keep the dialog (and the note) to try again.
      // The incident moved (any 409) or isn't this person's to resolve any more
      // (any 404 — INCIDENT_NOT_FOUND, or a flat one from the feature gate when
      // Security or their level went away under the page, WARP-3185): close it;
      // the re-read shows where it stands.
      if (failed === null || failed.status === 404 || failed.status === 409) {
        setDialogOpen(false);
        setFocusAfter("resolve");
      }
    });
  };

  const onKeep = async (l: IncidentDropletLinkView) => {
    if (keepingRef.current) return;
    keepingRef.current = true;
    setKeeping(l.linkId);
    try {
      const r = await keepLink(l.linkId);
      // `changed:false` (someone kept it already) is silent, like Acknowledge's; the re-read takes the line away.
      if (r.changed) {
        const kept = ALERTING_KINDS.includes(l.zone.kind) ? INCIDENT_COPY.keptAlerts : INCIDENT_COPY.keptPlain;
        toast(fill(kept, { camera: upperFirst(sourcePhrase(l)), area: l.zone.name }), "success");
      }
    } catch (err) {
      // Typed copy only (409 LINK_NOT_DECIDABLE / LINK_CONFLICT / ZONE_ARCHIVED, 404 LINK_NOT_FOUND, 503 …) — never
      // err.message. Then re-read, before focus is placed: the link may have been decided elsewhere.
      toast(translateError(err, "security"), "error");
      await refresh();
    } finally {
      keepingRef.current = false;
      setKeeping(null);
      setKeepFocusAfter(l.linkId);
    }
  };
  const onVerdict = (verdict: IncidentVerdict) => {
    const done = verdict === "expected" ? VERDICT_COPY.savedExpected : VERDICT_COPY.savedNotExpected;
    void run("verdict", () => giveVerdict(verdict), done).then((failed) => {
      if (failed !== "BUSY") setFocusAfter("verdict");
    });
  };
  // What the box sent this viewer, less a trial flag for anyone but an owner or admin.
  const flags = i.patternFlags.filter((f) => f.effect !== "trial" || ownerOrAdmin);

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
        href={back}
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

      {(i.reasons.length > 0 || flags.length > 0 || dropletLinks.length > 0) && (
        <>
          <SectTitle id={ids.why} title={i.reasons.length > 0 || flags.length === 0 ? COPY.whyTitle : COPY.wouldHaveTitle} />
          <section className="card" aria-labelledby={ids.why}>
            <div className="rows">
              {i.reasons.length > 0 && (
                <ReasonList reasons={i.reasons} cameraLabel={cameraLabel} timezone={timezone} now={now} labelledBy={ids.why} />
              )}
              <PatternFlagList flags={flags} cameraLabel={cameraLabel} timezone={timezone} now={now} labelledBy={ids.why} />
              {dropletLinks.length > 0 && <DropletLinkList links={dropletLinks} keeping={keeping} keepRefs={keepRefs} onKeep={onKeep} />}
            </div>
          </section>
        </>
      )}

      <NarrativeSection
        narrative={i.narrative}
        grouping={i.grouping}
        canAct={canSummarise && narrativeAskable(i.lastActivityAt, now)}
        paused={summariesPaused}
        timezone={timezone}
        now={now}
        onSummarise={summarise}
        refresh={() => void refresh()}
      />

      <VerdictBar
        verdict={i.verdict}
        viewer={i.viewer}
        flags={flags}
        reasonCodes={i.reasonCodes}
        openedInMode={i.openedInMode}
        moduleLevel={level}
        busy={busy !== null}
        onVerdict={onVerdict}
        timezone={timezone}
        now={now}
        groupRef={verdictGroupRef}
        answerRef={verdictAnswerRef}
      />

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

/**
 * WARP-3195 — one row per link only Droplet made: which camera (or part of its view), the line, and Keep. The
 * button's name carries the camera (a page can hold several Keeps) after its visible word.
 */
function DropletLinkList({
  links,
  keeping,
  keepRefs,
  onKeep,
}: {
  links: readonly IncidentDropletLinkView[];
  keeping: string | null;
  keepRefs: { current: Map<string, HTMLButtonElement> };
  onKeep: (link: IncidentDropletLinkView) => Promise<void>;
}) {
  return (
    <ul className="rows" data-testid="incident-droplet-links" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {links.map((l) => {
        const camera = sourcePhrase(l);
        return (
          <li key={l.linkId} className="lrow" data-droplet-link={l.linkId}>
            <span className="ri" aria-hidden>
              <Link2 size={16} />
            </span>
            <span className="rt">
              <span className="nm" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                {upperFirst(camera)}
              </span>
              <span className="sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                {INCIDENT_COPY.dropletLinked}
              </span>
            </span>
            <button
              ref={(el) => {
                if (el) keepRefs.current.set(l.linkId, el);
                else keepRefs.current.delete(l.linkId);
              }}
              type="button"
              className="btn sm"
              aria-label={fill(INCIDENT_COPY.keepLinkNamed, { camera })}
              aria-disabled={keeping !== null || undefined}
              onClick={() => void onKeep(l)}
              style={{ flexShrink: 0 }}
            >
              {keeping === l.linkId && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {INCIDENT_COPY.keepLink}
            </button>
          </li>
        );
      })}
    </ul>
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
