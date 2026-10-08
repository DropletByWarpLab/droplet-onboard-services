"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Circle, Loader2, Radio, RefreshCw } from "lucide-react";
import { getEventHlsUrl, getRecordingHlsUrl } from "@/lib/api";
import { cameraDetectionDetail } from "@/lib/camera-detection";
import { useRecordingsRange, useRecordingsSummary } from "@/lib/hooks/useRecordings";
import type { DetectionEvent, MotionActivity, TimelineEntry } from "@/lib/types";
import { HlsPlayer, type HlsPlayerHandle } from "@/components/recordings/HlsPlayer";
import { archiveToMediaTime, mediaToArchiveTime } from "@/components/recordings/archive-time";
import { RecordingsTimeline } from "@/components/recordings/RecordingsTimeline";
import { ThemedDateInput } from "@/components/ui/ThemedDateInput";
import { ThumbImage } from "@/components/events/ThumbImage";

export type CameraPlaybackSelection =
  | { kind: "event"; event: DetectionEvent }
  | { kind: "motion"; activity: MotionActivity };

interface Props {
  cameraName: string;
  selection: CameraPlaybackSelection | null;
  onReturnToLive: () => void;
  onActiveItemChange?: (key: string | null) => void;
  onPlaybackChange?: (active: boolean) => void;
  returnToLiveRequest?: number;
  onDayChange?: (day: string) => void;
  children: ReactNode;
}

type Playback =
  | { kind: "event"; id: string; timestamp: number; label: string; endTime?: number | null; detection?: DetectionEvent }
  | { kind: "motion"; activity: MotionActivity }
  | { kind: "range"; after: number; before: number; target: number };

const HOUR_SECONDS = 3600;

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayStart(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime() / 1000;
}

function offsetDay(day: string, offset: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return localDay(new Date(year, month - 1, date + offset));
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fromSelection(selection: CameraPlaybackSelection): Playback {
  return selection.kind === "motion"
    ? { kind: "motion", activity: selection.activity }
    : { kind: "event", id: selection.event.id, timestamp: selection.event.startTime, label: selection.event.label, endTime: selection.event.endTime, detection: selection.event };
}

/** Live video, recorded footage and associated clips share one main viewer. */
export function CameraPlaybackPanel({ cameraName, selection, onReturnToLive, onActiveItemChange, onPlaybackChange, returnToLiveRequest = 0, onDayChange, children }: Props) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [day, setDay] = useState(() => localDay(new Date()));
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [eventRefresh, setEventRefresh] = useState(0);
  const [eventFallback, setEventFallback] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaReady, setMediaReady] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [seekNotice, setSeekNotice] = useState<string | null>(null);
  const [focusSec, setFocusSec] = useState(() => now - dayStart(localDay(new Date(now * 1000))));
  const [focusRequest, setFocusRequest] = useState(0);
  const playerRef = useRef<HlsPlayerHandle | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const seenLiveRequest = useRef(returnToLiveRequest);
  const today = localDay(new Date(now * 1000));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Each fresh selection is a request, including clicking the same row again
  // after a timeline seek. The player key restarts that clip even at the same URL.
  useEffect(() => {
    const selectedCamera = selection?.kind === "event" ? selection.event.camera : selection?.activity.camera;
    const next = selection && selectedCamera === cameraName ? fromSelection(selection) : null;
    setPlayback(next);
    setEventFallback(false);
    setEventRefresh(0);
    setCurrentTime(0);
    setMediaReady(false);
    setPlayerError(null);
    setSeekNotice(null);
    pendingSeek.current = null;
    setAttempt((n) => n + 1);
    if (next) {
      const timestamp = next.kind === "event" ? next.timestamp : next.kind === "motion" ? next.activity.startTime : next.target;
      const selectedDay = localDay(new Date(timestamp * 1000));
      setDay(selectedDay);
      setFocusSec(timestamp - dayStart(selectedDay));
      setFocusRequest((n) => n + 1);
    }
  }, [selection, cameraName]);

  // The page can request live view from Escape even when a timeline seek was
  // initiated inside this panel and its selection prop was already null.
  useEffect(() => {
    if (seenLiveRequest.current === returnToLiveRequest) return;
    seenLiveRequest.current = returnToLiveRequest;
    setPlayback(null);
    setPlayerError(null);
    setSeekNotice(null);
    setEventFallback(false);
    pendingSeek.current = null;
  }, [returnToLiveRequest]);

  const activeKey = playback?.kind === "event" ? `event:${playback.id}` : playback?.kind === "motion" ? `motion:${playback.activity.id}` : null;
  const isPlaybackActive = playback !== null;
  useEffect(() => { onActiveItemChange?.(activeKey); }, [activeKey, onActiveItemChange]);
  useEffect(() => { onPlaybackChange?.(isPlaybackActive); }, [isPlaybackActive, onPlaybackChange]);
  useEffect(() => { onDayChange?.(day); }, [day, onDayChange]);

  const summary = useRecordingsSummary(cameraName || null);
  const visibleDay = useMemo(() => {
    const after = dayStart(day);
    // The recording routes clamp future `before` to now. A stable full-day
    // key avoids caching another copy of a day's metadata every clock tick.
    return { after, before: dayStart(offsetDay(day, 1)) };
  }, [day]);
  const dayRecordings = useRecordingsRange(cameraName || null, visibleDay.after, visibleDay.before, day === today ? 30_000 : 0);

  const range = useMemo(() => {
    if (!playback || (playback.kind === "event" && !eventFallback)) return null;
    if (playback.kind === "range") return { after: playback.after, before: playback.before };
    if (playback.kind === "motion") return { after: playback.activity.startTime, before: playback.activity.endTime };
    const after = Math.floor(playback.timestamp);
    const before = Math.min(playback.endTime ?? after + HOUR_SECONDS, Math.floor(Date.now() / 1000), after + HOUR_SECONDS);
    return { after, before: Math.max(after + 1, before) };
  }, [playback, eventFallback, eventRefresh]);
  const rangeRecordings = useRecordingsRange(range ? cameraName : null, range?.after ?? null, range?.before ?? null);
  const hasFootage = rangeRecordings.segments.length > 0;
  const directEvent = playback?.kind === "event" && !eventFallback;
  const source = directEvent
    ? getEventHlsUrl(playback.id, eventRefresh)
    : range && hasFootage && !rangeRecordings.isLoading && !rangeRecordings.error
      ? playback?.kind === "motion" ? playback.activity.playbackUrl : getRecordingHlsUrl(cameraName, range.after, range.before)
      : null;

  // Event HLS chooses pre/post padding on the server. Its actual start is
  // unknown here, so its marker stays at the event instead of inventing a
  // wall-clock time. Explicit ranges map media time across recording gaps.
  const archiveTimestamp = directEvent ? playback.timestamp
    : range && hasFootage ? mediaToArchiveTime(rangeRecordings.segments, range.after, range.before, currentTime)
      : playback?.kind === "range" ? playback.target
        : playback?.kind === "motion" ? playback.activity.startTime
          : playback?.kind === "event" ? playback.timestamp : null;
  const playheadSec = archiveTimestamp !== null && localDay(new Date(archiveTimestamp * 1000)) === day
    ? archiveTimestamp - visibleDay.after : undefined;
  const selectedHour = playheadSec === undefined ? null : new Date((visibleDay.after + playheadSec) * 1000).getHours();
  const oldestDay = summary.days.map((entry) => entry.day).sort()[0] ?? null;
  const timelineError = summary.error || dayRecordings.error;

  function clearPlayback() {
    setPlayback(null);
    setPlayerError(null);
    setSeekNotice(null);
    setEventFallback(false);
    pendingSeek.current = null;
    onReturnToLive();
  }

  function changeDay(next: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next > today || localDay(new Date(dayStart(next) * 1000)) !== next) return;
    setDay(next);
    setFocusSec(next === today ? Math.floor(Date.now() / 1000) - dayStart(next) : 12 * HOUR_SECONDS);
    setFocusRequest((n) => n + 1);
    clearPlayback();
  }

  function scrubTo(secOfDay: number) {
    const requested = Math.min(Math.floor(Date.now() / 1000) - 1, visibleDay.after + secOfDay);
    let target = requested;
    let notice: string | null = null;
    if (!dayRecordings.isLoading && !dayRecordings.error) {
      const next = [...dayRecordings.segments].sort((a, b) => a.startTime - b.startTime).find((segment) => segment.endTime > requested);
      if (next && next.startTime > requested) {
        target = next.startTime;
        notice = `Nothing was kept at ${timeLabel(requested)}. Showing the next recording at ${timeLabel(target)}.`;
      }
    }
    const date = new Date(target * 1000);
    const after = Math.floor(target - date.getMinutes() * 60 - date.getSeconds());
    const before = Math.min(after + HOUR_SECONDS, dayStart(offsetDay(day, 1)), Math.floor(Date.now() / 1000));
    if (before <= after) return;
    setPlayerError(null);
    setEventFallback(false);
    setSeekNotice(notice);
    setFocusSec(target - visibleDay.after);
    setFocusRequest((n) => n + 1);
    const mediaTime = range && hasFootage ? archiveToMediaTime(rangeRecordings.segments, range.after, range.before, target) : 0;
    if (playback?.kind === "range" && source && range?.after === after && range.before === before && !playerError) {
      playerRef.current?.seek(mediaTime);
      setCurrentTime(mediaTime);
      setPlayback({ kind: "range", after, before, target });
      return;
    }
    pendingSeek.current = target;
    setCurrentTime(0);
    setMediaReady(false);
    setPlayback({ kind: "range", after, before, target });
    setAttempt((n) => n + 1);
  }

  function selectEvent(entry: TimelineEntry) {
    if (!entry.sourceId) { scrubTo(entry.timestamp - visibleDay.after); return; }
    setPlayback({ kind: "event", id: entry.sourceId, timestamp: entry.timestamp, label: entry.label || "Event" });
    setEventFallback(false);
    setEventRefresh(0);
    setCurrentTime(0);
    setMediaReady(false);
    setPlayerError(null);
    setSeekNotice(null);
    setFocusSec(entry.timestamp - visibleDay.after);
    setFocusRequest((n) => n + 1);
    pendingSeek.current = null;
    setAttempt((n) => n + 1);
  }

  function retryPlayback() {
    setPlayerError(null);
    setEventFallback(false);
    setEventRefresh((n) => n + 1);
    setAttempt((n) => n + 1);
    setCurrentTime(0);
    setMediaReady(false);
    pendingSeek.current = playback?.kind === "range" ? playback.target : null;
    rangeRecordings.refresh();
    dayRecordings.refresh();
  }

  function playerReady() {
    setMediaReady(true);
    if (pendingSeek.current === null || !range) return;
    const mediaTime = archiveToMediaTime(rangeRecordings.segments, range.after, range.before, pendingSeek.current);
    playerRef.current?.seek(mediaTime);
    setCurrentTime(mediaTime);
    pendingSeek.current = null;
  }

  const playbackLoading = !directEvent && rangeRecordings.isLoading;
  const playbackReadError = !directEvent && rangeRecordings.error;
  const noFootage = !!playback && !directEvent && !playbackLoading && !playbackReadError && !hasFootage;
  // A known detection can retain a picture after its footage expires. Try
  // both playback sources first, then use only media that its flags promise.
  // Timeline transitions carry no such flags, so they never invent a picture.
  const snapshot = playback?.kind === "event" && playback.detection?.hasSnapshot
    && !playbackLoading && (noFootage || playbackReadError || playerError)
    ? cameraDetectionDetail(playback.detection) : null;
  const title = snapshot ? `${snapshot.label} snapshot` : playback?.kind === "event" ? `${playback.label} clip` : playback?.kind === "motion" ? "Motion recording" : "Recorded footage";

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label="Camera playback">
      <div className="relative flex-1 min-h-[220px] md:min-h-[320px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--inset)]" data-testid="camera-main-viewer">
        {!playback ? children : (
          <>
            {source && !playerError ? (
              <HlsPlayer
                key={`${source}-${attempt}`}
                ref={playerRef}
                src={source}
                className="absolute inset-0 w-full h-full object-contain"
                muted
                onReady={playerReady}
                onTimeUpdate={setCurrentTime}
                onError={(message) => {
                  if (directEvent) { setEventFallback(true); setCurrentTime(0); setMediaReady(false); }
                  else setPlayerError(message);
                }}
              />
            ) : snapshot ? (
              <>
                <ThumbImage
                  src={snapshot.snapshotUrl || snapshot.thumbnail}
                  fallbackSrc={snapshot.thumbnail}
                  alt={`Saved image of ${snapshot.label}`}
                  className="absolute inset-0 w-full h-full object-contain"
                  placeholderClassName="absolute inset-0 w-full h-full"
                  loading="eager"
                  retryKey={attempt}
                  iconSize={40}
                />
                <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--inset)] px-3 py-2">
                  <p role="status" className="type-footnote text-[color:var(--text-muted)]">Clip unavailable. Saved snapshot or event preview.</p>
                  <button type="button" className="btn ghost sm" onClick={retryPlayback}><RefreshCw size={14} /> Retry clip</button>
                </div>
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                {playbackLoading ? <><Loader2 className="animate-spin text-[var(--brand)]" size={28} /><p role="status" className="type-footnote text-[color:var(--text-muted)]">Loading recording…</p></>
                  : <><p role={noFootage ? "status" : "alert"} className="type-subheadline text-[color:var(--text)]">{noFootage ? "No recording is available at this time." : playerError || "This recording can't be loaded right now."}</p>
                    {noFootage && <p className="type-footnote text-[color:var(--text-muted)]">It may have expired or may still be saving.</p>}
                    <button type="button" className="btn ghost sm" onClick={retryPlayback}><RefreshCw size={14} /> Try again</button></>}
              </div>
            )}
            {source && !mediaReady && !playerError && <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center gap-3"><Loader2 className="animate-spin text-[var(--brand)]" size={28} /><p role="status" className="type-footnote text-[color:var(--text-muted)]">Loading clip…</p></div>}
            <div className="absolute left-3 top-3 right-3 flex items-start justify-between gap-3 pointer-events-none">
              <div className="rounded-lg bg-[var(--inset)] px-3 py-2">
                <p className="type-caption-1 font-medium capitalize text-[color:var(--text)]">{title}</p>
                {archiveTimestamp !== null && <p className="type-caption-2 text-[color:var(--text-muted)]">{timeLabel(archiveTimestamp)}</p>}
              </div>
              <button type="button" className="btn sm pointer-events-auto" onClick={clearPlayback}><Radio size={14} /> Return to live</button>
            </div>
          </>
        )}
      </div>

      <div className="space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button type="button" className="icon-btn" aria-label="Previous day" onClick={() => changeDay(offsetDay(day, -1))}><ChevronLeft size={16} /></button>
            <label className="sr-only" htmlFor={`camera-timeline-date-${cameraName}`}>Timeline date</label>
            <ThemedDateInput id={`camera-timeline-date-${cameraName}`} aria-label="Timeline date" clearable={false} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 type-footnote text-[color:var(--text)]" type="date" value={day} max={today} onChange={(event) => changeDay(event.target.value)} />
            <button type="button" className="icon-btn" aria-label="Next day" disabled={day >= today} onClick={() => changeDay(offsetDay(day, 1))}><ChevronRight size={16} /></button>
            {day !== today && <button type="button" className="btn ghost sm" onClick={() => changeDay(today)}>Today</button>}
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 type-caption-1 text-[color:var(--text-muted)]"><Circle size={7} className={`fill-current ${playback ? "text-[var(--brand)]" : "text-system-green"}`} />{snapshot ? "Image only" : playback ? "Playback" : "Live view"}</span>
            {playback?.kind === "event" && playback.endTime === null && <button type="button" className="btn ghost sm" onClick={retryPlayback}><RefreshCw size={13} /> Refresh clip</button>}
            <button type="button" className="icon-btn" aria-label="Refresh timeline" onClick={() => { setNow(Math.floor(Date.now() / 1000)); summary.refresh(); dayRecordings.refresh(); }}><RefreshCw size={15} /></button>
          </div>
        </div>
        {playback?.kind === "event" && playback.endTime === null && <p role="status" className="type-caption-1 text-[color:var(--text-muted)]">{snapshot ? "Event in progress — only a saved image is available right now. Retry the clip to check for footage." : "Event in progress — showing footage saved so far. Refresh the clip to see more."}</p>}
        {seekNotice && <p role="status" className="type-caption-1 text-[color:var(--text-muted)]">{seekNotice}</p>}
        {timelineError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-3 py-2"><p className="type-footnote text-[color:var(--text-muted)]">The recording timeline can't be loaded right now.</p><button type="button" className="btn ghost sm" onClick={() => { summary.refresh(); dayRecordings.refresh(); }}>Retry timeline</button></div>}
        {summary.isLoading || dayRecordings.isLoading ? <p role="status" className="type-caption-1 text-[color:var(--text-muted)]">Loading timeline…</p> : null}
        <RecordingsTimeline
          day={day}
          summary={summary.days}
          timeline={dayRecordings.timeline}
          recordings={dayRecordings.isLoading || dayRecordings.error ? undefined : dayRecordings.segments}
          selectedHour={selectedHour}
          playheadSec={playheadSec}
          onSelectHour={() => undefined}
          onScrubTo={scrubTo}
          onSelectEvent={selectEvent}
          selectedEventId={playback?.kind === "event" ? playback.id : null}
          wheelMode="pan"
          initialSpanSec={HOUR_SECONDS}
          focusSec={focusSec}
          focusKey={focusRequest}
          nowSecOfDay={day === today ? now - visibleDay.after : null}
          retentionOldestDay={oldestDay}
        />
      </div>
    </section>
  );
}
