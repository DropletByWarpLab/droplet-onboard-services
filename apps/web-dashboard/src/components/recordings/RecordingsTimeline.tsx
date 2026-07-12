"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RecordingDay, TimelineEntry } from "@/lib/types";

/** A range selected by the operator, expressed in seconds-since-midnight
 *  on the visible day. Resolution is minute-grained — the timeline
 *  caller computes the absolute Unix timestamp by pairing this with
 *  `day`. */
export interface TimelineSelection {
  startSec: number;
  endSec: number;
}

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
  /** Operator's drag selection over the timeline (minute-precision).
   *  null when nothing is selected. */
  selection?: TimelineSelection | null;
  onSelectionChange?: (next: TimelineSelection | null) => void;
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
  selection,
  onSelectionChange,
}: Props) {
  const dayEntry = useMemo(
    () => summary.find((d) => d.day === day) ?? null,
    [summary, day],
  );

  // ---------- Drag-to-select state ----------
  //
  // We track two things separately to keep clicks and drags from
  // fighting each other:
  //
  //   1. `dragOrigin` — set on pointerdown, cleared on pointerup. As
  //      long as movement stays under DRAG_THRESHOLD_PX we treat the
  //      gesture as a "potential click" and let the cell button's
  //      onClick handler fire naturally (no pointer capture, no
  //      preventDefault).
  //   2. `dragState` — set once movement crosses the threshold. From
  //      that point on the gesture is a drag: pointer capture goes
  //      live, the selection band tracks the cursor, and the cell
  //      button's click is suppressed.
  //
  // The selection mapping uses the grid's live bounding rect so a
  // window resize mid-render still picks the right second.
  const DRAG_THRESHOLD_PX = 4;
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragOriginRef = useRef<{ x: number; startSec: number; pointerId: number } | null>(null);
  const [dragState, setDragState] = useState<TimelineSelection | null>(null);

  const xToSec = (clientX: number): number | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const fraction = (clientX - rect.left) / rect.width;
    if (fraction < 0 || fraction > 1) return null;
    const sec = Math.round(fraction * 24 * 60 * 60);
    // Snap to the nearest minute — sub-minute precision would be jitter
    // for an operator dragging with a mouse.
    return Math.round(sec / 60) * 60;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onSelectionChange) return;
    if (e.button !== 0) return;
    const sec = xToSec(e.clientX);
    if (sec === null) return;
    dragOriginRef.current = {
      x: e.clientX,
      startSec: sec,
      pointerId: e.pointerId,
    };
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    const dx = Math.abs(e.clientX - origin.x);
    if (!dragState && dx < DRAG_THRESHOLD_PX) return;
    const sec = xToSec(e.clientX);
    if (sec === null) return;
    if (!dragState) {
      // Crossed the threshold — promote to a real drag.
      e.currentTarget.setPointerCapture(origin.pointerId);
      setDragState({ startSec: origin.startSec, endSec: sec });
      return;
    }
    setDragState({ startSec: origin.startSec, endSec: sec });
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    if (!dragState) return; // never crossed threshold → it was a click
    e.currentTarget.releasePointerCapture(e.pointerId);
    const startSec = Math.min(dragState.startSec, dragState.endSec);
    const endSec = Math.max(dragState.startSec, dragState.endSec);
    setDragState(null);
    if (!onSelectionChange || endSec - startSec < 60) return;
    onSelectionChange({ startSec, endSec });
    void origin; // referenced via closure capture above
  };

  // Esc clears an in-progress drag without committing it.
  useEffect(() => {
    if (!dragState) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setDragState(null);
        dragOriginRef.current = null;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragState]);

  const visibleSelection = dragState ?? selection ?? null;
  const selectionLeftFraction = visibleSelection
    ? Math.min(visibleSelection.startSec, visibleSelection.endSec) / (24 * 60 * 60)
    : null;
  const selectionWidthFraction = visibleSelection
    ? Math.abs(visibleSelection.endSec - visibleSelection.startSec) / (24 * 60 * 60)
    : null;

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
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="type-subheadline font-medium text-[color:var(--text)]">Timeline</h3>
        <span className="type-caption-2 text-[color:var(--text-muted)]">
          {dayEntry?.events ?? 0} event{(dayEntry?.events ?? 0) === 1 ? "" : "s"} ·{" "}
          {dayEntry ? `${Math.round(dayEntry.duration / 60)} min recorded` : "no recordings"}
        </span>
      </div>

      {/* Hour markers */}
      <div className="grid grid-cols-24 gap-px text-center mb-1">
        {hours.map((h) => (
          <div
            key={`mark-${h.hour}`}
            className="type-caption-2 text-[color:var(--text-faint)]"
          >
            {h.hour % 6 === 0 ? String(h.hour).padStart(2, "0") : ""}
          </div>
        ))}
      </div>

      {/* Hour cells. Tailwind doesn't ship grid-cols-24 by default — we
          fall back to inline-grid + a custom template via style.
          The grid is the drag surface; pointer handlers are scoped to
          the wrapper so hover-over-cell still routes to the cell button
          for keyboard accessibility. */}
      <div
        ref={gridRef}
        className="grid gap-px relative touch-none"
        style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDragState(null)}
      >
        {hours.map((h) => {
          const isSelected = selectedHour === h.hour;
          const dots = dotsByHour.get(h.hour) ?? [];
          // Map motion 0..100 to one of five brand-ramp buckets (var(--brand)
          // mixed into the track colour at increasing strength) so we get a
          // visible heat-map that stays on the indigo token ramp.
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
            "bg-[var(--inset)] hover:bg-[var(--hover)]",
            "bg-[color-mix(in_srgb,var(--brand)_15%,var(--inset))] hover:bg-[color-mix(in_srgb,var(--brand)_25%,var(--inset))]",
            "bg-[color-mix(in_srgb,var(--brand)_30%,var(--inset))] hover:bg-[color-mix(in_srgb,var(--brand)_40%,var(--inset))]",
            "bg-[color-mix(in_srgb,var(--brand)_55%,var(--inset))] hover:bg-[color-mix(in_srgb,var(--brand)_65%,var(--inset))]",
            "bg-[color-mix(in_srgb,var(--brand)_80%,var(--inset))] hover:bg-[color-mix(in_srgb,var(--brand)_90%,var(--inset))]",
          ][motionTier];
          return (
            <button
              key={`cell-${h.hour}`}
              onClick={() => onSelectHour(h.hour)}
              aria-pressed={isSelected}
              aria-label={`Hour ${h.hour}: ${h.events} events`}
              className={`relative h-12 rounded-sm transition-colors ${
                isSelected ? "ring-2 ring-[var(--brand)] z-10" : "ring-0"
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
              className="absolute top-0 bottom-0 w-0.5 pointer-events-none z-20"
              style={{
                left: `calc(${((selectedHour + playheadFraction) / 24) * 100}% - 1px)`,
                background: "var(--brand)",
              }}
            />
          )}

        {/* Selection band — operator's drag highlight. Lives above the
            cells so the accent fill reads against any motion shading
            below. Pointer-events-none so it doesn't capture move events
            mid-drag. */}
        {selectionLeftFraction !== null &&
          selectionWidthFraction !== null &&
          selectionWidthFraction > 0 && (
            <div
              className="absolute top-0 bottom-0 pointer-events-none z-15"
              style={{
                left: `${selectionLeftFraction * 100}%`,
                width: `${selectionWidthFraction * 100}%`,
                background: "color-mix(in srgb, var(--brand) 30%, transparent)",
                boxShadow: "0 0 0 2px var(--brand)",
              }}
            />
          )}
      </div>

      <p className="type-caption-1 mt-3 text-[color:var(--text-muted)]">
        Click an hour to jump to it. Drag across the timeline to select a
        precise range to export. Esc cancels an in-progress drag.
      </p>
    </div>
  );
}

/** Format a seconds-since-midnight value as HH:MM. Useful for the
 *  parent's selection chip. */
export function fmtSecOfDay(sec: number): string {
  const total = Math.max(0, Math.min(24 * 60 * 60, Math.round(sec)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
