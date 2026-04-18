"use client";
import { useEffect, useRef, useState } from "react";
import { useScheduleMutations } from "@/lib/hooks/useScheduleMutations";
import { ScheduleEditorModal } from "./ScheduleEditorModal";
import { presetById } from "./schedule-presets";

/**
 * Compact popover that one-click applies the "Bedtime" preset to a device or
 * group, with an escape-hatch to open the full editor pre-filled with the
 * preset's windows.
 *
 * The Bedtime windows come from the shared `SCHEDULE_PRESETS` registry
 * (WARP-99 / T8) — keep them out of this file.
 */

export type QuickScheduleSubject =
  | { type: "device"; deviceMac: string; groupId?: undefined }
  | { type: "group"; groupId: string; deviceMac?: undefined };

interface Props {
  subject: QuickScheduleSubject;
  onClose: () => void;
}

const BEDTIME = presetById("bedtime")!;

export function QuickSchedulePopover({ subject, onClose }: Props) {
  const { createSchedule } = useScheduleMutations();
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // ESC closes the popover.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Click-outside closes. The popover is `role="dialog"` so a global mousedown
  // listener is the cleanest cross-host way to detect clicks outside.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    // Defer by a frame so the opening click doesn't instantly close it.
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  async function handleApply() {
    if (saving) return;
    setSaving(true);
    setToast(null);
    try {
      await createSchedule({
        name: BEDTIME.name,
        enabled: true,
        subjectType: subject.type,
        ...(subject.type === "device"
          ? { deviceMac: subject.deviceMac }
          : { groupId: subject.groupId }),
        windows: BEDTIME.windows!.map((w) => ({ ...w })),
      });
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not apply Bedtime schedule";
      setToast(msg);
    } finally {
      setSaving(false);
    }
  }

  function handleCustomize() {
    setCustomizeOpen(true);
  }

  if (customizeOpen) {
    return (
      <ScheduleEditorModal
        scheduleId="new"
        initialSubject={
          subject.type === "device"
            ? { type: "device", deviceMac: subject.deviceMac }
            : { type: "group", groupId: subject.groupId }
        }
        initialPreset="bedtime"
        onClose={onClose}
      />
    );
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Apply quick schedule"
      onClick={(e) => e.stopPropagation()}
      className="absolute z-50 w-[280px] bg-surface-primary border border-separator rounded-lg shadow-xl p-3"
    >
      <p className="type-headline text-label-primary">Apply Bedtime?</p>
      <p className="type-footnote text-label-secondary mt-1">
        Sun–Thu 9pm–7am, Fri–Sat 11pm–8am
      </p>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleCustomize();
          }}
          className="dp-button-secondary text-sm"
        >
          Customize
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleApply();
          }}
          disabled={saving}
          className="dp-button-primary text-sm disabled:opacity-50"
        >
          {saving ? "Applying…" : "Apply"}
        </button>
      </div>

      {toast && (
        <div
          role="alert"
          className="mt-2 type-caption-1 text-system-red"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
