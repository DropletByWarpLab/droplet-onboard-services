"use client";
import { useState } from "react";
import type { Schedule } from "@/lib/types";
import { useNetworkDevices } from "@/lib/hooks/useNetworkDevices";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { useScheduleMutations } from "@/lib/hooks/useScheduleMutations";
import { isWindowActive, formatWindow } from "@/lib/scheduleEval";

interface Props {
  schedule: Schedule;
  onEdit: () => void;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = then - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  const sign = diffMs < 0 ? "ago" : "from now";
  if (absSec < 60) return `${Math.round(absSec)}s ${sign}`;
  if (absSec < 3600) return `${Math.round(absSec / 60)}m ${sign}`;
  if (absSec < 86400) return `${Math.round(absSec / 3600)}h ${sign}`;
  return `${Math.round(absSec / 86400)}d ${sign}`;
}

export function ScheduleRow({ schedule, onEdit }: Props) {
  const { toggleSchedule, deleteSchedule, updateSchedule } = useScheduleMutations();
  const devicesSwr = useNetworkDevices();
  const groupsSwr = useNetworkGroups();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(schedule.name);
  const [toggleBusy, setToggleBusy] = useState(false);

  // Resolve subject → human label.
  let subjectLabel = "Unknown";
  let subjectKind = schedule.subjectType === "group" ? "group" : "device";
  if (schedule.subjectType === "group" && schedule.groupId) {
    const g = groupsSwr.data?.groups.find((x) => x.id === schedule.groupId);
    if (g) subjectLabel = g.name;
  } else if (schedule.subjectType === "device" && schedule.deviceMac) {
    const d = devicesSwr.data?.devices.find(
      (x) => x.mac.toLowerCase() === schedule.deviceMac!.toLowerCase(),
    );
    if (d) subjectLabel = d.displayName ?? d.hostname ?? d.mac;
  }

  const activeNow = schedule.windows.some((w) => isWindowActive(w, new Date()));

  async function handleToggle() {
    if (toggleBusy) return;
    setToggleBusy(true);
    try {
      await toggleSchedule(schedule.id, !schedule.enabled);
    } catch {
      // Errors surface through SWR revalidation; nothing to roll back locally.
    } finally {
      setToggleBusy(false);
    }
  }

  async function commitName() {
    const next = draftName.trim();
    setEditingName(false);
    if (next && next !== schedule.name) {
      try {
        await updateSchedule(schedule.id, { name: next });
      } catch {
        // Revert optimistic UI via SWR refresh; nothing extra needed here.
      }
    } else {
      setDraftName(schedule.name);
    }
  }

  async function handleDelete() {
    try {
      await deleteSchedule(schedule.id);
    } catch {
      // Keep the row; SWR will reconcile.
    } finally {
      setConfirmDelete(false);
    }
  }

  return (
    // WARP-100: stable anchor so the cross-tab jump from DeviceDetailPanel
    // (router.push('/network?tab=schedules#schedule-<id>')) can scroll this
    // row into view once the Schedules tab mounts. scroll-mt-20 (80px) keeps
    // the row clear of the 56px sticky page top bar when scrolled to the top.
    <li id={`schedule-${schedule.id}`} className="card scroll-mt-20">
      <div className="flex items-start gap-3">
        {/* Enabled toggle. `.sw` / `.ball` are the shell's toggle primitive —
            same button + span structure as before, so this stays a class swap.
            The knob colour comes from `--on-brand` (WARP-1358 contrast), which
            is why the old hardcoded `bg-white` goes away. */}
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label={`Toggle ${schedule.name}`}
          onClick={handleToggle}
          disabled={toggleBusy}
          className={`mt-1 sw${schedule.enabled ? " on" : ""}`}
        >
          <span className="ball" aria-hidden="true" />
        </button>

        <div className="flex-1 min-w-0">
          {/* Name (inline edit on click) */}
          <div className="flex items-center gap-2">
            {editingName ? (
              <input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName();
                  if (e.key === "Escape") {
                    setEditingName(false);
                    setDraftName(schedule.name);
                  }
                }}
                autoFocus
                aria-label="Schedule name"
                className="type-headline w-full px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[color:var(--text)] placeholder:text-[color:var(--text-muted)] focus:border-[var(--brand)]"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="type-headline text-[color:var(--text)] text-left hover:text-[color:var(--brand)]"
              >
                {schedule.name}
              </button>
            )}
            {activeNow && (
              <span
                aria-label="Active now"
                title="Active now"
                className="inline-block w-2 h-2 rounded-full bg-system-green"
              />
            )}
          </div>

          {/* Subject badge */}
          <div className="mt-1">
            <span className="inline-flex items-center gap-1 type-caption-1 px-2 py-0.5 rounded bg-[var(--card-inner)] text-[color:var(--text-muted)]">
              {subjectLabel} ({subjectKind})
            </span>
          </div>

          {/* Windows summary */}
          <p className="mt-2 type-subheadline text-[color:var(--text-muted)]">
            {schedule.windows.length > 0
              ? schedule.windows.map((w) => formatWindow(w)).join(" · ")
              : "No windows"}
          </p>

          {/* Transition meta */}
          {(schedule.nextTransitionAt || schedule.lastFiredAt) && (
            <p className="mt-1 type-caption-2 text-[color:var(--text-muted)]">
              {schedule.nextTransitionAt && (
                <>next transition {formatRelativeTime(schedule.nextTransitionAt)}</>
              )}
              {schedule.nextTransitionAt && schedule.lastFiredAt && " · "}
              {schedule.lastFiredAt && (
                <>last fired {formatRelativeTime(schedule.lastFiredAt)}</>
              )}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="btn sm"
          >
            Edit
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="type-caption-1 text-[color:var(--text-muted)]">
                Delete?
              </span>
              <button
                type="button"
                onClick={handleDelete}
                className="btn primary sm"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="btn sm"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="btn sm"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
