"use client";
/**
 * WARP-2974 — add a recurring run (AgentRunSchedule, WARP-2180). The rail
 * lists the schedules; this dialog is the add form the WARP-2180 panel used
 * to render inline: a goal, a preset (or a custom RRULE in the ticker's
 * subset), the person's time zone.
 */
import { useRef, useState, type RefObject } from "react";
import { Repeat } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { createAgentRunSchedule, RRULE_PRESETS } from "./agent-runs/api";

const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export interface RecurringDialogProps {
  open: boolean;
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
  onAdded: () => void;
}

export function RecurringDialog({ open, onClose, triggerRef, onAdded }: RecurringDialogProps) {
  const [goal, setGoal] = useState("");
  const [preset, setPreset] = useState<string>(RRULE_PRESETS[0]!.key);
  const [customRrule, setCustomRrule] = useState("");
  const [timezone, setTimezone] = useState<string>(localTimezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goalRef = useRef<HTMLInputElement>(null);

  const rrule = preset === "custom" ? customRrule.trim() : (RRULE_PRESETS.find((p) => p.key === preset)?.rrule ?? "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || !rrule || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createAgentRunSchedule({ goal: trimmed, rrule, timezone: timezone.trim() || "UTC" });
      setGoal("");
      setCustomRrule("");
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} triggerRef={triggerRef} labelledBy="recurring-heading" initialFocusRef={goalRef}>
      <form onSubmit={(e) => void submit(e)} aria-label="Add a recurring run" className="flex flex-col gap-4">
        <div>
          <h2 id="recurring-heading" className="flex items-center gap-2 text-[16px] font-semibold m-0">
            <Repeat size={16} aria-hidden /> Recurring run
          </h2>
          <p className="text-[13px] m-0 mt-1" style={{ color: "var(--text-muted)" }}>
            The box starts this run on its own at the chosen time. Anything it wants to change still waits for your OK.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-[12.5px]">
          Goal
          <input
            ref={goalRef}
            type="text"
            required
            maxLength={4000}
            value={goal}
            disabled={busy}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. sweep last night's camera clips"
            className="rounded px-2 py-1.5 text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px]">
          When
          <select value={preset} disabled={busy} onChange={(e) => setPreset(e.target.value)} className="rounded px-2 py-1.5 text-[13px]">
            {RRULE_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom RRULE…</option>
          </select>
        </label>
        {preset === "custom" && (
          <label className="flex flex-col gap-1 text-[12.5px]">
            RRULE
            <input
              type="text"
              required
              value={customRrule}
              disabled={busy}
              onChange={(e) => setCustomRrule(e.target.value)}
              placeholder="FREQ=DAILY;BYHOUR=6;BYMINUTE=0"
              className="rounded px-2 py-1.5 text-[13px] font-mono"
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-[12.5px]">
          Time zone
          <input
            type="text"
            required
            value={timezone}
            disabled={busy}
            onChange={(e) => setTimezone(e.target.value)}
            className="rounded px-2 py-1.5 text-[13px]"
          />
        </label>
        {error && (
          <p role="status" className="text-[13px] m-0" title={error}>
            {CALM_ERROR}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !goal.trim() || !rrule}>
            Add recurring run
          </button>
        </div>
      </form>
    </Dialog>
  );
}
