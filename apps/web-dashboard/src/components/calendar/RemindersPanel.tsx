"use client";

import { useState } from "react";
import { Bell, Check, Plus, Trash2, X } from "lucide-react";
import { useReminders, createReminder, patchReminder, deleteReminder } from "@/lib/hooks/useReminders";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DateTimePicker } from "@/components/calendar/DateTimePicker";

function formatRel(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const diffMs = t - now;
  const past = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60000);
  if (minutes < 1) return past ? "just now" : "in <1m";
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return past ? `${days}d ago` : `in ${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RemindersPanel() {
  const { reminders, refresh, isLoading } = useReminders();
  const { toast } = useToast();
  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDueAt, setNewDueAt] = useState("");
  // WARP-291: confirm deletion. The audit flagged the bare click-to-
  // delete on a `group-hover` icon as too easy to fire by accident.
  // WARP-292: hold the full reminder so the ConfirmDialog can identify
  // it by title, not just by id.
  const [removeTarget, setRemoveTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);

  async function handleCreate() {
    if (!newTitle.trim() || !newDueAt) return;
    try {
      await createReminder({ title: newTitle, dueAt: new Date(newDueAt).toISOString() });
      setNewTitle("");
      setNewDueAt("");
      setShowNew(false);
      refresh();
    } catch (err) {
      // WARP-294: friendly translation; never raw err.message.
      toast(translateError(err, "calendar"), "error");
    }
  }

  async function toggle(id: string, completed: boolean) {
    try {
      await patchReminder(id, { completed });
      refresh();
    } catch (err) {
      // WARP-294: friendly translation; never raw err.message.
      toast(translateError(err, "calendar"), "error");
    }
  }

async function performRemove() {
    const target = removeTarget;
    if (!target) return;
    try {
      await deleteReminder(target.id);
      setRemoveTarget(null);
      refresh();
    } catch (err) {
      // WARP-294: friendly translation; never raw err.message.
      toast(translateError(err, "calendar"), "error");
      throw err;
    }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bell size={16} style={{ color: "var(--text-muted)" }} />
          <h2 className="type-headline" style={{ color: "var(--text)" }}>Reminders</h2>
        </div>
        <button
          onClick={() => setShowNew((v) => !v)}
          className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] max-lg:inline-flex max-lg:items-center max-lg:justify-center max-lg:h-11 max-lg:w-11"
          title={showNew ? "Cancel" : "New reminder"}
        >
          {showNew ? <X size={16} /> : <Plus size={16} />}
        </button>
      </div>

      {showNew && (
        <div className="mb-3 flex flex-col gap-2 p-2 rounded" style={{ background: "var(--inset)" }}>
          <input
            type="text"
            placeholder="Reminder title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="text-sm outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)]"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
              padding: "8px 10px",
            }}
            maxLength={500}
          />
          {/* Calendar UX clarity (Samantha QA #bugs): date + 15-minute time
              dropdown for the due time. Same YYYY-MM-DDTHH:mm local-input
              contract — handleCreate still does new Date(newDueAt).toISOString(). */}
          <DateTimePicker
            label="Due"
            value={newDueAt}
            onChange={setNewDueAt}
          />
          {/* The Create button is gated on BOTH a title and a due time; without
              this hint the disabled state reads as "broken" (the QA report). */}
          <p className="type-caption-2" style={{ color: "var(--text-muted)" }}>
            Add a title and a due time to create a reminder.
          </p>
          <button onClick={handleCreate} disabled={!newTitle.trim() || !newDueAt} className="btn primary text-sm">
            Create
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="type-caption-1" style={{ color: "var(--text-muted)" }}>Loading…</div>
      ) : reminders.length === 0 ? (
        <div className="type-caption-1 py-2" style={{ color: "var(--text-muted)" }}>No active reminders.</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {reminders.map((r) => {
            const completed = r.completedAt !== null;
            // aria-label mirrors the visible title; fall back to the
            // stable id when the title is empty so the action is still
            // discoverable to screen readers (WARP-292).
            const label = r.title?.trim() ? r.title : r.id;
            return (
              <li key={r.id} className="lrow group">
                {/*
                  WARP-301: bumped to a p-2.5 hit-target wrapper (≥ 32 px)
                  so the checkbox is reliably tappable on touch. The
                  rendered 16 px (w-4 h-4) check itself stays the same
                  visual size — only the surrounding tap area grew.
                */}
                <button
                  onClick={() => toggle(r.id, !completed)}
                  className="p-2.5 -m-1.5 rounded-sm hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  aria-label={completed ? `Mark ${label} as not done` : `Mark ${label} as done`}
                >
                  <span
                    className={`block w-4 h-4 rounded border flex items-center justify-center ${
                      completed
                        ? "bg-system-green border-system-green text-white"
                        : "border-[color:var(--card-bd)]"
                    }`}
                  >
                    {completed && <Check size={10} />}
                  </span>
                </button>
                <div className="rt">
                  <span
                    className={`nm truncate ${completed ? "line-through" : ""}`}
                    style={completed ? { color: "var(--text-muted)" } : undefined}
                  >
                    {r.title}
                  </span>
                  <span className="sub">{formatRel(r.dueAt)}</span>
                </div>
                {/*
                  Always rendered (no opacity-gate) so touch + keyboard
                  users can discover the action. p-2.5 → 12 px icon +
                  20 px padding = 32 px hit-target, meeting the ui-ux
                  floor. WARP-292 site-wide migration of the WARP-220
                  pattern.
                */}
                <button
                  onClick={() => setRemoveTarget({ id: r.id, title: r.title ?? "" })}
                  aria-label={`Delete reminder ${label}`}
                  className="p-2.5 rounded-sm text-[color:var(--text-muted)] hover:text-[color:var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onConfirm={performRemove}
        onCancel={() => setRemoveTarget(null)}
        title="Delete reminder?"
        // WARP-292 fold-in: route the reminder identifier through the
        // ConfirmDialog `confirmedIdentifier` prop instead of
        // interpolating it into the title. This (a) dodges escape
        // hazards for titles containing `"`, and (b) renders the
        // identifier in the consistent monospace-token style every
        // other migrated confirm uses. Fall back to the id when the
        // title is empty so the user still has a verification handle.
        confirmedIdentifier={
          removeTarget
            ? removeTarget.title.trim() || removeTarget.id
            : undefined
        }
        description="The reminder is removed from your list. If a notification was queued, it won't fire."
        confirmLabel="Delete"
        variant="destructive"
      />
    </div>
  );
}
