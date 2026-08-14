"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordingDay, TimelineEntry } from "@/lib/types";

/** A range selected by the operator, expressed in seconds-since-midnight
 *  on the visible day. Resolution is minute-grained — the timeline
 *  caller computes the absolute Unix timestamp by pairing this with
 *  `day`. */
export interface TimelineSelection {
  startSec: number;
  endSec: number;
}

const HOURS_IN_DAY = 24;
const SEC_IN_DAY = HOURS_IN_DAY * 60 * 60;
const SEC_IN_HOUR = 60 * 60;

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
   *  (0..1). Drives the playhead. */
  playheadFraction?: number;
  onSelectHour: (hour: number) => void;
  /** Operator's drag selection over the timeline (minute-precision).
   *  null when nothing is selected. */
  selection?: TimelineSelection | null;
  onSelectionChange?: (next: TimelineSelection | null) => void;
  /**
   * Move playback to a point in the day, seconds-since-midnight.
   *
   * Dragging used to feed ONLY the Nextcloud export button — the gesture
   * that most obviously means "take me here" did not move the video at
   * all (WARP-1959).
   */
  onScrubTo?: (secOfDay: number) => void;
  /** Seconds-since-midnight of "now", when `day` is today. `null` on any
   *  past day, which is what greys out the not-yet-happened hours. */
  nowSecOfDay?: number | null;
  /** Oldest day (YYYY-MM-DD) still inside this camera's retention, when
   *  known. Lets an empty morning read as "outside retention" rather than
   *  "broken". */
  retentionOldestDay?: string | null;
}

/** A single hour bucket, ready to render. */
interface HourSlot {
  hour: number;
  events: number;
  /** Seconds of footage retained in this hour, 0…3600. */
  duration: number;
  /** Raw, unbounded motion activity count from Frigate. */
  motion: number;
  objects: number;
  /** 0…1 — how much of the hour has footage. THE primary encoding. */
  coverage: number;
  /** True once this hour is entirely in the future. */
  future: boolean;
}

/** Format seconds-since-midnight as HH:MM. Exported for the parent's chip. */
export function fmtSecOfDay(sec: number): string {
  const total = Math.max(0, Math.min(SEC_IN_DAY, Math.round(sec)));
  const h = Math.floor(total / SEC_IN_HOUR);
  const m = Math.floor((total % SEC_IN_HOUR) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "1 h 04 m" / "9 m" — how much footage an hour actually holds. */
function fmtCoverage(sec: number): string {
  const m = Math.round(sec / 60);
  if (m <= 0) return "no footage";
  if (m >= 60) return "full hour";
  return `${m} min`;
}

/**
 * Hour-bucket scrubber under the Recordings player.
 *
 * ## What it encodes, and why that changed
 *
 * The previous version coloured each hour by Frigate's `motion` score and
 * nothing else. `duration` — the one field that means *there is footage
 * here* — was fetched, normalised, and then thrown away.
 *
 * That made an hour holding a full 3600 s of continuous recording over a
 * quiet scene **pixel-identical to an hour with nothing on disk**. On the
 * production box, hours 05:00–12:00 held 3586 s each with `motion: 0` and
 * rendered as empty grey. Asked what was wrong, the honest answer from the
 * screen was "the cameras aren't recording" — which is exactly what got
 * reported (WARP-1959).
 *
 * So: **coverage is the base layer**, drawn as a filled bar whose height is
 * the fraction of the hour retained. Motion rides on top as discrete blips,
 * events as a count chip. Colour is never the only channel — a covered hour
 * differs from an empty one in fill height, border and label, so it reads
 * without relying on hue.
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
  onScrubTo,
  nowSecOfDay = null,
  retentionOldestDay = null,
}: Props) {
  const dayEntry = useMemo(
    () => summary.find((d) => d.day === day) ?? null,
    [summary, day],
  );

  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragOriginRef = useRef<{ x: number; startSec: number; pointerId: number } | null>(
    null,
  );
  const [dragState, setDragState] = useState<TimelineSelection | null>(null);
  const DRAG_THRESHOLD_PX = 4;

  // ---------- Buckets ----------
  const hours: HourSlot[] = useMemo(() => {
    const slots: HourSlot[] = [];
    for (let h = 0; h < HOURS_IN_DAY; h++) {
      const found = dayEntry?.hours.find((x) => x.hour === h);
      const duration = found?.duration ?? 0;
      slots.push({
        hour: h,
        events: found?.events ?? 0,
        duration,
        motion: found?.motion ?? 0,
        objects: found?.objects ?? 0,
        // Clamped: Frigate occasionally reports a hair over 3600 across a
        // segment boundary, and a >100% bar looks like a bug.
        coverage: Math.max(0, Math.min(1, duration / SEC_IN_HOUR)),
        future: nowSecOfDay !== null && h * SEC_IN_HOUR >= nowSecOfDay,
      });
    }
    return slots;
  }, [dayEntry, nowSecOfDay]);

  /**
   * Motion is an UNBOUNDED activity count, not a percentage — one real day
   * on the box read 11, 3, 954, 160, 0, 774 across consecutive hours. Scale
   * against the day's own maximum so a quiet day still shows contrast and a
   * busy one doesn't saturate. (The old code clamped to 0–100, which put
   * 954, 774 and 160 in the same tier.)
   */
  const motionMax = useMemo(
    () => Math.max(1, ...hours.map((h) => h.motion)),
    [hours],
  );

  const totalFootageSec = useMemo(
    () => hours.reduce((n, h) => n + h.duration, 0),
    [hours],
  );
  const coveredHours = useMemo(() => hours.filter((h) => h.duration > 0).length, [hours]);

  // ---------- Geometry ----------
  const xToSec = useCallback((clientX: number): number | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const fraction = (clientX - rect.left) / rect.width;
    if (fraction < 0 || fraction > 1) return null;
    const sec = Math.round(fraction * SEC_IN_DAY);
    // Snap to the minute — sub-minute precision is jitter with a mouse.
    return Math.round(sec / 60) * 60;
  }, []);

  /** Never let the operator scrub into a time that hasn't happened. */
  const clampToNow = useCallback(
    (sec: number) => (nowSecOfDay === null ? sec : Math.min(sec, nowSecOfDay)),
    [nowSecOfDay],
  );

  // ---------- Pointer: click to jump, drag to select ----------
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const sec = xToSec(e.clientX);
    if (sec === null) return;
    dragOriginRef.current = { x: e.clientX, startSec: sec, pointerId: e.pointerId };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    const dx = Math.abs(e.clientX - origin.x);
    if (!dragState && dx < DRAG_THRESHOLD_PX) return;
    const sec = xToSec(e.clientX);
    if (sec === null) return;
    if (!dragState) {
      e.currentTarget.setPointerCapture(origin.pointerId);
    }
    setDragState({ startSec: origin.startSec, endSec: sec });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;

    if (!dragState) {
      // A click, not a drag: jump playback to that exact second.
      if (origin) {
        const target = clampToNow(origin.startSec);
        onSelectHour(Math.floor(target / SEC_IN_HOUR));
        onScrubTo?.(target);
      }
      return;
    }

    e.currentTarget.releasePointerCapture(e.pointerId);
    const startSec = clampToNow(Math.min(dragState.startSec, dragState.endSec));
    const endSec = clampToNow(Math.max(dragState.startSec, dragState.endSec));
    setDragState(null);
    if (endSec - startSec < 60) return;

    onSelectionChange?.({ startSec, endSec });
    // A drag means "take me here" as much as "export this". Move playback
    // to the start of the range too — the old build only wired the export.
    onSelectHour(Math.floor(startSec / SEC_IN_HOUR));
    onScrubTo?.(startSec);
  };

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

  // ---------- Keyboard scrubbing ----------
  //
  // One focusable widget, not 24 tab stops. Arrow keys step an hour,
  // shift-arrow jumps six, Home/End go to the ends of the available day.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const lastHour =
      nowSecOfDay === null ? 23 : Math.min(23, Math.floor(nowSecOfDay / SEC_IN_HOUR));
    const current = selectedHour ?? lastHour;
    let next: number | null = null;

    if (e.key === "ArrowLeft") next = current - (e.shiftKey ? 6 : 1);
    else if (e.key === "ArrowRight") next = current + (e.shiftKey ? 6 : 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = lastHour;
    if (next === null) return;

    e.preventDefault();
    const clamped = Math.max(0, Math.min(lastHour, next));
    onSelectHour(clamped);
    onScrubTo?.(clamped * SEC_IN_HOUR);
  };

  // ---------- Overlays ----------
  const visibleSelection = dragState ?? selection ?? null;
  const selLeft = visibleSelection
    ? Math.min(visibleSelection.startSec, visibleSelection.endSec) / SEC_IN_DAY
    : null;
  const selWidth = visibleSelection
    ? Math.abs(visibleSelection.endSec - visibleSelection.startSec) / SEC_IN_DAY
    : null;

  /**
   * Motion blips, positioned by their real timestamp.
   *
   * The old build bucketed these with `d.getHours()` while the cells came
   * from a UTC-keyed summary — two clocks on one graphic. Everything here
   * is seconds-since-midnight in the operator's own zone.
   */
  const blips = useMemo(() => {
    const out: Array<{ key: string; leftFraction: number; label: string }> = [];
    for (const t of timeline) {
      const d = new Date(t.timestamp * 1000);
      const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (localDay !== day) continue;
      const sec = d.getHours() * SEC_IN_HOUR + d.getMinutes() * 60 + d.getSeconds();
      out.push({
        key: `${t.sourceId}-${t.timestamp}`,
        leftFraction: sec / SEC_IN_DAY,
        label: `${t.label || t.classType}${t.zone ? ` · ${t.zone}` : ""} at ${fmtSecOfDay(sec)}`,
      });
    }
    return out;
  }, [timeline, day]);

  const playheadLeft =
    selectedHour !== null &&
    playheadFraction !== undefined &&
    playheadFraction >= 0 &&
    playheadFraction <= 1
      ? ((selectedHour + playheadFraction) / HOURS_IN_DAY) * 100
      : null;

  const nowLeft =
    nowSecOfDay === null ? null : (nowSecOfDay / SEC_IN_DAY) * 100;

  const outsideRetention = Boolean(
    retentionOldestDay && day < retentionOldestDay,
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h3 className="type-subheadline font-medium text-[color:var(--text)]">Timeline</h3>
        <span className="type-caption-2 text-[color:var(--text-muted)]">
          {coveredHours === 0 ? (
            outsideRetention ? (
              <>Outside this camera&apos;s retention window</>
            ) : (
              <>No footage kept on this day</>
            )
          ) : (
            <>
              {Math.round(totalFootageSec / 60)} min of footage across {coveredHours}{" "}
              {coveredHours === 1 ? "hour" : "hours"}
              {dayEntry?.events ? ` · ${dayEntry.events} events` : ""}
            </>
          )}
        </span>
      </div>

      {/* Horizontal scroll on narrow screens: 24 cells across a 375px phone
          is a 13px target. The strip keeps a minimum width so each hour
          stays tappable, and the container scrolls instead of shrinking. */}
      <div className="overflow-x-auto -mx-1 px-1">
        <div style={{ minWidth: 24 * 44 }}>
          {/* Hour axis. Uses the SAME inline template as the cells — the old
              build used a `grid-cols-24` class, which Tailwind 3 does not
              ship and nothing defined, so the labels collapsed into one
              column and never sat over their hours. */}
          <div
            className="grid text-center mb-1 select-none"
            style={{ gridTemplateColumns: `repeat(${HOURS_IN_DAY}, minmax(0, 1fr))` }}
            aria-hidden="true"
          >
            {hours.map((h) => (
              <div
                key={`mark-${h.hour}`}
                className="type-caption-2 text-[color:var(--text-faint)]"
              >
                {h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : "·"}
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            role="slider"
            tabIndex={0}
            aria-label="Recording timeline — arrow keys move through the day"
            aria-valuemin={0}
            aria-valuemax={23}
            aria-valuenow={selectedHour ?? undefined}
            aria-valuetext={
              selectedHour === null
                ? "No hour selected"
                : `${String(selectedHour).padStart(2, "0")}:00, ${fmtCoverage(hours[selectedHour].duration)}`
            }
            onKeyDown={handleKeyDown}
            className="grid gap-px relative touch-none rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            style={{ gridTemplateColumns: `repeat(${HOURS_IN_DAY}, minmax(0, 1fr))` }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setDragState(null)}
          >
            {hours.map((h) => {
              const isSelected = selectedHour === h.hour;
              const hasFootage = h.duration > 0;
              const motionFraction = h.motion / motionMax;

              return (
                <div
                  key={`cell-${h.hour}`}
                  data-testid={`hour-cell-${h.hour}`}
                  data-has-footage={hasFootage ? "true" : "false"}
                  data-coverage={h.coverage.toFixed(3)}
                  data-future={h.future ? "true" : "false"}
                  aria-label={
                    h.future
                      ? `Hour ${h.hour}: not yet`
                      : `Hour ${h.hour}: ${fmtCoverage(h.duration)}${
                          h.events > 0 ? `, ${h.events} events` : ""
                        }`
                  }
                  title={
                    h.future
                      ? `${String(h.hour).padStart(2, "0")}:00 — hasn't happened yet`
                      : `${String(h.hour).padStart(2, "0")}:00 — ${fmtCoverage(h.duration)}${
                          h.events > 0 ? `, ${h.events} events` : ""
                        }`
                  }
                  className={`relative h-14 overflow-hidden rounded-sm transition-colors ${
                    isSelected ? "ring-2 ring-[var(--brand)] z-10" : ""
                  } ${h.future ? "opacity-40" : hasFootage ? "cursor-pointer" : ""}`}
                  style={{
                    // The empty state is a visibly different SURFACE, not
                    // just a paler colour — so "no footage" survives a
                    // colour-blind reader and a bad monitor.
                    background: h.future
                      ? "repeating-linear-gradient(45deg, var(--inset) 0 4px, transparent 4px 8px)"
                      : "var(--inset)",
                    border: hasFootage
                      ? "1px solid color-mix(in srgb, var(--brand) 35%, transparent)"
                      : "1px dashed var(--border)",
                  }}
                >
                  {/* COVERAGE — the primary encoding. Height is the share of
                      the hour actually retained. */}
                  {hasFootage && (
                    <div
                      data-testid={`coverage-fill-${h.hour}`}
                      className="absolute inset-x-0 bottom-0 pointer-events-none"
                      style={{
                        height: `${Math.max(8, h.coverage * 100)}%`,
                        background: "color-mix(in srgb, var(--brand) 45%, var(--inset))",
                      }}
                    />
                  )}

                  {/* MOTION — rides ON the coverage, never replaces it. */}
                  {h.motion > 0 && (
                    <div
                      data-testid={`motion-band-${h.hour}`}
                      className="absolute inset-x-0 bottom-0 pointer-events-none"
                      style={{
                        height: `${Math.max(6, motionFraction * 46)}%`,
                        background: "color-mix(in srgb, var(--brand) 85%, transparent)",
                      }}
                    />
                  )}

                  {h.events > 0 && (
                    <span className="absolute top-0.5 right-0.5 type-caption-2 px-1 rounded bg-black/70 text-white pointer-events-none">
                      {h.events}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Motion blips, positioned by real timestamp across the strip. */}
            {blips.map((b) => (
              <span
                key={b.key}
                data-testid="motion-blip"
                title={b.label}
                className="absolute w-1 h-1 rounded-full bg-system-orange pointer-events-none z-20"
                style={{ left: `calc(${b.leftFraction * 100}% - 2px)`, bottom: 4 }}
              />
            ))}

            {/* "Now" marker — the boundary between recorded and not-yet. */}
            {nowLeft !== null && (
              <div
                data-testid="now-marker"
                className="absolute top-0 bottom-0 w-px pointer-events-none z-30"
                style={{ left: `${nowLeft}%`, background: "var(--text-muted)" }}
                title="Now"
              />
            )}

            {/* Playhead. */}
            {playheadLeft !== null && (
              <div
                data-testid="playhead"
                className="absolute top-0 bottom-0 w-0.5 pointer-events-none z-30"
                style={{ left: `calc(${playheadLeft}% - 1px)`, background: "var(--brand)" }}
              />
            )}

            {/* Drag selection. `zIndex` inline: `z-15` is not a Tailwind
                class and silently did nothing in the previous build. */}
            {selLeft !== null && selWidth !== null && selWidth > 0 && (
              <div
                data-testid="selection-band"
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: `${selLeft * 100}%`,
                  width: `${selWidth * 100}%`,
                  zIndex: 25,
                  background: "color-mix(in srgb, var(--brand) 25%, transparent)",
                  boxShadow: "0 0 0 2px var(--brand)",
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Legend — the graphic explains itself rather than needing a manual. */}
      <div className="flex items-center gap-4 mt-3 flex-wrap type-caption-2 text-[color:var(--text-muted)]">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{
              background: "color-mix(in srgb, var(--brand) 45%, var(--inset))",
              border: "1px solid color-mix(in srgb, var(--brand) 35%, transparent)",
            }}
          />
          Footage kept
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ background: "var(--inset)", border: "1px dashed var(--border)" }}
          />
          Nothing kept
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-system-orange" />
          Motion
        </span>
      </div>

      <p className="type-caption-1 mt-2 text-[color:var(--text-muted)]">
        Click to jump there. Drag to pick a range to export — playback follows.
        Arrow keys move an hour, Shift+arrow six. Esc cancels a drag.
      </p>
    </div>
  );
}
