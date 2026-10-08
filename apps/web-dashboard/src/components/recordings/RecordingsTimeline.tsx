"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import type { RecordingDay, RecordingSegment, TimelineEntry } from "@/lib/types";

export interface TimelineSelection { startSec: number; endSec: number }
const SEC_IN_DAY = 86400;
const MIN_VIEW = 5 * 60;
const TICK_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, SEC_IN_DAY];
interface Viewport { start: number; span: number }

interface Props {
  day: string;
  summary: RecordingDay[];
  timeline: TimelineEntry[];
  /** Exact segments for the day. Positions use elapsed seconds from local midnight. */
  recordings?: RecordingSegment[];
  selectedHour: number | null;
  playheadFraction?: number;
  playheadSec?: number;
  onSelectHour: (hour: number) => void;
  selection?: TimelineSelection | null;
  onSelectionChange?: (next: TimelineSelection | null) => void;
  onScrubTo?: (secOfDay: number) => void;
  /** Open an event's clip instead of seeking the continuous archive. */
  onSelectEvent?: (entry: TimelineEntry) => void;
  selectedEventId?: string | null;
  /** Camera playback scrolls through time; the archive retains scroll-to-zoom. */
  wheelMode?: "zoom" | "pan";
  /** Initial/day-change zoom. Omit to retain the archive's whole-day view. */
  initialSpanSec?: number;
  /** Center an explicit seek request, retaining the user's current zoom. */
  focusSec?: number | null;
  /** Change this to repeat a seek request at the same timestamp. */
  focusKey?: number | string;
  nowSecOfDay?: number | null;
  retentionOldestDay?: string | null;
}

export function fmtSecOfDay(sec: number): string {
  const total = Math.max(0, Math.min(SEC_IN_DAY, Math.round(sec)));
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor(total % 3600 / 60)).padStart(2, "0")}`;
}
function fmtCoverage(sec: number) {
  const minutes = Math.round(sec / 60);
  return minutes <= 0 ? "no footage" : minutes >= 60 ? "full hour" : `${minutes} min`;
}
function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 0.25) previous.end = Math.max(previous.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/** Keeps the time under the cursor fixed as the ruler zooms. */
export function zoomTimelineViewport(view: Viewport, factor: number, anchor: number, daySeconds = SEC_IN_DAY): Viewport {
  const span = Math.max(MIN_VIEW, Math.min(daySeconds, view.span * factor));
  const ratio = Math.max(0, Math.min(1, anchor));
  return { start: Math.max(0, Math.min(daySeconds - span, view.start + ratio * (view.span - span))), span };
}

export function RecordingsTimeline({ day, summary, timeline, recordings, selectedHour,
  playheadFraction, playheadSec, onSelectHour, selection, onSelectionChange, onScrubTo,
  onSelectEvent, selectedEventId = null, wheelMode = "zoom", initialSpanSec, focusSec, focusKey,
  nowSecOfDay = null, retentionOldestDay = null }: Props) {
  const [year, month, date] = day.split("-").map(Number);
  const dayStart = new Date(year, month - 1, date).getTime() / 1000;
  const daySeconds = new Date(year, month - 1, date + 1).getTime() / 1000 - dayStart;
  const formatRuler = (sec: number) => {
    if (sec === daySeconds) return "24:00";
    const local = new Date((dayStart + sec) * 1000);
    return `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  };
  const selectedEvent = selectedEventId === null ? undefined : timeline.find((event) => event.sourceId === selectedEventId && event.timestamp >= dayStart && event.timestamp < dayStart + daySeconds);
  const focusTarget = focusSec ?? (selectedEvent ? selectedEvent.timestamp - dayStart : null);
  const initialSpan = Math.max(MIN_VIEW, Math.min(daySeconds, initialSpanSec ?? daySeconds));
  const [view, setView] = useState<Viewport>(() => ({ start: focusTarget === null ? 0 : Math.max(0, Math.min(daySeconds - initialSpan, focusTarget - initialSpan / 2)), span: initialSpan }));
  const [drag, setDrag] = useState<TimelineSelection | null>(null);
  const [rulerWidth, setRulerWidth] = useState(1000);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const originRef = useRef<{ x: number; sec: number; pointerId: number; view: Viewport; width: number; moved: boolean } | null>(null);
  const dragRef = useRef<TimelineSelection | null>(null);
  const previousViewConfig = useRef({ day, daySeconds, initialSpan });
  useEffect(() => {
    const ruler = gridRef.current;
    if (!ruler) return;
    const measure = (width: number) => { if (width > 0) setRulerWidth(width); };
    measure(ruler.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) measure(entry.contentRect.width); });
    observer.observe(ruler);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const previous = previousViewConfig.current;
    const reset = previous.day !== day || previous.daySeconds !== daySeconds || previous.initialSpan !== initialSpan;
    previousViewConfig.current = { day, daySeconds, initialSpan };
    setView((current) => {
      const span = reset ? initialSpan : current.span;
      const start = focusTarget === null ? reset ? 0 : current.start : Math.max(0, Math.min(daySeconds - span, focusTarget - span / 2));
      return current.start === start && current.span === span ? current : { start, span };
    });
    setDrag(null); originRef.current = null; dragRef.current = null;
  }, [day, daySeconds, initialSpan, focusTarget, focusKey, selectedEventId]);

  const entry = summary.find((d) => d.day === day);
  const hours = useMemo(() => Array.from({ length: 24 }, (_, hour) => {
    const found = entry?.hours.find((h) => h.hour === hour);
    const duration = found?.duration ?? 0;
    return { hour, duration, coverage: Math.min(1, Math.max(0, duration / 3600)),
      motion: found?.motion ?? 0, events: found?.events ?? 0,
      start: new Date(year, month - 1, date, hour).getTime() / 1000 - dayStart,
      end: new Date(year, month - 1, date, hour + 1).getTime() / 1000 - dayStart,
      future: nowSecOfDay !== null && new Date(year, month - 1, date, hour).getTime() / 1000 - dayStart >= nowSecOfDay };
  }), [entry, nowSecOfDay, dayStart, year, month, date]);
  const coveredHours = hours.filter((h) => h.duration > 0).length;
  const totalFootage = recordings === undefined ? hours.reduce((n, h) => n + h.duration, 0)
    : recordings.reduce((n, s) => n + Math.max(0, Math.min(dayStart + daySeconds, s.endTime) - Math.max(dayStart, s.startTime)), 0);
  const motionMax = Math.max(1, ...hours.map((h) => h.motion));
  const currentSec = playheadSec ?? (selectedHour === null ? null : hours[selectedHour].start + (playheadFraction ?? 0) * 3600);
  const maxSec = Math.min(daySeconds - 1, nowSecOfDay ?? daySeconds - 1);
  const left = (sec: number) => (sec - view.start) / view.span * 100;
  const width = (start: number, end: number) => (end - start) / view.span * 100;
  const visible = (start: number, end: number) => end > view.start && start < view.start + view.span;
  const clamp = (sec: number) => Math.max(0, Math.min(maxSec, sec));
  const jump = (sec: number) => { const target = clamp(sec); onSelectHour(new Date((dayStart + target) * 1000).getHours()); onScrubTo?.(target); };
  const xToSec = useCallback((x: number) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    const fraction = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    const snap = view.span <= 3600 ? 1 : 60;
    return Math.round((view.start + fraction * view.span) / snap) * snap;
  }, [view]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    function wheel(e: WheelEvent) {
      e.preventDefault();
      const rect = grid!.getBoundingClientRect();
      if (!rect.width) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      if (wheelMode === "pan" && !e.ctrlKey && !e.metaKey) {
        // WheelEvent deltas may be pixels, lines, or pages. Keep trackpads smooth.
        const pixels = delta * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.width : 1);
        setView((v) => ({ ...v, start: Math.max(0, Math.min(daySeconds - v.span, v.start + pixels / rect.width * v.span)) }));
      } else if (wheelMode === "zoom" && e.shiftKey) {
        setView((v) => ({ ...v, start: Math.max(0, Math.min(daySeconds - v.span, v.start + Math.sign(delta) * v.span / 8)) }));
      } else setView((v) => zoomTimelineViewport(v, delta < 0 ? 0.75 : 4 / 3, (e.clientX - rect.left) / rect.width, daySeconds));
    }
    grid.addEventListener("wheel", wheel, { passive: false });
    return () => grid.removeEventListener("wheel", wheel);
  }, [daySeconds, wheelMode]);

  const tickStep = TICK_STEPS.find((step) => step / view.span * rulerWidth >= 70) ?? SEC_IN_DAY;
  const ticks = [];
  for (let sec = Math.ceil(view.start / tickStep) * tickStep; sec <= view.start + view.span; sec += tickStep) ticks.push(sec);
  const events = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    const after = new Date(y, m - 1, d).getTime() / 1000, before = new Date(y, m - 1, d + 1).getTime() / 1000;
    return timeline.filter((t) => t.timestamp >= after && t.timestamp < before).map((entry) => ({ entry, sec: entry.timestamp - after }));
  }, [timeline, day]);
  const ranges = useMemo(() => recordings?.map((s) => ({ ...s, start: Math.max(0, s.startTime - dayStart), end: Math.min(daySeconds, s.endTime - dayStart) })).filter((s) => s.end > s.start), [recordings, dayStart, daySeconds]);
  const recordedRanges = useMemo(() => ranges === undefined ? undefined : mergeRanges(ranges), [ranges]);
  const motionRanges = useMemo(() => ranges === undefined ? [] : mergeRanges(ranges.filter((s) => s.motion > 0)), [ranges]);
  const selectionView = drag ?? selection;
  const selectionStart = selectionView ? Math.min(selectionView.startSec, selectionView.endSec) : 0;
  const selectionEnd = selectionView ? Math.max(selectionView.startSec, selectionView.endSec) : 0;
  const pan = (direction: number) => setView((v) => ({ ...v, start: Math.max(0, Math.min(daySeconds - v.span, v.start + direction * v.span / 2)) }));
  const zoom = (factor: number) => setView((v) => zoomTimelineViewport(v, factor, currentSec === null ? 0.5 : (currentSec - v.start) / v.span, daySeconds));

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div><h3 className="type-subheadline font-medium text-[color:var(--text)]">Timeline</h3>
          <span className="type-caption-2 text-[color:var(--text-muted)]">
            {totalFootage === 0 ? retentionOldestDay && day < retentionOldestDay ? "Outside this camera's retention window" : "No footage kept on this day"
              : recordings === undefined ? `${Math.round(totalFootage / 60)} min of footage across ${coveredHours} ${coveredHours === 1 ? "hour" : "hours"}${entry?.events ? ` · ${entry.events} events` : ""}`
                : `${Math.round(totalFootage / 60)} min of footage${entry?.events ? ` · ${entry.events} events` : ""}`}
          </span></div>
        <div className="flex items-center gap-1 flex-wrap min-w-0">
          <button type="button" className="icon-btn" aria-label="Pan earlier" disabled={view.start === 0} onClick={() => pan(-1)}><ChevronLeft size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Zoom out timeline" disabled={view.span === daySeconds} onClick={() => zoom(2)}><Minus size={15} /></button>
          <span className="type-caption-2 font-mono min-w-16 text-center" data-testid="timeline-scale">{view.span >= 3600 ? `${Math.round(view.span / 3600 * 10) / 10} h` : `${Math.round(view.span / 60)} min`}</span>
          <button type="button" className="icon-btn" aria-label="Zoom in timeline" disabled={view.span === MIN_VIEW} onClick={() => zoom(0.5)}><Plus size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Pan later" disabled={view.start + view.span === daySeconds} onClick={() => pan(1)}><ChevronRight size={15} /></button>
          <button type="button" className="btn ghost sm" onClick={() => setView({ start: 0, span: daySeconds })}>Whole day</button>
        </div>
      </div>
      <div className="flex gap-3">
        <div className="w-16 shrink-0 pt-7 type-caption-2 text-[color:var(--text-muted)]" aria-hidden="true"><div className="h-8 flex items-center">Recorded</div><div className="h-8 flex items-center">Motion</div><div className="h-8 flex items-center">Events</div></div>
        <div ref={gridRef} role="group" aria-label="Recording timeline"
          data-testid="timeline-ruler" data-view-start={view.start} data-view-span={view.span}
          className="relative flex-1 min-w-0 h-32 touch-none overflow-hidden rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]" style={{ background: "var(--inset)" }}
          onKeyDown={(e) => {
            if ((e.target as HTMLElement).getAttribute("role") !== "slider") return;
            if (e.key === "Escape") { originRef.current = null; dragRef.current = null; setDrag(null); return; }
            const current = Math.floor((currentSec ?? maxSec) / 3600); let target: number | null = null;
            if (e.key === "Home") target = 0;
            else if (e.key === "End") target = Math.floor(maxSec / 3600) * 3600;
            else if (e.key === "ArrowLeft") target = (current - (e.shiftKey ? 6 : 1)) * 3600;
            else if (e.key === "ArrowRight") target = Math.min(Math.floor(maxSec / 3600), current + (e.shiftKey ? 6 : 1)) * 3600;
            else if (e.key === "+" || e.key === "=") zoom(0.5);
            else if (e.key === "-") zoom(2);
            else return;
            e.preventDefault(); if (target !== null) jump(target);
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragRef.current = null;
            const sec = xToSec(e.clientX), rect = gridRef.current?.getBoundingClientRect();
            if (sec === null || !rect?.width) return;
            originRef.current = { x: e.clientX, sec, pointerId: e.pointerId, view, width: rect.width, moved: false };
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            const origin = originRef.current;
            if (!origin || origin.pointerId !== e.pointerId || (!origin.moved && Math.abs(e.clientX - origin.x) < 4)) return;
            origin.moved = true;
            if (!onSelectionChange) {
              setView({ ...origin.view, start: Math.max(0, Math.min(daySeconds - origin.view.span, origin.view.start - (e.clientX - origin.x) / origin.width * origin.view.span)) });
              return;
            }
            const sec = xToSec(e.clientX); if (sec === null) return;
            const next = { startSec: clamp(origin.sec), endSec: clamp(sec) }; dragRef.current = next; setDrag(next);
          }}
          onPointerUp={(e) => {
            const origin = originRef.current; if (!origin || origin.pointerId !== e.pointerId) return; originRef.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId);
            const range = dragRef.current; dragRef.current = null; setDrag(null);
            if (origin.moved && !onSelectionChange) return;
            if (!range) { jump(origin.sec); return; }
            const startSec = Math.min(range.startSec, range.endSec), endSec = Math.max(range.startSec, range.endSec);
            if (endSec - startSec >= 1) onSelectionChange?.({ startSec, endSec }); jump(startSec);
          }}
          onPointerCancel={() => { originRef.current = null; dragRef.current = null; setDrag(null); }}>
          <div role="slider" tabIndex={0} aria-label="Recording timeline — arrow keys move through the day"
            aria-valuemin={0} aria-valuemax={maxSec} aria-valuenow={currentSec ?? undefined}
            aria-valuetext={currentSec === null ? "No time selected" : formatRuler(currentSec)}
            className="absolute inset-0 pointer-events-none rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)]" />
          <div data-testid="time-axis" className="absolute inset-x-0 top-0 h-7 border-b border-[var(--border)] pointer-events-none">
            {ticks.map((sec) => {
              const position = left(sec) / 100 * rulerWidth;
              const transform = position < 24 ? "none" : position > rulerWidth - 24 ? "translateX(-100%)" : "translateX(-50%)";
              return <span key={sec} className="absolute top-0" style={{ left: `${left(sec)}%` }}>
                <span data-testid="time-tick-label" title={new Date((dayStart + sec) * 1000).toLocaleTimeString([], { timeZoneName: "short" })} className="absolute whitespace-nowrap type-caption-2 text-[color:var(--text-muted)] font-mono" style={{ transform }}>{formatRuler(sec)}</span>
                <span className="absolute top-4 h-2 w-px bg-[var(--border)]" />
              </span>;
            })}
          </div>
          {hours.filter((h) => visible(h.start, h.end)).map((h) => (
            <div key={h.hour} data-testid={`hour-cell-${h.hour}`} data-has-footage={h.duration > 0 ? "true" : "false"} data-coverage={h.coverage.toFixed(3)} data-future={h.future ? "true" : "false"}
              aria-label={h.future ? `Hour ${h.hour}: not yet` : `Hour ${h.hour}: ${fmtCoverage(h.duration)}${h.events ? `, ${h.events} events` : ""}`}
              title={`${fmtSecOfDay(h.hour * 3600)} · ${h.future ? "not yet" : fmtCoverage(h.duration)}`}
              className="absolute top-7 h-8 pointer-events-none" style={{ left: `${left(h.start)}%`, width: `${width(h.start, h.end)}%`, opacity: h.future ? 0.3 : 1, border: h.duration > 0 ? "1px solid var(--border)" : "1px dashed var(--border)" }}>
              {ranges === undefined && h.duration > 0 && <div data-testid={`coverage-fill-${h.hour}`} className="absolute inset-x-0 bottom-0 bg-[var(--brand)] opacity-60" style={{ height: `${Math.max(8, h.coverage * 100)}%` }} />}
            </div>
          ))}
          <div className="absolute inset-x-0 top-[60px] h-8 border-y border-[var(--border)] pointer-events-none" />
          {ranges === undefined ? hours.filter((h) => h.motion > 0 && visible(h.start, h.end)).map((h) => (
            <div key={h.hour} data-testid={`motion-band-${h.hour}`} className="absolute top-[60px] bg-system-orange opacity-70 pointer-events-none" style={{ left: `${left(h.start)}%`, width: `${width(h.start, h.end)}%`, height: `${Math.max(6, h.motion / motionMax * 20)}%` }} />
          )) : recordedRanges?.filter((s) => visible(s.start, s.end)).map((s) => <span key={s.start} data-testid="recorded-segment" title={`Recorded ${formatRuler(s.start)} – ${formatRuler(s.end)}`} className="absolute top-8 h-6 bg-[var(--brand)] opacity-70 pointer-events-none" style={{ left: `${left(s.start)}%`, width: `${width(s.start, s.end)}%`, minWidth: 1 }} />)}
          {motionRanges.filter((s) => visible(s.start, s.end)).map((s) => <span key={s.start} data-testid="motion-segment" className="absolute top-[68px] h-4 bg-system-orange pointer-events-none" style={{ left: `${left(s.start)}%`, width: `${width(s.start, s.end)}%`, minWidth: 2 }} />)}
          {events.filter((t) => visible(t.sec, t.sec + 1)).map(({ entry: event, sec }, i) => <button key={`${event.sourceId}-${event.timestamp}-${i}`} type="button" data-testid="motion-blip"
            aria-label={`${event.label || event.classType} at ${formatRuler(sec)}`} aria-pressed={selectedEventId === event.sourceId}
            title={`${event.label || event.classType}${event.zone ? ` · ${event.zone}` : ""} · ${new Date(event.timestamp * 1000).toLocaleTimeString([], { timeZoneName: "short" })}`}
            className={`absolute top-[102px] w-2 h-4 rounded-sm bg-system-orange z-20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] ${selectedEventId === event.sourceId ? "ring-2 ring-[var(--brand)] ring-offset-2 ring-offset-[var(--inset)]" : ""}`}
            style={{ left: `calc(${left(sec)}% - 4px)` }} onPointerDown={(e) => e.stopPropagation()} onClick={() => onSelectEvent ? onSelectEvent(event) : jump(sec)} />)}
          {nowSecOfDay !== null && <div data-testid="now-marker" title="Now" className="absolute top-6 bottom-0 w-px bg-[var(--text-muted)] pointer-events-none z-30" style={{ left: `${left(nowSecOfDay)}%` }} />}
          {currentSec !== null && currentSec >= view.start && currentSec <= view.start + view.span && <div data-testid="playhead" className="absolute top-5 bottom-0 w-0.5 bg-[var(--brand)] pointer-events-none z-30" style={{ left: `${left(currentSec)}%` }}><span className="absolute -top-1 -left-1 w-2.5 h-2.5 rotate-45 bg-[var(--brand)]" /></div>}
          {selectionView && selectionEnd > selectionStart && visible(selectionStart, selectionEnd) && <div data-testid="selection-band" className="absolute top-6 bottom-0 pointer-events-none z-20 bg-[var(--brand-subtle)] border-x-2 border-[var(--brand)]" style={{ left: `${left(selectionStart)}%`, width: `${width(selectionStart, selectionEnd)}%` }} />}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap type-caption-2 text-[color:var(--text-muted)]">
        <span><span className="inline-block w-2 h-2 bg-[var(--brand)] mr-1" />Footage kept <span className="inline-block w-2 h-2 bg-system-orange ml-3 mr-1" />Motion / events <span className="ml-3">Empty space: nothing kept</span></span>
        <span className="font-mono">{formatRuler(view.start)} – {formatRuler(view.start + view.span)}</span>
      </div>
      <p className="type-caption-1 mt-2 text-[color:var(--text-muted)]">Click to seek · {wheelMode === "pan" ? "scroll to pan · Ctrl/⌘+scroll to zoom" : "scroll to zoom · Shift+scroll to pan"} · {onSelectionChange ? "drag to select a range" : "drag to pan"} · {onSelectEvent ? "click an event to play its clip" : "click an event to jump"}</p>
    </div>
  );
}
