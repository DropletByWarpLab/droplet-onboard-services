"use client";

/**
 * WARP-1685 — "Meeting" composer action: schedule a meeting with this
 * thread's participants. Title + local date-time (client-validated to the
 * future — the server refuses past starts anyway), an optional length,
 * location, and note. Participants are implicit: everyone in the thread
 * gets the invite card and can RSVP from it.
 *
 * WARP-1874 — a video call link sits ALONGSIDE the physical location,
 * behind an explicit "Add video call link" control (the Google Calendar /
 * Outlook idiom). Two reasons it isn't just typed into Location:
 *   - a meeting can be both in the living room and on a call, and the old
 *     single field forced a choice;
 *   - the link becomes a clickable href on other members' screens, and
 *     deciding "is this location text really a link" by sniffing it is the
 *     kind of guessing that produces the wrong answer on the day it
 *     matters. The field is explicit, and so is the column behind it.
 *
 * The scheme check here is a courtesy — it puts the error next to the
 * field at paste time. The server enforces the same rule and is what
 * actually protects the render.
 */

import { useRef, useState } from "react";
import { Video } from "lucide-react";
import { parseMeetingLink } from "@droplet/shared-types";
import { Dialog } from "@/components/Dialog";
import { createTeamChatMeeting } from "@/lib/api";

const DURATIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "No set length" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "45", label: "45 minutes" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
  { value: "120", label: "2 hours" },
];

/** Date → the local-time string a datetime-local input takes. */
function toLocalInputValue(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

export function MeetingDialog({
  open,
  onClose,
  threadId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  threadId: string;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [duration, setDuration] = useState("");
  const [location, setLocation] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  // Explicit disclosure state, not `meetingUrl !== ""` — the organizer can
  // legitimately have the field open and empty while they go find the link.
  const [showMeetingUrl, setShowMeetingUrl] = useState(false);
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meetingUrlRef = useRef<HTMLInputElement | null>(null);

  const trimmedUrl = meetingUrl.trim();
  const link = parseMeetingLink(trimmedUrl);

  function reset() {
    setTitle("");
    setStart("");
    setDuration("");
    setLocation("");
    setMeetingUrl("");
    setShowMeetingUrl(false);
    setNote("");
    setError(null);
  }

  function addMeetingUrl() {
    setShowMeetingUrl(true);
    // Focus follows the disclosure — a revealed field the user then has to
    // go and click is a half-finished control.
    requestAnimationFrame(() => meetingUrlRef.current?.focus());
  }

  function removeMeetingUrl() {
    setMeetingUrl("");
    setShowMeetingUrl(false);
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  const canSubmit = title.trim().length > 0 && start.length > 0 && !creating;

  async function create() {
    if (!canSubmit) return;
    const startsAt = new Date(start);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
      setError("Pick a start time in the future.");
      return;
    }
    if (trimmedUrl.length > 0 && !link) {
      setError(
        "Video call links need to start with https:// — paste the full link from Zoom, Teams, Meet or Webex.",
      );
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createTeamChatMeeting(threadId, {
        title: title.trim(),
        startsAt: startsAt.toISOString(),
        ...(duration !== "" ? { durationMinutes: Number(duration) } : {}),
        ...(location.trim().length > 0 ? { location: location.trim() } : {}),
        // Send the parser's normalized href, so the string the organizer
        // was shown as valid is the string that gets stored.
        ...(link ? { meetingUrl: link.url } : {}),
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      });
      reset();
      onCreated();
    } catch (err) {
      // api.ts throws plain user copy (detail already console-logged there).
      setError(
        err instanceof Error ? err.message : "Couldn't schedule the meeting. Try again.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} labelledBy="meeting-dialog-title">
      {/* A real form so Enter in Title/Starts submits (keyboard parity —
          UX review); Enter in the note textarea still inserts a newline. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2 id="meeting-dialog-title" className="mx-dlg-title">
          Schedule a meeting
        </h2>
        <p className="mx-dlg-sub">
          Everyone in this conversation gets the invite and can answer from it.
        </p>

        <label className="block mt-3">
          <span className="mx-label">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="What's it about?"
            className="mx-field"
          />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <label className="block">
            <span className="mx-label">Starts</span>
            <input
              type="datetime-local"
              value={start}
              min={toLocalInputValue(new Date())}
              onChange={(e) => setStart(e.target.value)}
              className="mx-field"
            />
          </label>
          <label className="block">
            <span className="mx-label">Length</span>
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="mx-field"
            >
              {DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block mt-3">
          <span className="mx-label">
            Location <span className="opt">(optional)</span>
          </span>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={200}
            placeholder="Kitchen, office, a call…"
            className="mx-field"
          />
        </label>

        {/* Video call link — disclosed on request so the common case (a
            room in the house) stays a single field. No height/fade
            transition on the reveal: this surface's restraint is
            deliberate, and animating a form field the user just asked for
            delays the thing they asked for. */}
        {showMeetingUrl ? (
          <div className="mt-3">
            <label className="block">
              {/* No "(optional)" here — the whole section is already
                  behind an opt-in control; repeating it is noise. */}
              <span className="mx-label">Video call link</span>
              <input
                ref={meetingUrlRef}
                type="url"
                inputMode="url"
                value={meetingUrl}
                onChange={(e) => setMeetingUrl(e.target.value)}
                maxLength={2048}
                placeholder="https://…"
                aria-describedby="meeting-url-hint"
                className="mx-field"
              />
            </label>
            <p id="meeting-url-hint" className="mx-hint">
              {link
                ? // Name what was recognized back to the organizer — an
                  // unrecognized host shows as the host itself rather than
                  // a made-up service name.
                  link.providerName
                  ? `${link.providerName} link`
                  : link.host
                : "Paste the invite link from Zoom, Teams, Meet or Webex."}
            </p>
            <button
              type="button"
              onClick={removeMeetingUrl}
              className="mx-pill mt-2"
            >
              Remove video call link
            </button>
          </div>
        ) : (
          <button type="button" onClick={addMeetingUrl} className="mx-pill mt-3">
            <Video size={13} strokeWidth={1.5} aria-hidden="true" />
            Add video call link
          </button>
        )}

        <label className="block mt-3">
          <span className="mx-label">
            Note <span className="opt">(optional)</span>
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Anything people should bring or know."
            className="mx-field"
          />
        </label>

        {error && (
          <p role="alert" className="mx-error mt-2">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={close} className="btn">
            Cancel
          </button>
          <button type="submit" disabled={!canSubmit} className="btn primary">
            {creating ? "Scheduling…" : "Schedule meeting"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
