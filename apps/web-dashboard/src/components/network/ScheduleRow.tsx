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
    <li id={`schedule-${schedule.id}`} className="dp-card p-4 scroll-mt-20">
      <div className="flex items-start gap-3">
        {/* Enabled toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={schedule.enabled}
          aria-label={`Toggle ${schedule.name}`}
          onClick={handleToggle}
          disabled={toggleBusy}
          className={`mt-1 w-10 h-6 rounded-full relative transition-colors ${
            schedule.enabled ? "bg-accent" : "bg-surface-secondary"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              schedule.enabled ? "translate-x-4" : ""
            }`}
            aria-hidden="true"
          />
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
                className="dp-input type-headline"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="type-headline text-label-primary text-left hover:text-accent"
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
            <span className="inline-flex items-center gap-1 type-caption-1 px-2 py-0.5 rounded bg-surface-secondary text-label-secondary">
              {subjectLabel} ({subjectKind})
            </span>
          </div>

          {/* Windows summary */}
          <p className="mt-2 type-subheadline text-label-secondary">
            {schedule.windows.length > 0
              ? schedule.windows.map((w) => formatWindow(w)).join(" · ")
              : "No windows"}
          </p>

          {/* Transition meta */}
          {(schedule.nextTransitionAt || schedule.lastFiredAt) && (
            <p className="mt-1 type-caption-2 text-label-tertiary">
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
            className="dp-btn-secondary text-sm"
          >
            Edit
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="type-caption-1 text-label-secondary">Delete?</span>
              <button
                type="button"
                onClick={handleDelete}
                className="dp-btn-primary text-sm"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="dp-btn-secondary text-sm"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="dp-btn-secondary text-sm"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
