"use client";

// WARP-3520 -- the small pieces the project settings tabs share: the colour
// swatches (project, state, label and option colours are all one palette), the
// error strip, and the busy/error wrapper every write goes through.

import { useCallback, useState, type JSX } from "react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { PmIcon } from "../icons";
import type { StateGroup } from "../types";
import "../editing.css";
import "./settings.css";

/** The palette. These are DATA, persisted on the row exactly like the project
 *  swatches in modals.tsx and the seeded state colours — not styling. The first
 *  four are the system hues; slate is the seeded Backlog colour. */
export const COLORS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: "#6366f1", name: "Indigo" },
  { hex: "#22c55e", name: "Green" },
  { hex: "#f59e0b", name: "Amber" },
  { hex: "#ef4444", name: "Red" },
  { hex: "#06b6d4", name: "Cyan" },
  { hex: "#8b5cf6", name: "Violet" },
  { hex: "#ec4899", name: "Pink" },
  { hex: "#94a3b8", name: "Slate" },
];

export const DEFAULT_COLOR = COLORS[0].hex;

/** What a state group is called to a person ("unstarted" is a data word). */
export const GROUP_LABEL: Record<StateGroup, string> = {
  backlog: "Backlog",
  unstarted: "Not started",
  started: "In progress",
  completed: "Done",
  cancelled: "Cancelled",
};
export const GROUP_ORDER: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];

const nameOf = (hex: string | null | undefined) => COLORS.find((c) => c.hex === hex)?.name ?? "Custom colour";

/** The current colour as a button; `expanded` says whether its picker is open. */
export function SwatchDot({
  color,
  label,
  expanded,
  onClick,
}: {
  color: string | null | undefined;
  label: string;
  expanded?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="pm-swatch-dot"
      aria-label={`${label}: ${nameOf(color)}`}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <span style={{ background: color ?? "var(--text-4)" }} />
    </button>
  );
}

/** A group of colour buttons; `aria-pressed` marks the chosen one. A colour the
 *  palette does not contain (set elsewhere) is shown first so it is not lost. */
export function SwatchPicker({
  value,
  label,
  onPick,
}: {
  value: string | null | undefined;
  label: string;
  onPick: (hex: string) => void;
}): JSX.Element {
  const known = COLORS.some((c) => c.hex === value);
  const all = value && !known ? [{ hex: value, name: "Custom colour" }, ...COLORS] : COLORS;
  return (
    <div className="pm-swatches" role="group" aria-label={label}>
      {all.map((c) => (
        <button
          key={c.hex}
          type="button"
          className="pm-swatch"
          aria-label={c.name}
          aria-pressed={value === c.hex}
          style={{ background: c.hex }}
          onClick={() => onPick(c.hex)}
        >
          {value === c.hex && <PmIcon name="check" size={13} />}
        </button>
      ))}
    </div>
  );
}

/** The inline strip a failed save shows (design brief §3.5): friendly copy, and
 *  `role="alert"` so a screen reader says it. */
export function ErrorStrip({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;
  return (
    <div className="pm-alert" role="alert">
      {message}
    </div>
  );
}

/**
 * Run one write for a settings tab: `busy` while it is in flight, an inline
 * error and a toast when it is refused (`translateError`, never the raw code),
 * and `after` (revalidation, board refresh) only when it succeeded. Resolves
 * true on success so a caller can close its own form.
 */
export function useSettingsAction() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (write: () => Promise<unknown>, after?: () => Promise<unknown> | void): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await write();
        await after?.();
        return true;
      } catch (e) {
        const message = translateError(e, "projects");
        setError(message);
        toast(message, "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy, error, clearError: () => setError(null) };
}
