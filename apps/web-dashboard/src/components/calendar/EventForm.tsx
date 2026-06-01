"use client";

import { useState, useEffect, useId } from "react";
import { X } from "lucide-react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { createEvent, updateEvent, deleteEvent } from "@/lib/hooks/useCalendar";
import { useToast } from "@/components/Toast";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PlaceCombobox } from "@/components/calendar/PlaceCombobox";

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
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const headingId = useId();

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
    setSaving(true);
    try {
      if (editing && initial) {
        await updateEvent(initial.id, {
          title,
          description: description || null,
          location: location || null,
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
          startsAt: localInputToIso(startsAt),
          endsAt: localInputToIso(endsAt),
          allDay,
        });
        toast("Event created", "success");
      }
      onSaved();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      toast(msg, "error");
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
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast(msg, "error");
      throw err;
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId} maxWidth="md">
      <div className="p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 id={headingId} className="type-title-3 text-label-primary">
            {editing ? "Edit event" : "New event"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-label-tertiary hover:text-label-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-sm p-1"
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
            <span className="type-caption-1 text-label-secondary">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={externallySynced}
              className="dp-input"
              maxLength={500}
            />
          </label>

          <label className="flex items-center gap-2 type-subheadline text-label-secondary">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              disabled={externallySynced}
            />
            All day
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="type-caption-1 text-label-secondary">Starts</span>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => handleStartChange(e.target.value)}
                disabled={externallySynced}
                className="dp-input"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="type-caption-1 text-label-secondary">Ends</span>
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                disabled={externallySynced}
                className="dp-input"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="type-caption-1 text-label-secondary">Location</span>
            {/* WARP-307: fuzzy autocomplete via the orchestrator's
                Nominatim proxy. Falls back to plain free-text entry
                whenever the proxy returns no suggestions (offline,
                rate-limited, OSM down) — the field stays usable. */}
            <PlaceCombobox
              value={location}
              onChange={setLocation}
              disabled={externallySynced}
              className="dp-input"
              maxLength={500}
              placeholder="Location"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="type-caption-1 text-label-secondary">Notes</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={externallySynced}
              className="dp-input min-h-[80px]"
              maxLength={10000}
            />
          </label>
        </div>

        <div className="mt-5 flex items-center justify-between">
          {editing && !externallySynced ? (
            <button
              onClick={handleDelete}
              disabled={saving}
              className="dp-btn-secondary text-system-red"
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving} className="dp-btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || externallySynced}
              className="dp-btn-primary"
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
