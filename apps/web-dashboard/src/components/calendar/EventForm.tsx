"use client";

import { useState, useEffect, useId, useRef } from "react";
import { Video, X } from "lucide-react";
import { parseMeetingLink } from "@droplet/shared-types";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { createEvent, updateEvent, deleteEvent } from "@/lib/hooks/useCalendar";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PlaceCombobox } from "@/components/calendar/PlaceCombobox";
import { DateTimePicker } from "@/components/calendar/DateTimePicker";

interface Props {
  open: boolean;
  initial?: CalendarEvent | null;
  /** For a NEW event, pre-seed the start day (e.g. the calendar day the user
   *  clicked). Ignored when `initial` is set (editing an existing event). */
  initialDate?: Date;
  onClose: () => void;
  onSaved: () => void;
}

/** datetime-local input wants `YYYY-MM-DDTHH:mm` in *local* time (no TZ
 *  suffix). We store everything as UTC ISO on the backend; convert in/out at
 *  the form boundary. */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(local: string): string {
  return new Date(local).toISOString();
}

export function EventForm({ open, initial, initialDate, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const editing = initial != null;
  const externallySynced = editing && initial?.source === "external";

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  // WARP-1874 — a video call link ALONGSIDE the physical location, behind
  // an explicit control (the Google Calendar / Outlook idiom). Disclosure
  // is its own state, not `meetingUrl !== ""`: the field can legitimately
  // be open and empty while the user goes to find the link.
  const [meetingUrl, setMeetingUrl] = useState("");
  const [showMeetingUrl, setShowMeetingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const meetingUrlRef = useRef<HTMLInputElement | null>(null);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const headingId = useId();
  const meetingUrlId = useId();
  const meetingUrlErrorId = useId();

  const trimmedUrl = meetingUrl.trim();
  const link = parseMeetingLink(trimmedUrl);

  function addMeetingUrl() {
    setShowMeetingUrl(true);
    // Focus follows the disclosure — a revealed field the user then has to
    // hunt for is a half-finished control.
    requestAnimationFrame(() => meetingUrlRef.current?.focus());
  }

  function removeMeetingUrl() {
    setMeetingUrl("");
    setShowMeetingUrl(false);
    setUrlError(null);
  }

  /**
   * WARP-306: when the user moves the start time, slide the end time by the
   * same delta so the event's duration is preserved. The previous behavior
   * left the end pinned, which meant a quick "push this meeting an hour
   * later" became a two-field operation (and silently created start>end
   * validation errors when the user forgot the second edit).
   *
   * Editing the end field directly is not overridden — `setEndsAt` is still
   * the bare setter on that input, so a user explicitly stretching or
   * shortening the duration keeps full control.
   */
  function handleStartChange(nextStart: string) {
    const prevStartMs = new Date(startsAt).getTime();
    const prevEndMs = new Date(endsAt).getTime();
    const nextStartMs = new Date(nextStart).getTime();
    // Only slide when every input parses cleanly AND the previous duration
    // was non-negative; otherwise leave end alone so the validation toast
    // at save time still fires for genuinely broken states.
    if (
      Number.isFinite(prevStartMs) &&
      Number.isFinite(prevEndMs) &&
      Number.isFinite(nextStartMs) &&
      prevEndMs >= prevStartMs
    ) {
      const durationMs = prevEndMs - prevStartMs;
      const nextEnd = new Date(nextStartMs + durationMs);
      setEndsAt(isoToLocalInput(nextEnd.toISOString()));
    }
    setStartsAt(nextStart);
  }

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setTitle(initial.title);
      setDescription(initial.description ?? "");
      setLocation(initial.location ?? "");
      setMeetingUrl(initial.meetingUrl ?? "");
      setShowMeetingUrl(Boolean(initial.meetingUrl));
      setUrlError(null);
      setStartsAt(isoToLocalInput(initial.startsAt));
      setEndsAt(isoToLocalInput(initial.endsAt));
      setAllDay(initial.allDay);
    } else {
      // New event. If a day was clicked (initialDate), start at 9am on that
      // day so the date is pre-filled; otherwise default to now. End +1h.
      const base = initialDate
        ? new Date(initialDate.getFullYear(), initialDate.getMonth(), initialDate.getDate(), 9, 0)
        : new Date();
      const end = new Date(base.getTime() + 60 * 60 * 1000);
      setTitle("");
      setDescription("");
      setLocation("");
      setMeetingUrl("");
      setShowMeetingUrl(false);
      setUrlError(null);
      setStartsAt(isoToLocalInput(base.toISOString()));
      setEndsAt(isoToLocalInput(end.toISOString()));
      setAllDay(false);
    }
  }, [open, initial, initialDate]);

  // No early return — pass `open` through to <Dialog>, which handles
  // mount/unmount via its AnimatePresence wrapper.

  async function handleSave() {
    if (!title.trim()) {
      toast("Title is required", "error");
      return;
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      toast("End must be after start", "error");
      return;
    }
    // A format error belongs next to the field it names — a toast that
    // fades cannot be re-read while the user is fixing the URL. The server
    // enforces the same rule; this is only the earlier, closer telling.
    if (trimmedUrl.length > 0 && !link) {
      setUrlError(
        "Video call links need to start with https:// — paste the full link from Zoom, Teams, Meet or Webex.",
      );
      meetingUrlRef.current?.focus();
      return;
    }
    setUrlError(null);
    setSaving(true);
    try {
      if (editing && initial) {
        await updateEvent(initial.id, {
          title,
          description: description || null,
          location: location || null,
          // Explicit null, not undefined — undefined means "leave it
          // alone" to the PATCH route, which would make the link
          // unremovable.
          meetingUrl: link ? link.url : null,
          startsAt: localInputToIso(startsAt),
          endsAt: localInputToIso(endsAt),
          allDay,
        });
        toast("Event updated", "success");
      } else {
        await createEvent({
          title,
          description: description || undefined,
          location: location || undefined,
          ...(link ? { meetingUrl: link.url } : {}),
          startsAt: localInputToIso(startsAt),
          endsAt: localInputToIso(endsAt),
          allDay,
        });
        toast("Event created", "success");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast(translateError(err, "calendar"), "error");
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    if (!editing || !initial) return;
    setConfirmingDelete(true);
  }

  async function performDelete() {
    if (!initial) return;
    setSaving(true);
    try {
      await deleteEvent(initial.id);
      toast("Event deleted", "success");
      setConfirmingDelete(false);
      onSaved();
      onClose();
    } catch (err) {
      toast(translateError(err, "calendar"), "error");
      throw err;
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId} maxWidth="md">
      {/* Body padding + scroll come from the <Dialog> primitive (WARP-1153). */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 id={headingId} className="type-title-3" style={{ color: "var(--text)" }}>
            {editing ? "Edit event" : "New event"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm p-1"
          >
            <X size={18} />
          </button>
        </div>

        {externallySynced && (
          <div className="mb-3 p-2 rounded type-caption-1 bg-system-orange/10 text-system-orange">
            This event is synced from an external calendar and can't be edited
            here. Make changes in the source calendar and they'll sync back.
          </div>
        )}

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={externallySynced}
              className="outline-none focus:border-[var(--brand)]"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
                padding: "8px 12px",
              }}
              maxLength={500}
            />
          </label>

          <label className="flex items-center gap-2 type-subheadline" style={{ color: "var(--text-muted)" }}>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              disabled={externallySynced}
            />
            All day
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>Starts</span>
              {/* Calendar UX clarity (Samantha QA #bugs): date + 15-minute time
                  dropdown. Same YYYY-MM-DDTHH:mm local-input contract as the
                  former datetime-local, so handleStartChange's duration-slide
                  and localInputToIso keep working unchanged. */}
              <DateTimePicker
                label="Starts"
                value={startsAt}
                onChange={handleStartChange}
                disabled={externallySynced}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>Ends</span>
              <DateTimePicker
                label="Ends"
                value={endsAt}
                onChange={setEndsAt}
                disabled={externallySynced}
              />
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>Location</span>
            {/* WARP-307: fuzzy autocomplete via the orchestrator's
                Nominatim proxy. Falls back to plain free-text entry
                whenever the proxy returns no suggestions (offline,
                rate-limited, OSM down) — the field stays usable. */}
            <PlaceCombobox
              value={location}
              onChange={setLocation}
              disabled={externallySynced}
              className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-input)] text-[color:var(--text)] outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)] px-3 py-2"
              maxLength={500}
              placeholder="Location"
            />
          </label>

          {/* Disclosed on request so the common case — a place in the
              house — stays one field. No reveal animation: the motion
              budget belongs to state that changes on its own, not to
              delaying a field the user just asked for. */}
          {showMeetingUrl ? (
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1">
                <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                  Video call link
                </span>
                <input
                  ref={meetingUrlRef}
                  id={meetingUrlId}
                  type="url"
                  inputMode="url"
                  value={meetingUrl}
                  onChange={(e) => {
                    setMeetingUrl(e.target.value);
                    setUrlError(null);
                  }}
                  disabled={externallySynced}
                  placeholder="https://…"
                  maxLength={2048}
                  aria-invalid={urlError ? true : undefined}
                  aria-describedby={urlError ? meetingUrlErrorId : undefined}
                  className="outline-none focus:border-[var(--brand)]"
                  style={{
                    background: "var(--surface)",
                    border: `1px solid ${urlError ? "var(--danger)" : "var(--border)"}`,
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                    padding: "8px 12px",
                  }}
                />
              </label>
              {urlError ? (
                <p
                  id={meetingUrlErrorId}
                  role="alert"
                  className="type-caption-1"
                  style={{ color: "var(--danger)" }}
                >
                  {urlError}
                </p>
              ) : (
                <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                  {link
                    ? link.providerName
                      ? `${link.providerName} link`
                      : link.host
                    : "Paste the invite link from Zoom, Teams, Meet or Webex."}
                </p>
              )}
              {!externallySynced && (
                <button
                  type="button"
                  onClick={removeMeetingUrl}
                  className="btn ghost self-start"
                >
                  Remove video call link
                </button>
              )}
            </div>
          ) : (
            !externallySynced && (
              <button
                type="button"
                onClick={addMeetingUrl}
                className="btn ghost self-start inline-flex items-center gap-1.5"
              >
                <Video size={14} strokeWidth={1.5} aria-hidden="true" />
                Add video call link
              </button>
            )
          )}

          <label className="flex flex-col gap-1">
            <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>Notes</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={externallySynced}
              className="min-h-[80px] outline-none focus:border-[var(--brand)]"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
                padding: "8px 12px",
              }}
              maxLength={10000}
            />
          </label>
        </div>

        <div className="mt-5 flex items-center justify-between">
          {editing && !externallySynced ? (
            <button
              onClick={handleDelete}
              disabled={saving}
              className="btn ghost"
              style={{ color: "var(--danger)" }}
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving} className="btn ghost">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || externallySynced}
              className="btn primary"
            >
              {saving ? "Saving…" : editing ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onConfirm={performDelete}
        onCancel={() => setConfirmingDelete(false)}
        title={initial ? `Delete "${initial.title}"?` : "Delete event?"}
        description="This event is removed from your calendar. Anyone you invited won't see it anymore. This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
      />
    </Dialog>
  );
}
