"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Icons from "lucide-react";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { useScheduleMutations } from "@/lib/hooks/useScheduleMutations";
import { useNetworkDevices } from "@/lib/hooks/useNetworkDevices";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import type { Schedule } from "@/lib/types";
import { WeeklyWindowsEditor, type WindowDraft } from "./WeeklyWindowsEditor";
import { ScheduleHeatmap } from "./ScheduleHeatmap";

/**
 * Full-viewport modal for creating and editing a schedule.
 *
 * - `scheduleId === "new"`: blank form, subject selector editable, creates.
 * - `scheduleId` is a real id: load from the SWR schedules list and populate.
 *   The subject is immutable once the schedule exists (per WARP-94), so we
 *   disable those controls.
 * - `null`: modal is closed (component renders nothing).
 *
 * Save path uses `useScheduleMutations`. On typed error we surface a toast
 * and keep the form open so the user can fix the offending field.
 */

interface Props {
  scheduleId: string | "new" | null;
  onClose: () => void;
}

const TOAST_COPY: Record<string, string> = {
  SCHEDULE_INVALID_WINDOW: "Please check your schedule windows",
  SCHEDULE_TOO_MANY_WINDOWS: "A schedule can have at most 7 windows",
  SCHEDULE_SUBJECT_REQUIRED: "Pick a device or group",
  SCHEDULE_NAME_REQUIRED: "Schedule needs a name",
  SCHEDULE_NOT_FOUND: "Schedule no longer exists",
};

function toastForScheduleError(err: unknown, fallback = "Something went wrong"): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    const code = (err as { code: string }).code;
    return TOAST_COPY[code] ?? fallback;
  }
  return fallback;
}

interface FormState {
  name: string;
  enabled: boolean;
  subjectType: "device" | "group";
  deviceMac: string;
  groupId: string;
  windows: WindowDraft[];
}

function blankForm(): FormState {
  return {
    name: "",
    enabled: true,
    subjectType: "device",
    deviceMac: "",
    groupId: "",
    windows: [{ daysOfWeek: 0, startMin: 0, endMin: 60 }],
  };
}

function fromSchedule(s: Schedule): FormState {
  return {
    name: s.name,
    enabled: s.enabled,
    subjectType: s.subjectType,
    deviceMac: s.deviceMac ?? "",
    groupId: s.groupId ?? "",
    windows: s.windows.map((w) => ({
      id: w.id,
      daysOfWeek: w.daysOfWeek,
      startMin: w.startMin,
      endMin: w.endMin,
    })),
  };
}

export function ScheduleEditorModal({ scheduleId, onClose }: Props) {
  const schedulesSwr = useSchedules();
  const devicesSwr = useNetworkDevices();
  const groupsSwr = useNetworkGroups();
  const { createSchedule, updateSchedule } = useScheduleMutations();

  const isEditing = scheduleId !== null && scheduleId !== "new";
  const existing = useMemo<Schedule | null>(() => {
    if (!isEditing) return null;
    return (
      schedulesSwr.data?.schedules.find((s) => s.id === scheduleId) ?? null
    );
  }, [isEditing, scheduleId, schedulesSwr.data]);

  const [form, setForm] = useState<FormState>(() =>
    existing ? fromSchedule(existing) : blankForm(),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const hydratedFor = useRef<string | null>(null);

  // Hydrate once the schedule arrives from SWR (the modal may open before
  // the schedules list resolves).
  useEffect(() => {
    if (!isEditing || !existing) return;
    if (hydratedFor.current === existing.id) return;
    setForm(fromSchedule(existing));
    hydratedFor.current = existing.id;
  }, [isEditing, existing]);

  // Focus the first field on open.
  useEffect(() => {
    if (scheduleId === null) return;
    nameRef.current?.focus();
  }, [scheduleId]);

  // ESC closes.
  useEffect(() => {
    if (scheduleId === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scheduleId, onClose]);

  if (scheduleId === null) return null;

  const devices = devicesSwr.data?.devices ?? [];
  const groups = groupsSwr.data?.groups ?? [];

  function update<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: val }));
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      if (!isEditing) {
        // Create path — send full payload, including subject.
        const payload = {
          name: form.name.trim(),
          enabled: form.enabled,
          subjectType: form.subjectType,
          ...(form.subjectType === "device"
            ? { deviceMac: form.deviceMac || undefined }
            : { groupId: form.groupId || undefined }),
          windows: form.windows.map((w) => ({
            daysOfWeek: w.daysOfWeek,
            startMin: w.startMin,
            endMin: w.endMin,
          })),
        };
        await createSchedule(payload);
      } else {
        // Update path — subject is immutable (WARP-94), don't send it.
        await updateSchedule(scheduleId as string, {
          name: form.name.trim(),
          enabled: form.enabled,
          windows: form.windows.map((w) => ({
            id: w.id!,
            daysOfWeek: w.daysOfWeek,
            startMin: w.startMin,
            endMin: w.endMin,
          })) as Schedule["windows"],
        });
      }
      onClose();
    } catch (err) {
      setToast(toastForScheduleError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid="schedule-editor-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Edit schedule"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-primary border border-separator rounded-lg w-full max-w-[600px] max-h-[90vh] overflow-y-auto shadow-xl"
      >
        <div className="p-4 border-b border-separator flex items-center justify-between">
          <h2 className="type-title-3 text-label-primary">
            {isEditing ? "Edit schedule" : "New schedule"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-label-secondary hover:text-label-primary"
          >
            <Icons.X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Name */}
          <div className="space-y-1">
            <label
              htmlFor="schedule-name"
              className="type-caption-1 text-label-secondary"
            >
              Name
            </label>
            <input
              id="schedule-name"
              ref={nameRef}
              type="text"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="e.g. Bedtime"
              className="dp-input"
            />
          </div>

          {/* Subject */}
          <fieldset className="space-y-2" disabled={isEditing}>
            <legend className="type-caption-1 text-label-secondary">
              Subject
            </legend>
            <div className="flex gap-4">
              <label className="type-subheadline text-label-primary flex items-center gap-2">
                <input
                  type="radio"
                  name="subjectType"
                  value="device"
                  checked={form.subjectType === "device"}
                  onChange={() => update("subjectType", "device")}
                  disabled={isEditing}
                />
                Device
              </label>
              <label className="type-subheadline text-label-primary flex items-center gap-2">
                <input
                  type="radio"
                  name="subjectType"
                  value="group"
                  checked={form.subjectType === "group"}
                  onChange={() => update("subjectType", "group")}
                  disabled={isEditing}
                />
                Group
              </label>
            </div>

            {form.subjectType === "device" ? (
              <select
                value={form.deviceMac}
                onChange={(e) => update("deviceMac", e.target.value)}
                disabled={isEditing}
                aria-label="Device"
                className="dp-input"
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
                value={form.groupId}
                onChange={(e) => update("groupId", e.target.value)}
                disabled={isEditing}
                aria-label="Group"
                className="dp-input"
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

          {/* Enabled */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              aria-label="Enabled"
              onClick={() => update("enabled", !form.enabled)}
              className={`w-10 h-6 rounded-full relative transition-colors ${
                form.enabled ? "bg-accent" : "bg-surface-secondary"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  form.enabled ? "translate-x-4" : ""
                }`}
                aria-hidden="true"
              />
            </button>
            <span className="type-subheadline text-label-primary">
              {form.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>

          {/* Windows */}
          <div className="space-y-2">
            <h3 className="type-caption-1 text-label-secondary">Windows</h3>
            <WeeklyWindowsEditor
              value={form.windows}
              onChange={(ws) => update("windows", ws)}
            />
          </div>

          {/* Heatmap preview */}
          <div className="space-y-2">
            <h3 className="type-caption-1 text-label-secondary">Preview</h3>
            <ScheduleHeatmap windows={form.windows} />
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-separator flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="dp-button-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="dp-button-primary disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {toast && (
          <div
            role="alert"
            className="fixed bottom-4 right-4 bg-system-red/90 text-white px-4 py-2 rounded-sm shadow-lg flex items-center gap-2"
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
    </div>
  );
}
