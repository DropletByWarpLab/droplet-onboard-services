"use client";
import { useId } from "react";

/**
 * Reusable editor for a list of weekly windows.
 *
 * A "window" is a day-of-week bitmask + a start/end minute-of-day. Wrapping past
 * midnight is legal (endMin <= startMin) — we surface an "Ends next day" hint so
 * the user isn't confused. Zero-length windows are surfaced as an inline error;
 * the parent form is expected to block Save on them.
 *
 * Day-of-week bitmask: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64.
 */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_BIT = [1, 2, 4, 8, 16, 32, 64];
const MAX_WINDOWS = 7;

export interface WindowDraft {
  id?: string;
  daysOfWeek: number;
  startMin: number;
  endMin: number;
}

interface Props {
  value: WindowDraft[];
  onChange: (windows: WindowDraft[]) => void;
}

function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map((n) => Number.parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return (h % 24) * 60 + (m % 60);
}

export function WeeklyWindowsEditor({ value, onChange }: Props) {
  const uid = useId();

  function updateAt(idx: number, patch: Partial<WindowDraft>) {
    const next = value.map((w, i) => (i === idx ? { ...w, ...patch } : w));
    onChange(next);
  }

  function toggleDay(idx: number, dayIndex: number) {
    const cur = value[idx];
    const bit = DAY_BIT[dayIndex];
    const nextMask =
      (cur.daysOfWeek & bit) !== 0 ? cur.daysOfWeek & ~bit : cur.daysOfWeek | bit;
    updateAt(idx, { daysOfWeek: nextMask });
  }

  function removeAt(idx: number) {
    const next = value.filter((_, i) => i !== idx);
    onChange(next);
  }

  function addWindow() {
    if (value.length >= MAX_WINDOWS) return;
    const next = [...value, { daysOfWeek: 0, startMin: 0, endMin: 60 }];
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {value.map((w, idx) => {
        const zeroLength = w.startMin === w.endMin;
        const wrapsMidnight = !zeroLength && w.endMin <= w.startMin;
        return (
          <div
            key={w.id ?? `new-${idx}`}
            role="group"
            aria-label={`Window ${idx + 1}`}
            className="dp-card p-3 space-y-2"
          >
            {/* Day checkboxes */}
            <div className="flex flex-wrap gap-3">
              {DAY_NAMES.map((name, dayIdx) => {
                const bit = DAY_BIT[dayIdx];
                const checked = (w.daysOfWeek & bit) !== 0;
                const inputId = `${uid}-${idx}-${dayIdx}`;
                return (
                  <label
                    key={dayIdx}
                    htmlFor={inputId}
                    className="type-caption-1 text-label-secondary flex items-center gap-1 cursor-pointer"
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDay(idx, dayIdx)}
                      aria-label={name}
                    />
                    {name}
                  </label>
                );
              })}
            </div>

            {/* Time range */}
            <div className="flex items-center gap-2">
              <label className="type-caption-1 text-label-secondary flex items-center gap-2">
                Start
                <input
                  type="time"
                  value={minutesToHHMM(w.startMin)}
                  onChange={(e) =>
                    updateAt(idx, { startMin: hhmmToMinutes(e.target.value) })
                  }
                  aria-label={`Window ${idx + 1} start`}
                  className="dp-input"
                />
              </label>
              <label className="type-caption-1 text-label-secondary flex items-center gap-2">
                End
                <input
                  type="time"
                  value={minutesToHHMM(w.endMin)}
                  onChange={(e) =>
                    updateAt(idx, { endMin: hhmmToMinutes(e.target.value) })
                  }
                  aria-label={`Window ${idx + 1} end`}
                  className="dp-input"
                />
              </label>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => removeAt(idx)}
                disabled={value.length <= 1}
                aria-label={`Remove window ${idx + 1}`}
                className="dp-btn-secondary text-sm disabled:opacity-40"
              >
                Remove
              </button>
            </div>

            {zeroLength && (
              <p className="type-caption-2 text-system-red">
                Window cannot be zero-length
              </p>
            )}
            {wrapsMidnight && (
              <p className="type-caption-2 text-label-tertiary">Ends next day</p>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addWindow}
        disabled={value.length >= MAX_WINDOWS}
        className="dp-btn-secondary text-sm disabled:opacity-40"
      >
        + Add window
      </button>
    </div>
  );
}
