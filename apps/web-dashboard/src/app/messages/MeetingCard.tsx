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
 * information, deliberately quieter than the invite, carrying only the
 * one action that is due at that moment (Join, when there is a link).
 *
 * No entrance motion by design (the 5s poll re-renders the list —
 * replayed animations would turn ambient refresh into noise; the v1
 * MessageBubble restraint). Interactive affordances keep the surface's
 * color transitions.
 *
 * WARP-1874 — a meeting can carry a video-call link, rendered as a real
 * Join anchor. The URL is re-parsed HERE, at render, even though the
 * server already refused anything but https on the way in: a row can
 * predate the `meetingUrl` column or arrive from an ICS sync, and this
 * component is the last thing standing between a stored string and an
 * href on somebody else's screen. An unparseable value renders nothing —
 * never a dead or dangerous anchor.
 *
 * WARP-1783 — both cards used to take a `mine` prop purely to pick a tone,
 * because the caller's own bubble was a saturated accent fill that nothing
 * legible could sit on unaltered (hence the translucent-white-literal
 * branches). The bubble pair is now `--user-bubble` / `--surface`, so the
 * single `.mx-card` inset tone and the currentColor-derived `.mx-sub` read
 * correctly on both sides and the prop is gone.
 */

import { useEffect, useState } from "react";
import { Ban, CalendarClock, Check, Video, X } from "lucide-react";
import { parseMeetingLink } from "@droplet/shared-types";
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
    // UX review: "2:30 PM", never the zero-padded "02:30 PM".
    hour: "numeric",
    minute: "2-digit",
  });
}

function nameOf(participants: ParticipantRef[], userId: string): string {
  const p = participants.find((x) => x.userId === userId);
  return p?.displayName ?? p?.username ?? "A member";
}

export function MeetingCard({
  meeting,
  meId,
  participants,
  onRsvp,
  onCancel,
  busy,
}: {
  meeting: TeamChatMeeting;
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
  // Cancelled meetings offer no Join — the call was called off, and an
  // action that leads nowhere is worse than no action.
  const link = cancelled ? null : parseMeetingLink(meeting.meetingUrl);
  const isOrganizer = meeting.createdById === meId;
  const myResponse =
    meeting.rsvps.find((r) => r.userId === meId)?.response ?? null;
  // Render-time cue; the surface's 5s poll keeps it honest (UX review:
  // live RSVP pills on a meeting that already began are stale advice).
  const started = new Date(meeting.startsAt).getTime() <= Date.now();

  const whenParts = [
    formatMeetingStart(meeting.startsAt),
    meeting.durationMinutes !== null ? `${meeting.durationMinutes} min` : null,
    meeting.location,
  ].filter((x): x is string => x !== null && x.length > 0);

  return (
    <div className="mx-card is-block">
      <div className="flex items-start gap-2.5">
        <CalendarClock
          size={18}
          strokeWidth={1.5}
          className={`flex-shrink-0 mt-0.5 ${cancelled ? "mx-sub" : ""}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`mx-card-title truncate ${cancelled ? "line-through mx-sub" : ""}`}
            >
              {meeting.title}
            </span>
            {cancelled && (
              <span className="mx-card-meta mx-sub flex-shrink-0">
                Cancelled
              </span>
            )}
          </div>
          <p className="mx-card-meta mx-sub">{whenParts.join(" · ")}</p>
          <p className="mx-card-meta mx-sub">
            Organized by {nameOf(participants, meeting.createdById)}
          </p>
          {meeting.note && (
            <p className="mx-card-meta mx-sub mt-1 whitespace-pre-wrap break-words">
              {meeting.note}
            </p>
          )}

          {/* Join is the ACTION of a remote meeting, so it leads the row
              and carries the only filled treatment on the card. The host
              sits outside the anchor, quietly: a member should be able to
              see where a link somebody else pasted actually goes before
              they follow it. */}
          {link && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2">
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                title={link.url}
                className="mx-pill is-join"
              >
                <Video size={13} strokeWidth={1.5} aria-hidden="true" />
                {link.label}
              </a>
              <span className="mx-card-meta mx-sub truncate">{link.host}</span>
            </div>
          )}

          {meeting.rsvps.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
              {meeting.rsvps.map((r) => (
                <span
                  key={r.userId}
                  className="inline-flex items-center gap-1 mx-card-meta mx-sub"
                >
                  {r.response === "accepted" ? (
                    <Check size={11} aria-hidden="true" />
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

          {/* Actions — scheduled meetings only. A meeting that already
              began shows the honest cue instead of live RSVP pills. */}
          {!cancelled && !isOrganizer && started && (
            <p className="mx-card-meta mx-sub mt-1.5">Already started</p>
          )}
          {!cancelled && !isOrganizer && !started && (
            <div className="flex gap-1.5 mt-2">
              <RsvpButton
                label="Going"
                selected={myResponse === "accepted"}
                disabled={busy}
                onClick={() => onRsvp(meeting.id, "accepted")}
              />
              <RsvpButton
                label="Can't go"
                selected={myResponse === "declined"}
                disabled={busy}
                onClick={() => onRsvp(meeting.id, "declined")}
              />
            </div>
          )}
          {!cancelled && isOrganizer && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {confirmingCancel ? (
                <>
                  <span className="mx-card-meta mx-sub">
                    Cancel this meeting?
                  </span>
                  <SmallButton
                    label="Keep it"
                    disabled={busy}
                    onClick={() => setConfirmingCancel(false)}
                  />
                  <SmallButton
                    label="Yes, cancel it"
                    emphasis
                    disabled={busy}
                    onClick={() => onCancel(meeting.id)}
                  />
                </>
              ) : (
                <SmallButton
                  label="Cancel meeting"
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
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`mx-pill ${selected ? "is-on" : ""}`}
    >
      {label}
    </button>
  );
}

function SmallButton({
  label,
  emphasis = false,
  disabled,
  onClick,
}: {
  label: string;
  emphasis?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`mx-pill ${emphasis ? "is-danger" : ""}`}
    >
      {label}
    </button>
  );
}

/**
 * meeting_reminder — a quiet system-style line, not a second invite card.
 * Countdown text is computed at render; the surface's 5s poll keeps it
 * honest without any timer of its own.
 *
 * WARP-1874 — the one action it does carry is Join. The reminder fires 15
 * minutes before the start, which is exactly when the link is wanted;
 * without it here, a member has to scroll back up the thread to the invite
 * to find it. Same guard as the invite card, so a cancelled meeting offers
 * nothing to join.
 */
export function MeetingReminderCard({
  meeting,
}: {
  meeting: TeamChatMeeting | null;
}) {
  // Re-parsed at render for the same reason the invite card does it: this
  // is the last thing between a stored string and an href.
  const link =
    meeting?.status === "cancelled" ? null : parseMeetingLink(meeting?.meetingUrl);

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
    <div className="mx-card mx-sub">
      {meeting?.status === "cancelled" ? (
        <Ban size={14} strokeWidth={1.5} className="flex-shrink-0" aria-hidden="true" />
      ) : (
        <CalendarClock
          size={14}
          strokeWidth={1.5}
          className="flex-shrink-0"
          aria-hidden="true"
        />
      )}
      <span className="mx-card-meta min-w-0 flex-1">{line}</span>
      {/* No host line here, unlike the invite card. The reminder stays one
          row, and the "see where this link goes" disclosure already
          happened on the invite — plus the label itself is host-derived
          for a recognized provider, and `title` carries the full URL. */}
      {link && (
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={link.url}
          className="mx-pill is-join flex-shrink-0"
        >
          <Video size={13} strokeWidth={1.5} aria-hidden="true" />
          {link.label}
        </a>
      )}
    </div>
  );
}
