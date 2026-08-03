"use client";

/**
 * WARP-1685 — "Meeting" composer action: schedule a meeting with this
 * thread's participants. Title + local date-time (client-validated to the
 * future — the server refuses past starts anyway), an optional length,
 * location, and note. Participants are implicit: everyone in the thread
 * gets the invite card and can RSVP from it.
 */

import { useState } from "react";
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
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle("");
    setStart("");
    setDuration("");
    setLocation("");
    setNote("");
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
    setCreating(true);
    setError(null);
    try {
      await createTeamChatMeeting(threadId, {
        title: title.trim(),
        startsAt: startsAt.toISOString(),
        ...(duration !== "" ? { durationMinutes: Number(duration) } : {}),
        ...(location.trim().length > 0 ? { location: location.trim() } : {}),
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
      <div>
        <h2 id="meeting-dialog-title" className="type-headline text-label-primary">
          Schedule a meeting
        </h2>
        <p className="mt-0.5 type-footnote text-label-tertiary">
          Everyone in this conversation gets the invite and can answer from it.
        </p>

        <label className="block mt-3">
          <span className="type-caption-1 text-label-secondary">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="What's it about?"
            className="dp-input w-full mt-1"
          />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <label className="block">
            <span className="type-caption-1 text-label-secondary">Starts</span>
            <input
              type="datetime-local"
              value={start}
              min={toLocalInputValue(new Date())}
              onChange={(e) => setStart(e.target.value)}
              className="dp-input w-full mt-1"
            />
          </label>
          <label className="block">
            <span className="type-caption-1 text-label-secondary">Length</span>
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="dp-input w-full mt-1"
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
          <span className="type-caption-1 text-label-secondary">
            Location <span className="text-label-tertiary">(optional)</span>
          </span>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={200}
            placeholder="Kitchen, office, a call…"
            className="dp-input w-full mt-1"
          />
        </label>

        <label className="block mt-3">
          <span className="type-caption-1 text-label-secondary">
            Note <span className="text-label-tertiary">(optional)</span>
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            placeholder="Anything people should bring or know."
            className="dp-input w-full mt-1 resize-none"
          />
        </label>

        {error && (
          <p role="alert" className="mt-2 type-caption-1 text-system-red">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={close} className="dp-btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={!canSubmit}
            className="dp-btn-primary disabled:opacity-50"
          >
            {creating ? "Scheduling…" : "Schedule meeting"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
