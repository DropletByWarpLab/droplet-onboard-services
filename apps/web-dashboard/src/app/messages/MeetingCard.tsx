"use client";

/**
 * WARP-1685 — meeting cards inside the conversation bubbles.
 *
 * `MeetingCard` renders a meeting_invite: title, formatted time
 * (+duration/location), organizer, RSVP summary chips, and the actions —
 * Going / Can't go for non-organizer participants (optimistic, wired by
 * ConversationPane), a two-step inline Cancel for the organizer (no
 * window.confirm — the confirm state lives in the card, dismissable by
 * "Keep it"). Cancelled meetings render struck with no actions.
 *
 * `MeetingReminderCard` renders a meeting_reminder as a subtle
 * system-style line ("Reminder: <title> starts in N min") — ambient
 * information, deliberately quieter than the invite.
 *
 * No entrance motion by design (the 5s poll re-renders the list —
 * replayed animations would turn ambient refresh into noise; the v1
 * MessageBubble restraint). Interactive affordances keep the surface's
 * 200ms ease-smooth color transitions.
 */

import { useEffect, useState } from "react";
import { Ban, CalendarClock, Check, X } from "lucide-react";
import type { TeamChatMeeting, TeamChatRsvpResponse } from "@/lib/api";

interface ParticipantRef {
  userId: string;
  displayName: string | null;
  username: string | null;
}

function formatMeetingStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function nameOf(participants: ParticipantRef[], userId: string): string {
  const p = participants.find((x) => x.userId === userId);
  return p?.displayName ?? p?.username ?? "A member";
}

export function MeetingCard({
  meeting,
  mine,
  meId,
  participants,
  onRsvp,
  onCancel,
  busy,
}: {
  meeting: TeamChatMeeting;
  /** Rendered inside the caller's own (accent) bubble? Drives card tones. */
  mine: boolean;
  meId: string;
  participants: ParticipantRef[];
  onRsvp: (meetingId: string, response: TeamChatRsvpResponse) => void;
  onCancel: (meetingId: string) => void;
  busy: boolean;
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // Re-arm safety: if the meeting flips (poll refresh) drop the armed state.
  useEffect(() => setConfirmingCancel(false), [meeting.status, meeting.id]);

  const cancelled = meeting.status === "cancelled";
  const isOrganizer = meeting.createdById === meId;
  const myResponse =
    meeting.rsvps.find((r) => r.userId === meId)?.response ?? null;

  const cardTone = mine
    ? "bg-white/10 border-white/20"
    : "bg-surface-primary border-separator";
  const subtle = mine ? "text-white/80" : "text-label-tertiary";
  const strong = mine ? "text-white" : "text-label-primary";

  const whenParts = [
    formatMeetingStart(meeting.startsAt),
    meeting.durationMinutes !== null ? `${meeting.durationMinutes} min` : null,
    meeting.location,
  ].filter((x): x is string => x !== null && x.length > 0);

  return (
    <div className={`rounded-lg border px-3 py-2.5 mb-1 ${cardTone}`}>
      <div className="flex items-start gap-2.5">
        <CalendarClock
          size={18}
          strokeWidth={1.5}
          className={`flex-shrink-0 mt-0.5 ${cancelled ? subtle : ""}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`type-footnote font-medium truncate ${cancelled ? `line-through ${subtle}` : strong}`}
            >
              {meeting.title}
            </span>
            {cancelled && (
              <span className={`type-caption-2 flex-shrink-0 ${subtle}`}>
                Cancelled
              </span>
            )}
          </div>
          <p className={`type-caption-2 ${subtle}`}>{whenParts.join(" · ")}</p>
          <p className={`type-caption-2 ${subtle}`}>
            Organized by {nameOf(participants, meeting.createdById)}
          </p>
          {meeting.note && (
            <p className={`type-caption-2 mt-1 whitespace-pre-wrap break-words ${subtle}`}>
              {meeting.note}
            </p>
          )}

          {meeting.rsvps.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
              {meeting.rsvps.map((r) => (
                <span
                  key={r.userId}
                  className={`inline-flex items-center gap-1 type-caption-2 ${subtle}`}
                >
                  {r.response === "accepted" ? (
                    <Check
                      size={11}
                      className={mine ? "text-white" : "text-system-green"}
                      aria-hidden="true"
                    />
                  ) : (
                    <X size={11} aria-hidden="true" />
                  )}
                  {nameOf(participants, r.userId)}
                  <span className="sr-only">
                    {r.response === "accepted" ? "is going" : "can't go"}
                  </span>
                </span>
              ))}
            </div>
          )}

          {/* Actions — scheduled meetings only. */}
          {!cancelled && !isOrganizer && (
            <div className="flex gap-1.5 mt-2">
              <RsvpButton
                label="Going"
                selected={myResponse === "accepted"}
                mine={mine}
                disabled={busy}
                onClick={() => onRsvp(meeting.id, "accepted")}
              />
              <RsvpButton
                label="Can't go"
                selected={myResponse === "declined"}
                mine={mine}
                disabled={busy}
                onClick={() => onRsvp(meeting.id, "declined")}
              />
            </div>
          )}
          {!cancelled && isOrganizer && (
            <div className="flex items-center gap-1.5 mt-2">
              {confirmingCancel ? (
                <>
                  <span className={`type-caption-1 ${subtle}`}>
                    Cancel this meeting?
                  </span>
                  <SmallButton
                    label="Keep it"
                    mine={mine}
                    disabled={busy}
                    onClick={() => setConfirmingCancel(false)}
                  />
                  <SmallButton
                    label="Yes, cancel it"
                    mine={mine}
                    emphasis
                    disabled={busy}
                    onClick={() => onCancel(meeting.id)}
                  />
                </>
              ) : (
                <SmallButton
                  label="Cancel meeting"
                  mine={mine}
                  disabled={busy}
                  onClick={() => setConfirmingCancel(true)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** RSVP toggle — selected state is a filled pill, announced via aria-pressed. */
function RsvpButton({
  label,
  selected,
  mine,
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  mine: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const idle = mine
    ? "border-white/30 text-white hover:bg-white/10"
    : "border-separator text-label-secondary hover:bg-surface-secondary";
  const active = mine
    ? "bg-white/20 border-white/40 text-white"
    : "bg-accent-subtle border-accent/30 text-accent";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`
        px-2.5 py-1 rounded-full border type-caption-1 font-medium
        transition-colors duration-200 ease-smooth disabled:opacity-50
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        ${selected ? active : idle}
      `}
    >
      {label}
    </button>
  );
}

function SmallButton({
  label,
  mine,
  emphasis = false,
  disabled,
  onClick,
}: {
  label: string;
  mine: boolean;
  emphasis?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const tone = emphasis
    ? mine
      ? "border-white/40 text-white bg-white/15 hover:bg-white/25"
      : "border-system-red/30 text-system-red hover:bg-system-red/10"
    : mine
      ? "border-white/30 text-white/90 hover:bg-white/10"
      : "border-separator text-label-secondary hover:bg-surface-secondary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`
        px-2.5 py-1 rounded-full border type-caption-1 font-medium
        transition-colors duration-200 ease-smooth disabled:opacity-50
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        ${tone}
      `}
    >
      {label}
    </button>
  );
}

/**
 * meeting_reminder — a quiet system-style line, not a second invite card.
 * Countdown text is computed at render; the surface's 5s poll keeps it
 * honest without any timer of its own.
 */
export function MeetingReminderCard({
  meeting,
  mine,
}: {
  meeting: TeamChatMeeting | null;
  mine: boolean;
}) {
  const subtle = mine ? "text-white/80" : "text-label-tertiary";
  const cardTone = mine
    ? "bg-white/10 border-white/20"
    : "bg-surface-primary border-separator";

  let line: string;
  if (!meeting) {
    line = "Meeting reminder";
  } else if (meeting.status === "cancelled") {
    line = `Reminder: "${meeting.title}" was cancelled`;
  } else {
    const minutes = Math.round(
      (new Date(meeting.startsAt).getTime() - Date.now()) / 60_000,
    );
    line =
      minutes > 1
        ? `Reminder: "${meeting.title}" starts in ${minutes} min`
        : minutes >= -1
          ? `Reminder: "${meeting.title}" is starting now`
          : `Reminder: "${meeting.title}" already started`;
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 mb-1 ${cardTone}`}
    >
      {meeting?.status === "cancelled" ? (
        <Ban size={14} strokeWidth={1.5} className={subtle} aria-hidden="true" />
      ) : (
        <CalendarClock
          size={14}
          strokeWidth={1.5}
          className={subtle}
          aria-hidden="true"
        />
      )}
      <span className={`type-caption-1 ${subtle}`}>{line}</span>
    </div>
  );
}
