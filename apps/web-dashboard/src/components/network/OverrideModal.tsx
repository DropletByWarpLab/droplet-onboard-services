"use client";
import { useEffect, useId, useMemo, useState } from "react";
import * as Icons from "lucide-react";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { useActiveOverrides } from "@/lib/hooks/useActiveOverrides";
import { useOverrideMutations } from "@/lib/hooks/useOverrideMutations";
import { useNetworkDevices } from "@/lib/hooks/useNetworkDevices";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { nextTransitionFor } from "@/lib/scheduleEval";
import type { Schedule, ScheduleOverride } from "@/lib/types";
import { Dialog } from "@/components/Dialog";
import { toastForError } from "@/lib/toastForError";

/**
 * Compact modal for creating one-off allow/block overrides against a device
 * or a group (per WARP-97 / spec §7.4).
 *
 * Layout is a ~450px centered dialog with:
 *   - Active-override banner (if one exists for this subject) with Cancel.
 *   - Action radio: allow / block.
 *   - Duration quick chips: 15m / 30m / 1h / 2h / "until next transition" /
 *     custom. The "until next transition" chip reads the subject's applicable
 *     schedules via `useSchedules` + `nextTransitionFor`. If the subject has
 *     no applicable schedule (or the next transition is >24h out), we fall
 *     back to a "+30m" chip.
 *   - Optional note.
 *
 * On Apply we compute `endAt` from the selected chip (or the custom
 * datetime-local input), `startAt = now`, and POST via
 * `useOverrideMutations.createOverride`. Typed errors (`OVERRIDE_INVALID_RANGE`,
 * `INVALID_DATE`, `OVERRIDE_NOT_FOUND`) surface through the shared
 * `toastForError` helper (WARP-105 unified the previously-local map).
 */

/**
 * Subject at open-time. When both `deviceMac` and `groupId` are undefined,
 * the modal renders an inline subject picker so the user can choose — this
 * is the path WARP-99's Homework preset card takes. When a subject is
 * pre-filled (WARP-97/98 flows), the picker is hidden and the subject is
 * immutable.
 */
type Subject =
  | { type: "device"; deviceMac: string; groupId?: undefined }
  | { type: "group"; groupId: string; deviceMac?: undefined }
  | { type: "device"; deviceMac?: undefined; groupId?: undefined };

interface Props {
  subject: Subject;
  subjectName?: string;
  defaultAction?: "allow" | "block";
  /**
   * If set, preselects the matching duration chip (15 / 30 / 60 / 120).
   * Any other value drops into the "custom" chip with the computed endAt
   * prefilled into the datetime input. This is how WARP-99 preset cards
   * (e.g. Homework = 90m) will pre-select their default.
   */
  defaultDurationMin?: number;
  onClose: () => void;
}

type DurationChip = "15" | "30" | "60" | "120" | "transition" | "fallback30" | "custom";

// WARP-114: mirror the orchestrator's 90-day override cap so a datetime-picker
// typo can't slip a multi-year override past Apply and bounce off the server.
const MAX_OVERRIDE_MS = 90 * 86400_000;

function formatHHMM(d: Date): string {
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

/** Shape "in 6h" / "in 45m" for the transition-chip label. */
function formatRelative(minutesAhead: number): string {
  if (minutesAhead < 60) return `${minutesAhead}m`;
  const h = Math.round(minutesAhead / 60);
  return `${h}h`;
}

/** Convert a Date to the `<input type="datetime-local">` value format. */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function pickInitialChip(defaultDurationMin?: number): DurationChip {
  if (defaultDurationMin === 15) return "15";
  if (defaultDurationMin === 30) return "30";
  if (defaultDurationMin === 60) return "60";
  if (defaultDurationMin === 120) return "120";
  if (typeof defaultDurationMin === "number" && defaultDurationMin > 0) return "custom";
  return "60";
}

interface ResolvedSubject {
  type: "device" | "group";
  deviceMac?: string;
  groupId?: string;
}

function matchesSubject(s: Schedule, subject: ResolvedSubject): boolean {
  if (!s.enabled) return false;
  if (subject.type === "device")
    return s.subjectType === "device" && s.deviceMac === subject.deviceMac;
  return s.subjectType === "group" && s.groupId === subject.groupId;
}

function subjectIsPreset(s: Subject): boolean {
  return Boolean(s.deviceMac || s.groupId);
}

export function OverrideModal({
  subject,
  subjectName,
  defaultAction = "allow",
  defaultDurationMin,
  onClose,
}: Props) {
  const presetSubject = subjectIsPreset(subject);
  // When the subject is blank at open-time (preset-launched flow), the user
  // picks inside the modal. Once picked, the picker stays interactive until
  // Apply — at which point `createOverride` uses the resolved values.
  const [pickerType, setPickerType] = useState<"device" | "group">(
    subject.type,
  );
  const [pickerDeviceMac, setPickerDeviceMac] = useState<string>("");
  const [pickerGroupId, setPickerGroupId] = useState<string>("");

  const headingId = useId();

  const devicesSwr = useNetworkDevices();
  const groupsSwr = useNetworkGroups();

  const resolvedSubject: ResolvedSubject = presetSubject
    ? {
        type: subject.type,
        deviceMac:
          subject.type === "device" ? (subject.deviceMac as string) : undefined,
        groupId:
          subject.type === "group" ? (subject.groupId as string) : undefined,
      }
    : {
        type: pickerType,
        deviceMac: pickerType === "device" ? pickerDeviceMac || undefined : undefined,
        groupId: pickerType === "group" ? pickerGroupId || undefined : undefined,
      };

  const subjectSelected =
    (resolvedSubject.type === "device" && !!resolvedSubject.deviceMac) ||
    (resolvedSubject.type === "group" && !!resolvedSubject.groupId);

  const schedulesSwr = useSchedules();
  const overridesSwr = useActiveOverrides({
    deviceMac: subjectSelected && resolvedSubject.type === "device" ? resolvedSubject.deviceMac : undefined,
    groupId: subjectSelected && resolvedSubject.type === "group" ? resolvedSubject.groupId : undefined,
  });
  const { createOverride, cancelOverride } = useOverrideMutations();

  const [action, setAction] = useState<"allow" | "block">(defaultAction);
  const [chip, setChip] = useState<DurationChip>(() =>
    pickInitialChip(defaultDurationMin),
  );
  const [customEndAt, setCustomEndAt] = useState<string>(() => {
    if (typeof defaultDurationMin === "number" && defaultDurationMin > 0) {
      return toDatetimeLocalValue(
        new Date(Date.now() + defaultDurationMin * 60_000),
      );
    }
    return "";
  });
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  // Minute-resolution tick so the modal never shows a stale "now" if it stays
  // open across a schedule transition. All current-time reads in the render
  // path (transitionInfo, computeEndAt, applyDisabled) route through `nowTick`
  // so they agree within a render and refresh together every ~60s (WARP-103).
  const [nowTick, setNowTick] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNowTick(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Compute the "until next transition" chip label from the subject's
  // applicable schedules. If the next transition is >24h out (or doesn't
  // exist), we substitute a "+30m" fallback chip. Recomputed on each 60s tick
  // (via `nowTick`) so the label and computed endAt don't go stale.
  const transitionInfo = useMemo(() => {
    const all: Schedule[] = schedulesSwr.data?.schedules ?? [];
    if (!subjectSelected) return { kind: "fallback" as const };
    const applicable = all.filter((s) => matchesSubject(s, resolvedSubject));
    if (applicable.length === 0) return { kind: "fallback" as const };
    const now = nowTick;
    const next = nextTransitionFor(applicable, now);
    if (!next) return { kind: "fallback" as const };
    const minutesAhead = Math.round((next.at.getTime() - now.getTime()) / 60_000);
    if (minutesAhead > 24 * 60) return { kind: "fallback" as const };
    return {
      kind: "transition" as const,
      at: next.at,
      label: `until ${formatHHMM(next.at)} (${formatRelative(minutesAhead)})`,
    };
  }, [schedulesSwr.data, subjectSelected, resolvedSubject.type, resolvedSubject.deviceMac, resolvedSubject.groupId, nowTick]);

  // ESC closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeOverrides: ScheduleOverride[] =
    overridesSwr.data?.overrides ?? [];
  const currentOverride = activeOverrides[0];

  function computeEndAt(): Date | null {
    const now = nowTick;
    switch (chip) {
      case "15":
        return new Date(now.getTime() + 15 * 60_000);
      case "30":
        return new Date(now.getTime() + 30 * 60_000);
      case "60":
        return new Date(now.getTime() + 60 * 60_000);
      case "120":
        return new Date(now.getTime() + 120 * 60_000);
      case "fallback30":
        return new Date(now.getTime() + 30 * 60_000);
      case "transition":
        return transitionInfo.kind === "transition" ? transitionInfo.at : null;
      case "custom": {
        if (!customEndAt) return null;
        const d = new Date(customEndAt);
        if (Number.isNaN(d.getTime())) return null;
        return d;
      }
    }
  }

  const endAtDate = computeEndAt();
  // WARP-114: only the custom datetime can realistically exceed 90 days (the
  // quick chips top out at 2h), so we surface the explanatory hint there.
  const customExceedsMax =
    chip === "custom" &&
    !!endAtDate &&
    endAtDate.getTime() - nowTick.getTime() > MAX_OVERRIDE_MS;
  // Base the disable on `nowTick` (not a fresh Date.now()) so the button flips
  // exactly when the displayed time advances on a tick (WARP-103 AC3).
  const applyDisabled =
    saving ||
    !endAtDate ||
    endAtDate.getTime() <= nowTick.getTime() ||
    endAtDate.getTime() - nowTick.getTime() > MAX_OVERRIDE_MS ||
    !subjectSelected;

  async function handleApply() {
    if (saving) return;
    setInlineError(null);
    if (!subjectSelected) {
      setInlineError("Pick a device or group");
      return;
    }
    const endAt = computeEndAt();
    if (!endAt) {
      setInlineError("Pick an end time");
      return;
    }
    if (endAt.getTime() <= Date.now()) {
      setInlineError("End time must be in the future");
      return;
    }
    setSaving(true);
    try {
      await createOverride({
        subjectType: resolvedSubject.type,
        deviceMac:
          resolvedSubject.type === "device" ? resolvedSubject.deviceMac : undefined,
        groupId:
          resolvedSubject.type === "group" ? resolvedSubject.groupId : undefined,
        action,
        startAt: new Date().toISOString(),
        endAt: endAt.toISOString(),
        note: note.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setToast(toastForError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleCancelOverride(id: string) {
    try {
      await cancelOverride(id);
    } catch (err) {
      setToast(toastForError(err));
    }
  }

  const subjectLabel =
    subjectName ??
    (presetSubject
      ? subject.type === "device"
        ? "device"
        : "group"
      : "new override");

  const devices = devicesSwr.data?.devices ?? [];
  const groups = groupsSwr.data?.groups ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={headingId}
      maxWidth="md"
      // Sectioned layout (full-width header divider) — sections own their
      // padding; scroll comes from the primitive body (WARP-1153).
      flush
    >
      <div data-testid="override-modal-backdrop">
        <div className="p-4 border-b border-[var(--card-bd)] flex items-center justify-between">
          <h2
            id={headingId}
            className="type-title-3 text-[color:var(--text)]"
          >
            Override for {subjectLabel}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm"
          >
            <Icons.X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {!presetSubject && (
            <fieldset
              className="space-y-2"
              data-testid="subject-picker"
              aria-label="Subject"
            >
              <legend className="type-caption-1 text-[color:var(--text-muted)]">
                Subject
              </legend>
              <div className="flex gap-4">
                <label className="type-subheadline text-[color:var(--text)] flex items-center gap-2">
                  <input
                    type="radio"
                    name="override-subject-type"
                    value="device"
                    checked={pickerType === "device"}
                    onChange={() => setPickerType("device")}
                  />
                  Device
                </label>
                <label className="type-subheadline text-[color:var(--text)] flex items-center gap-2">
                  <input
                    type="radio"
                    name="override-subject-type"
                    value="group"
                    checked={pickerType === "group"}
                    onChange={() => setPickerType("group")}
                  />
                  Group
                </label>
              </div>

              {pickerType === "device" ? (
                <select
                  value={pickerDeviceMac}
                  onChange={(e) => setPickerDeviceMac(e.target.value)}
                  aria-label="Device"
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                >
                  <option value="">Select a device…</option>
                  {devices.map((d) => (
                    <option key={d.mac} value={d.mac}>
                      {d.displayName ?? d.hostname ?? d.mac} ({d.mac})
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={pickerGroupId}
                  onChange={(e) => setPickerGroupId(e.target.value)}
                  aria-label="Group"
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                >
                  <option value="">Select a group…</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              )}
            </fieldset>
          )}

          {currentOverride && (
            <div
              role="status"
              data-testid="active-override-banner"
              className="flex items-center justify-between gap-2 rounded-sm border border-[var(--card-bd)] bg-[var(--card-inner)] px-3 py-2"
            >
              <span className="type-footnote text-[color:var(--text)]">
                Current override: {currentOverride.action} until{" "}
                {formatHHMM(new Date(currentOverride.endAt))}
              </span>
              <button
                type="button"
                onClick={() => handleCancelOverride(currentOverride.id)}
                className="type-footnote text-system-red hover:underline"
              >
                Cancel
              </button>
            </div>
          )}

          {/* Action */}
          <fieldset className="space-y-2">
            <legend className="type-caption-1 text-[color:var(--text-muted)]">
              Action
            </legend>
            <div className="flex gap-4">
              <label className="type-subheadline text-[color:var(--text)] flex items-center gap-2">
                <input
                  type="radio"
                  name="override-action"
                  value="allow"
                  checked={action === "allow"}
                  onChange={() => setAction("allow")}
                />
                Allow
              </label>
              <label className="type-subheadline text-[color:var(--text)] flex items-center gap-2">
                <input
                  type="radio"
                  name="override-action"
                  value="block"
                  checked={action === "block"}
                  onChange={() => setAction("block")}
                />
                Block
              </label>
            </div>
          </fieldset>

          {/* Duration chips */}
          <fieldset className="space-y-2">
            <legend className="type-caption-1 text-[color:var(--text-muted)]">
              Duration
            </legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  { id: "15" as const, label: "15m" },
                  { id: "30" as const, label: "30m" },
                  { id: "60" as const, label: "1h" },
                  { id: "120" as const, label: "2h" },
                ]
              ).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setChip(c.id)}
                  aria-pressed={chip === c.id}
                  className={`chip type-footnote${chip === c.id ? " on" : ""}`}
                >
                  {c.label}
                </button>
              ))}

              {transitionInfo.kind === "transition" ? (
                <button
                  type="button"
                  data-testid="chip-transition"
                  onClick={() => setChip("transition")}
                  aria-pressed={chip === "transition"}
                  className={`chip type-footnote${chip === "transition" ? " on" : ""}`}
                >
                  {transitionInfo.label}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="chip-fallback"
                  onClick={() => setChip("fallback30")}
                  aria-pressed={chip === "fallback30"}
                  className={`chip type-footnote${chip === "fallback30" ? " on" : ""}`}
                >
                  +30m
                </button>
              )}

              <button
                type="button"
                onClick={() => setChip("custom")}
                aria-pressed={chip === "custom"}
                className={`chip type-footnote${chip === "custom" ? " on" : ""}`}
              >
                Custom
              </button>
            </div>

            {chip === "custom" && (
              <div className="pt-2 space-y-1">
                <label
                  htmlFor="override-end-at"
                  className="type-caption-1 text-[color:var(--text-muted)] block"
                >
                  End at
                </label>
                <input
                  id="override-end-at"
                  type="datetime-local"
                  value={customEndAt}
                  onChange={(e) => setCustomEndAt(e.target.value)}
                  className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    color: "var(--text)",
                  }}
                  aria-label="End at"
                  aria-describedby={
                    customExceedsMax ? "override-end-at-hint" : undefined
                  }
                />
                {customExceedsMax && (
                  <p
                    id="override-end-at-hint"
                    className="type-footnote text-system-red"
                  >
                    Overrides can last at most 90 days.
                  </p>
                )}
              </div>
            )}
          </fieldset>

          {/* Note */}
          <div className="space-y-1">
            <label
              htmlFor="override-note"
              className="type-caption-1 text-[color:var(--text-muted)]"
            >
              Note (optional)
            </label>
            <input
              id="override-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Guest access"
              className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
          </div>

          {inlineError && (
            <div
              role="alert"
              className="type-footnote text-system-red"
            >
              {inlineError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[var(--card-bd)] flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={applyDisabled}
            className="btn primary"
          >
            {saving ? "Applying…" : "Apply"}
          </button>
        </div>

        {toast && (
          <div
            role="alert"
            className="fixed bottom-[calc(72px+env(safe-area-inset-bottom))] right-4 lg:bottom-4 z-50 bg-system-red/90 text-white px-4 py-2 rounded-sm shadow-lg flex items-center gap-2"
          >
            <span>{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
              className="hover:opacity-80"
            >
              <Icons.X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
