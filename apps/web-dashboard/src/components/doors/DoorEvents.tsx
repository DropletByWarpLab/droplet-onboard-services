"use client";

/**
 * ADR-055 P4b — the doors' recent activity, newest first, cursor-paged.
 *
 * Presentational: the page wires `useDoorEvents`, this renders. Three rules:
 *
 *   1. An empty log is not "nothing happened". Events only exist once a lock or
 *      sensor has reported, so the empty state says that, and never reads as a
 *      quiet night.
 *   2. A failed read is its own state, never an empty list.
 *   3. A forced-door row says WHICH claim it makes (§9.7): a lock saw the latch
 *      still out, a sensor-only door has no latch report.
 *
 * "Show older" is aria-disabled, never `disabled`, while a page is loading:
 * the pressed button keeps focus, and a second press is refused by the guard.
 */
import type { ReactNode } from "react";
import {
  Ban,
  Bolt,
  DoorClosed,
  DoorOpen,
  KeyRound,
  Loader2,
  LockOpen,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Timer,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { deviceTimeZone } from "@/lib/security-time";
import type { DoorEventKind, DoorEventView } from "@/lib/types";
import { COPY, eventText, whenText } from "./door-copy";

/** One glyph per kind. Exhaustive: a new kind fails the type check here instead of rendering no icon. */
export function iconFor(kind: DoorEventKind): LucideIcon {
  switch (kind) {
    case "door_open":
      return DoorOpen;
    case "door_closed":
      return DoorClosed;
    case "latch_retracted":
    case "latch_extended":
    case "bolt_thrown":
    case "bolt_withdrawn":
      return Bolt;
    case "rex":
      return LogOut;
    case "key_override":
      return KeyRound;
    case "unlock_granted":
      return LockOpen;
    case "unlock_denied":
      return Ban;
    case "forced_door":
      return ShieldAlert;
    case "held_open":
      return Timer;
    case "tamper":
      return TriangleAlert;
    case "trouble":
      return WifiOff;
    default: {
      const unhandled: never = kind;
      void unhandled;
      return TriangleAlert;
    }
  }
}

export interface DoorEventsProps {
  events: DoorEventView[];
  isLoading: boolean;
  error?: Error;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  now?: Date;
  /** The browser's own zone unless a test says otherwise. */
  timeZone?: string;
}

function Empty({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="ei">{icon}</span>
      <span className="eh">{title}</span>
      <span style={{ maxWidth: "48ch" }}>{body}</span>
      {children}
    </div>
  );
}

export function DoorEvents(props: DoorEventsProps) {
  const now = props.now ?? new Date();
  const timeZone = props.timeZone ?? deviceTimeZone() ?? "UTC";

  return (
    <section className="card" aria-labelledby="door-events-title" data-testid="door-events">
      <div className="card-h">
        <span className="ci">
          <DoorOpen size={16} aria-hidden />
        </span>
        <h2 className="ct" id="door-events-title" style={{ margin: 0 }}>
          {COPY.activityTitle}
        </h2>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-muted)" }}>{COPY.activitySub}</p>
      <Body {...props} now={now} timeZone={timeZone} />
    </section>
  );
}

function Body(props: DoorEventsProps & { now: Date; timeZone: string }) {
  if (props.error && props.events.length === 0) {
    return (
      <div role="alert">
        <Empty icon={<TriangleAlert size={24} aria-hidden />} title={COPY.eventsFailedTitle} body={COPY.eventsFailedBody}>
          <button type="button" className="btn" onClick={props.onRetry} style={{ marginTop: 8 }}>
            <RefreshCw size={16} aria-hidden />
            {COPY.retryLabel}
          </button>
        </Empty>
      </div>
    );
  }
  if (props.isLoading) {
    return (
      <div className="empty" aria-busy="true">
        <Loader2 size={20} className="animate-spin" aria-hidden />
        <span className="sr-only">Loading</span>
      </div>
    );
  }
  if (props.events.length === 0) {
    return <Empty icon={<DoorOpen size={24} aria-hidden />} title={COPY.emptyEventsTitle} body={COPY.emptyEventsBody} />;
  }
  return (
    <>
      <ul className="rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {props.events.map((e) => (
          <DoorEventRow key={e.id} event={e} now={props.now} timeZone={props.timeZone} />
        ))}
      </ul>
      {props.hasMore && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <button
            type="button"
            className="btn"
            aria-disabled={props.isLoadingMore || undefined}
            onClick={() => {
              if (!props.isLoadingMore) props.onLoadMore();
            }}
          >
            {props.isLoadingMore ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
            {COPY.moreEvents}
          </button>
        </div>
      )}
    </>
  );
}

function DoorEventRow({ event: e, now, timeZone }: { event: DoorEventView; now: Date; timeZone: string }) {
  const Icon = iconFor(e.kind);
  const { label, note } = eventText(e);
  // A forced-door or left-open row is the one a person should not miss: the
  // brand tint marks it, and the words say what it is, so colour is never the only cue.
  const notable = e.kind === "forced_door" || e.kind === "held_open" || e.kind === "tamper" || e.kind === "trouble";
  return (
    <li className="lrow" data-kind={e.kind} data-event-id={e.id}>
      <span className={`ri${notable ? " brand" : ""}`} aria-hidden>
        <Icon size={16} />
      </span>
      <span className="rt">
        {/* The shell's row title is one ellipsised line; a door's name is the
            part that must never be cut off (it can be 80 characters). */}
        <span className="nm" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {e.doorName}
        </span>
        <span className="sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {label}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
      <time className="rmeta mono" dateTime={e.occurredAt} title={new Date(e.occurredAt).toLocaleString()}>
        {whenText(e.occurredAt, now, timeZone)}
      </time>
    </li>
  );
}
