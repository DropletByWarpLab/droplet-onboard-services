"use client";

import { useMemo } from "react";
import type { RecordingDay, TimelineEntry } from "@/lib/types";

interface Props {
  /** YYYY-MM-DD selected date — drives which row of the summary we render. */
  day: string;
  /** Per-camera summary returned by /recordings/summary. */
  summary: RecordingDay[];
  /** Timeline entries (object/zone transitions) for the visible day. */
  timeline: TimelineEntry[];
  /** Currently-selected hour [0, 23] — null = nothing picked yet. */
  selectedHour: number | null;
  /** Optional fine-grained playback position within the selected hour
   *  (0..1). Drives the orange playhead line. */
  playheadFraction?: number;
  onSelectHour: (hour: number) => void;
}

/**
 * Hour-bucket scrubber along the bottom of the Recordings page. Each
 * cell is one hour of the chosen day, coloured by motion intensity
 * (Frigate's per-hour motion summary 0–100). Cells with events get a
 * little count chip in the top-right corner. Clicking a cell snaps
 * the player to the start of that hour.
 *
 * Phase 3.1 deliberately keeps this hour-grained. Phase 3.2 will add
 * drag-to-select for sub-hour ranges + minute-resolution heat-map
 * underneath each hour cell.
 */
export function RecordingsTimeline({
  day,
  summary,
  timeline,
  selectedHour,
  playheadFraction,
  onSelectHour,
}: Props) {
  const dayEntry = useMemo(
    () => summary.find((d) => d.day === day) ?? null,
    [summary, day],
  );

  // Build a 24-slot array with the hour data merged in (or zeros).
  const hours = useMemo(() => {
    const slots: Array<{ hour: number; events: number; motion: number }> = [];
    for (let h = 0; h < 24; h++) {
      const found = dayEntry?.hours.find((x) => x.hour === h);
      slots.push({
        hour: h,
        events: found?.events ?? 0,
        motion: found?.motion ?? 0,
      });
    }
    return slots;
  }, [dayEntry]);

  // Group timeline entries into hour buckets so we can render one dot
  // per entry on the right cell. Reusing the same memo as the cells
  // would be tighter coupling than I want — separate scan is cheap.
  const dotsByHour = useMemo(() => {
    const map = new Map<number, TimelineEntry[]>();
    for (const t of timeline) {
      const d = new Date(t.timestamp * 1000);
      const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (localDay !== day) continue;
      const h = d.getHours();
      const bucket = map.get(h) ?? [];
      bucket.push(t);
      map.set(h, bucket);
    }
    return map;
  }, [timeline, day]);

  return (
    <div className="dp-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="type-subheadline text-label-primary font-medium">Timeline</h3>
        <span className="type-caption-2 text-label-tertiary">
          {dayEntry?.events ?? 0} event{(dayEntry?.events ?? 0) === 1 ? "" : "s"} ·{" "}
          {dayEntry ? `${Math.round(dayEntry.duration / 60)} min recorded` : "no recordings"}
        </span>
      </div>

      {/* Hour markers */}
      <div className="grid grid-cols-24 gap-px text-center mb-1">
        {hours.map((h) => (
          <div
            key={`mark-${h.hour}`}
            className="type-caption-2 text-label-quaternary"
          >
            {h.hour % 6 === 0 ? String(h.hour).padStart(2, "0") : ""}
          </div>
        ))}
      </div>

      {/* Hour cells. Tailwind doesn't ship grid-cols-24 by default — we
          fall back to inline-grid + a custom template via style. */}
      <div
        className="grid gap-px relative"
        style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
      >
        {hours.map((h) => {
          const isSelected = selectedHour === h.hour;
          const dots = dotsByHour.get(h.hour) ?? [];
          // Map motion 0..100 to one of five Tailwind opacity buckets so
          // we get a visible heat-map without needing to expose the
          // accent colour as an RGB triple in CSS variables.
          const motionTier =
            h.motion === 0
              ? 0
              : h.motion < 20
                ? 1
                : h.motion < 40
                  ? 2
                  : h.motion < 70
                    ? 3
                    : 4;
          const tierClass = [
            "bg-surface-secondary hover:bg-surface-tertiary",
            "bg-accent/15 hover:bg-accent/25",
            "bg-accent/30 hover:bg-accent/40",
            "bg-accent/55 hover:bg-accent/65",
            "bg-accent/80 hover:bg-accent/90",
          ][motionTier];
          return (
            <button
              key={`cell-${h.hour}`}
              onClick={() => onSelectHour(h.hour)}
              aria-pressed={isSelected}
              aria-label={`Hour ${h.hour}: ${h.events} events`}
              className={`relative h-12 rounded-sm transition-colors ${
                isSelected ? "ring-2 ring-accent z-10" : "ring-0"
              } ${tierClass} ${h.events > 0 || h.motion > 0 ? "cursor-pointer" : ""}`}
            >
              {/* Event count chip */}
              {h.events > 0 && (
                <span className="absolute top-0.5 right-0.5 type-caption-2 px-1 rounded bg-black/70 text-white">
                  {h.events}
                </span>
              )}
              {/* Activity dots — one per timeline entry, max 6 per cell. */}
              <div className="absolute bottom-0.5 left-0.5 right-0.5 flex flex-wrap gap-0.5">
                {dots.slice(0, 6).map((t, i) => (
                  <span
                    key={`${t.sourceId}-${i}`}
                    className="w-1 h-1 rounded-full bg-system-orange"
                    title={`${t.label || t.classType}${t.zone ? ` · ${t.zone}` : ""}`}
                  />
                ))}
              </div>
            </button>
          );
        })}

        {/* Playhead — vertical line over the selected hour's cell. */}
        {selectedHour !== null &&
          playheadFraction !== undefined &&
          playheadFraction >= 0 &&
          playheadFraction <= 1 && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-system-orange pointer-events-none z-20"
              style={{
                left: `calc(${((selectedHour + playheadFraction) / 24) * 100}% - 1px)`,
              }}
            />
          )}
      </div>

      <p className="type-caption-1 text-label-tertiary mt-3">
        Click an hour to jump to it. Each cell shades by motion intensity;
        orange dots mark detected activity.
      </p>
    </div>
  );
}
