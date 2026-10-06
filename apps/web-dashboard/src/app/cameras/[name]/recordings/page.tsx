"use client";
import { ThemedDateInput } from "@/components/ui/ThemedDateInput";


import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  Video,
} from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import {
  useRecordingsRange,
  useRecordingsSummary,
} from "@/lib/hooks/useRecordings";
import { authFetch, useAuth } from "@/lib/auth";
import { getRecordingHlsUrl } from "@/lib/api";
import { HlsPlayer, type HlsPlayerHandle } from "@/components/recordings/HlsPlayer";
import { archiveToMediaTime, mediaToArchiveTime } from "@/components/recordings/archive-time";
import {
  RecordingsTimeline,
  type TimelineSelection,
} from "@/components/recordings/RecordingsTimeline";
import type { CameraInfo } from "@/lib/types";
import { X } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { CameraRelatedLinks } from "@/components/cameras/CameraRelatedLinks";
import { formatDays, maxRetentionDays } from "@/lib/camera-recording";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

/** Playback window — one full hour. With HLS the orchestrator no
 *  longer caps the range, but the per-hour granularity matches the
 *  scrubber UX (one cell = one hour) and keeps the segment list
 *  readable. */
const PLAYBACK_WINDOW_SEC = 60 * 60;

function localDayString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function archiveTimeLabel(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
}

function dayPlusOffset(day: string, offsetDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + offsetDays);
  return localDayString(date);
}

/**
 * Recordings + timeline page for a single camera.
 *
 * Phase 3.2A: swap mp4 for HLS so the player can scrub a full hour
 * (or more) without a synthesised stitch on the orchestrator side.
 * Removes the half-hour navigation that mp4's 30-min cap forced.
 *
 * Compose:
 *   - Header: back, date stepper, refresh.
 *   - Player: HLS via HlsPlayer (Safari uses native HLS; everywhere
 *     else uses hls.js, dynamic-imported so it only loads on this
 *     route).
 *   - Sub-hour nav under the player: prev/next hour.
 *   - Timeline: 24-hour scrubber with motion heat-map + playhead.
 *   - Right rail: segment list (clickable to seek), Save-to-Nextcloud.
 */
export default function RecordingsPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const name = useMemo(
    () => (typeof params?.name === "string" ? decodeURIComponent(params.name) : ""),
    [params],
  );

  const { cameras } = useCameras();
  const { user } = useAuth();
  // WARP-3103: exporting footage is owner/admin custody; the box refuses members.
  const canExport = user?.role === "owner" || user?.role === "admin";
  const camera: CameraInfo | undefined = cameras.find((c) => c.name === name);

  const [day, setDay] = useState<string>(() => {
    const requested = searchParams?.get("date");
    const today = localDayString(new Date());
    if (!requested || !/^\d{4}-\d{2}-\d{2}$/.test(requested) || requested > today) return today;
    const [y, m, d] = requested.split("-").map(Number);
    return localDayString(new Date(y, m - 1, d)) === requested ? requested : today;
  });
  const [hour, setHour] = useState<number | null>(null);
  const [playbackAnchor, setPlaybackAnchor] = useState<number | null>(null);
  // Operator-drawn range over the timeline — minute precision in
  // seconds-since-midnight on the visible day. Drives the export
  // button when set; null falls back to the current hour.
  const [selection, setSelection] = useState<TimelineSelection | null>(null);

  // Selection is per-day — switching days clears it so an operator
  // doesn't accidentally export Tuesday's range from Wednesday.
  useEffect(() => {
    setSelection(null);
    setPlaybackAnchor(null);
  }, [day]);

  const summaryHook = useRecordingsSummary(name || null);

  // Snap to the most recent hour that actually HAS footage.
  //
  // The old rule was `events > 0 || motion > 0`, which is the wrong
  // question twice over: a camera recording 24/7 over a quiet scene has
  // neither, so a full hour was skipped; and combined with the summary's
  // hour bug it landed on an hour with no recordings at all, whose
  // playback request Frigate answered with a 404 (WARP-1958).
  // `duration` is the only field that means "there is something here".
  useEffect(() => {
    if (hour !== null) return;
    if (summaryHook.isLoading) return;
    const dayEntry = summaryHook.days.find((d) => d.day === day);
    if (!dayEntry) return;
    const withFootage = dayEntry.hours.filter((h) => h.duration > 0);
    if (withFootage.length === 0) return;
    const latest = withFootage.reduce((acc, h) => (h.hour > acc.hour ? h : acc));
    setHour(latest.hour);
  }, [day, summaryHook.days, summaryHook.isLoading, hour]);

  // [after, before] for the currently-selected hour.
  //
  // Clamped to `now`: footage cannot exist ahead of the clock, and asking
  // for it yields an empty segment list plus a 404 on the VOD manifest,
  // which the player renders as "we couldn't load that recording" — an
  // empty hour presented as a broken camera. The orchestrator clamps too;
  // doing it here as well means we never even issue the request.
  const range = useMemo(() => {
    const empty = { after: null as number | null, before: null as number | null };
    if (hour === null) return empty;
    const [y, m, d] = day.split("-").map(Number);
    const anchor = playbackAnchor === null ? null : new Date(playbackAnchor * 1000);
    const start = anchor && localDayString(anchor) === day && anchor.getHours() === hour
      ? playbackAnchor! - anchor.getMinutes() * 60 - anchor.getSeconds()
      : Math.floor(new Date(y, m - 1, d, hour, 0, 0).getTime() / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    if (start >= nowSec) return empty;
    return { after: start, before: Math.min(start + PLAYBACK_WINDOW_SEC, nowSec) };
  }, [day, hour, playbackAnchor]);

  const rangeHook = useRecordingsRange(name || null, range.after, range.before);
  const dayRange = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    const after = Math.floor(new Date(y, m - 1, d).getTime() / 1000);
    const before = Math.min(Math.floor(new Date(y, m - 1, d + 1).getTime() / 1000), Math.floor(Date.now() / 1000));
    return { after, before };
  }, [day, summaryHook.days]);
  const dayHook = useRecordingsRange(name || null, dayRange.after, dayRange.before);

  // An hour with no segments is EMPTY, not broken. Loading the player
  // into such a range makes Frigate 404 the manifest and hls.js raise a
  // fatal error, which the operator reads as "the camera is down" — the
  // single most misleading thing this page did (WARP-1958). Hold the
  // player back until we know there is something to play.
  const hasFootage = rangeHook.segments.length > 0;
  const rangeResolved = range.after !== null && range.before !== null;
  const playbackUrl =
    rangeResolved && hasFootage
      ? getRecordingHlsUrl(name, range.after!, range.before!)
      : null;

  // Track the player's current time so the scrubber playhead can move.
  const playerRef = useRef<HlsPlayerHandle | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  useEffect(() => {
    setCurrentTime(0);
    setPlayerError(null);
  }, [playbackUrl]);

  const archiveTimestamp = range.after !== null && range.before !== null
    ? mediaToArchiveTime(rangeHook.segments, range.after, range.before, currentTime)
    : null;
  const archiveDate = archiveTimestamp === null ? null : new Date(archiveTimestamp * 1000);
  const playheadSec = archiveTimestamp === null ? undefined : archiveTimestamp - dayRange.after;

  /**
   * Seconds-since-midnight of "now" — but only when the visible day IS
   * today. On any past day every hour has happened, and greying the tail
   * of e.g. last Tuesday would be a lie.
   */
  const nowSecOfDay = useMemo(() => {
    const now = new Date();
    if (localDayString(now) !== day) return null;
    return Math.floor(now.getTime() / 1000) - dayRange.after;
  }, [day, dayRange.after, summaryHook.days]);

  /**
   * Oldest day the summary still knows about — a good proxy for "how far
   * back can I actually scrub". Lets an empty morning read as *outside
   * retention* rather than *broken*, which is the distinction the old page
   * could not make at all.
   */
  const retentionOldestDay = useMemo(() => {
    const days = summaryHook.days.map((d) => d.day).filter(Boolean).sort();
    return days.length > 0 ? days[0] : null;
  }, [summaryHook.days]);

  /**
   * Move playback to a point in the day.
   *
   * Selecting an hour re-keys the HLS source, so the seek has to happen
   * once the new media is live rather than against the outgoing one. We
   * stash the offset and apply it when the player reports it is ready.
   */
  const pendingSeekRef = useRef<number | null>(null);
  useEffect(() => { pendingSeekRef.current = null; }, [day]);
  const handleScrubTo = (secOfDay: number) => {
    const target = Math.min(Math.floor(Date.now() / 1000), dayRange.after + secOfDay);
    const targetHour = new Date(target * 1000).getHours();
    if (hour === targetHour && playbackUrl && range.after !== null && range.before !== null && target >= range.after && target < range.before) {
      playerRef.current?.seek(archiveToMediaTime(rangeHook.segments, range.after, range.before, target));
    } else {
      pendingSeekRef.current = target;
      setPlaybackAnchor(target);
      setHour(targetHour);
    }
  };
  const handlePlayerReady = () => {
    if (pendingSeekRef.current === null || range.after === null || range.before === null) return;
    playerRef.current?.seek(archiveToMediaTime(rangeHook.segments, range.after, range.before, pendingSeekRef.current));
    pendingSeekRef.current = null;
  };
  const jumpEvent = (direction: number) => {
    const timestamps = [...new Set(dayHook.timeline.map((e) => e.timestamp))].sort((a, b) => a - b);
    const current = archiveTimestamp ?? range.after ?? dayRange.after;
    const target = direction < 0 ? [...timestamps].reverse().find((t) => t < current - 1) : timestamps.find((t) => t > current + 1);
    if (target === undefined) return;
    handleScrubTo(target - dayRange.after);
  };
  const handlePlaybackEnded = () => {
    if (range.before === null) return;
    const next = [...dayHook.segments].sort((a, b) => a.startTime - b.startTime).find((s) => s.endTime > range.before!);
    if (!next) return;
    handleScrubTo(Math.max(next.startTime, range.before) - dayRange.after);
  };

  // ---------- Export ----------
  //
  // Export prefers the operator's drag selection (minute precision)
  // when one is set; otherwise it falls back to the current hour.
  // The selection is in seconds-since-midnight on `day`, so we add
  // the day's epoch start to convert to absolute Unix seconds.
  const exportRange = useMemo(() => {
    if (selection) {
      return {
        after: dayRange.after + selection.startSec,
        before: dayRange.after + selection.endSec,
      };
    }
    return range;
  }, [selection, dayRange.after, range]);

  const exportSpanLabel = useMemo(() => {
    if (selection) {
      const format = (sec: number) => archiveTimeLabel(dayRange.after + sec);
      return `${format(selection.startSec)} – ${format(selection.endSec)}`;
    }
    if (hour === null) return null;
    if (range.after !== null && range.before !== null) return `${archiveTimeLabel(range.after)} – ${archiveTimeLabel(range.before)}`;
    return `${String(hour).padStart(2, "0")}:00 – ${String((hour + 1) % 24).padStart(2, "0")}:00`;
  }, [selection, hour, dayRange.after, range]);

  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const handleExport = async () => {
    if (exportRange.after === null || exportRange.before === null) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const res = await authFetch(`/api/cameras/${encodeURIComponent(name)}/clips/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          starts_at: new Date(exportRange.after * 1000).toISOString(),
          ends_at: new Date(exportRange.before * 1000).toISOString(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
      }
      const body = (await res.json()) as { ncPath?: string };
      setExportMsg(body.ncPath ? `Saved to ${body.ncPath}` : "Saved to File Store");
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  if (!name) return null;

  // WARP-3511: how far back this camera keeps footage comes from its own
  // retention, not a fixed number. This said "the past 7 days" for every
  // camera, whatever it kept — and that figure is changing by release.
  const rec = camera?.recording;
  const longest = maxRetentionDays(rec);
  const browseSub =
    !rec || rec.degraded || !rec.mode
      ? "Browse your recordings."
      : rec.mode === "off"
        ? "This camera isn't saving footage, so only what was kept before is here."
        : `Footage is kept for up to ${formatDays(longest)}.`;

  const actions = (
    <>
      <button
        onClick={() => router.push(`/cameras/${encodeURIComponent(name)}`)}
        className="btn ghost"
        type="button"
      >
        <ArrowLeft size={15} />
        Camera
      </button>
      <button
          onClick={() => {
            summaryHook.refresh();
            rangeHook.refresh();
            dayHook.refresh();
        }}
        className="icon-btn"
        aria-label="Refresh"
        title="Refresh"
        type="button"
      >
        <RefreshCw size={16} />
      </button>
    </>
  );

  return (
    <ShellPage
      icon={<Video size={15} />}
      label="Recordings"
      title={`${camera?.displayName ?? name} · Recordings`}
      sub={`${browseSub} Click an hour on the timeline to jump in.`}
      actions={actions}
    >
      {/* WARP-3511 — the way to this camera's settings, notifications and
          storage. Settings only for those who can open it. */}
      <CameraRelatedLinks camera={name} current="recordings" canManage={canExport} className="mb-3" />

      {/* Date picker */}
      <div className="card mb-4 flex items-center gap-2" style={{ padding: 12 }}>
        <button
          onClick={() => {
            setDay((d) => dayPlusOffset(d, -1));
            setHour(null);
          }}
          className="icon-btn"
          aria-label="Previous day"
          type="button"
        >
          <ChevronLeft size={16} />
        </button>
        <ThemedDateInput
          type="date"
          aria-label="Recording date"
          value={day}
          onChange={(e) => {
            setDay(e.target.value);
            setHour(null);
          }}
          max={localDayString(new Date())}
          className="flex-1 h-9 px-3 type-subheadline outline-none focus:ring-2 focus:ring-[var(--brand)]"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--text)",
          }}
        />
        <button
          onClick={() => {
            setDay((d) => dayPlusOffset(d, 1));
            setHour(null);
          }}
          disabled={day >= localDayString(new Date())}
          className="icon-btn disabled:opacity-50"
          aria-label="Next day"
          type="button"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        {/* Player + timeline column */}
        <div className="space-y-4">
          <div className="card overflow-hidden bg-black aspect-video relative" style={{ padding: 0 }}>
            {playbackUrl ? (
              <HlsPlayer
                src={playbackUrl}
                onTimeUpdate={setCurrentTime}
                onError={setPlayerError}
                onReady={handlePlayerReady}
                onPlayingChange={setPlaying}
                onEnded={handlePlaybackEnded}
                playbackRate={playbackRate}
                ref={playerRef}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center text-white/70">
                {summaryHook.isLoading || rangeHook.isLoading ? (
                  <p className="type-subheadline">Loading recordings…</p>
                ) : rangeHook.error ? (
                  // Only a genuine failure to reach the recorder is an
                  // error. Everything below is a normal, calm state.
                  <>
                    <p className="type-subheadline">Couldn&apos;t reach the recorder</p>
                    <p className="type-caption-1 text-white/50">
                      The camera may be fine — we couldn&apos;t load its recordings
                      just now. Try refreshing.
                    </p>
                  </>
                ) : hour === null ? (
                  <p className="type-subheadline">
                    Pick an hour on the timeline to start playback
                  </p>
                ) : !rangeResolved ? (
                  <>
                    <p className="type-subheadline">That hour hasn&apos;t happened yet</p>
                    <p className="type-caption-1 text-white/50">
                      Pick an earlier hour on the timeline.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="type-subheadline">No footage kept for this hour</p>
                    <p className="type-caption-1 text-white/50">
                      Nothing was recorded, or it has passed this camera&apos;s
                      retention window.{" "}
                      {canExport ? (
                        <>
                          Check{" "}
                          <Link
                            href={`/cameras/${encodeURIComponent(name)}/settings`}
                            className="underline underline-offset-2 text-white/80"
                          >
                            Settings
                          </Link>{" "}
                          to keep footage for longer.
                        </>
                      ) : (
                        "Ask an owner or admin to keep footage for longer."
                      )}
                    </p>
                  </>
                )}
              </div>
            )}
            {playerError && (
              <div className="absolute inset-x-0 bottom-0 bg-system-red/90 text-white p-2 text-center type-caption-1">
                {playerError}
              </div>
            )}
          </div>

          <div className="card flex items-center justify-between gap-3 flex-wrap" style={{ padding: "8px 12px" }}>
            <div className="flex items-center gap-1">
              <button type="button" className="icon-btn" aria-label="Previous event" disabled={dayHook.timeline.length === 0} onClick={() => jumpEvent(-1)}><SkipBack size={16} /></button>
              <button type="button" className="icon-btn" aria-label={playing ? "Pause recording" : "Play recording"} disabled={!playbackUrl} onClick={() => {
                if (playing) playerRef.current?.pause();
                else void playerRef.current?.play().catch(() => setPlayerError("Playback could not start. Try the player's play button."));
              }}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
              <button type="button" className="icon-btn" aria-label="Next event" disabled={dayHook.timeline.length === 0} onClick={() => jumpEvent(1)}><SkipForward size={16} /></button>
              <ThemedSelect aria-label="Playback speed" value={playbackRate} onChange={(e) => setPlaybackRate(Number(e.target.value))} className="h-8 rounded-md px-2 type-caption-1" style={{ width: "auto", background: "var(--inset)", color: "var(--text)" }}>
                {[0.25, 0.5, 1, 2, 4, 8, 16].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
              </ThemedSelect>
            </div>
            <label className="flex items-center gap-2 type-caption-1 text-label-tertiary">Go to time
              <input type="time" step="1" aria-label="Go to recording time" value={archiveDate === null ? "" : `${String(archiveDate.getHours()).padStart(2, "0")}:${String(archiveDate.getMinutes()).padStart(2, "0")}:${String(archiveDate.getSeconds()).padStart(2, "0")}`} onChange={(e) => {
                const [h, m, s = 0] = e.target.value.split(":").map(Number);
                const [y, month, d] = day.split("-").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) handleScrubTo(Math.min(nowSecOfDay ?? dayRange.before - dayRange.after - 1, new Date(y, month - 1, d, h, m, s).getTime() / 1000 - dayRange.after));
              }} className="h-8 rounded-md px-2 font-mono text-label-primary" style={{ background: "var(--inset)", border: "1px solid var(--border)" }} />
            </label>
          </div>

          {/* Quick hour steps sit beside the continuous timeline controls. */}
          {hour !== null && (
            <div className="card flex items-center justify-between gap-2 flex-wrap" style={{ padding: "8px 12px" }}>
              <button
                onClick={() => {
                  pendingSeekRef.current = null;
                  setPlaybackAnchor(null);
                  if (hour > 0) setHour(hour - 1);
                }}
                disabled={hour === 0}
                className="btn ghost sm disabled:opacity-50"
                type="button"
              >
                <ChevronLeft size={14} />
                <span className="type-caption-1">Earlier hour</span>
              </button>
              <span className="type-subheadline text-label-primary font-mono order-last w-full text-center sm:order-none sm:w-auto">
                {range.after !== null && range.before !== null
                  ? `${archiveTimeLabel(range.after)} — ${archiveTimeLabel(range.before)}`
                  : `${String(hour).padStart(2, "0")}:00`}
              </span>
              <button
                onClick={() => {
                  pendingSeekRef.current = null;
                  setPlaybackAnchor(null);
                  if (hour < 23) setHour(hour + 1);
                }}
                disabled={hour === 23}
                className="btn ghost sm disabled:opacity-50"
                type="button"
              >
                <span className="type-caption-1">Later hour</span>
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          <RecordingsTimeline
            day={day}
            summary={summaryHook.days}
            timeline={dayHook.timeline}
            recordings={dayHook.isLoading || dayHook.error ? undefined : dayHook.segments}
            selectedHour={hour}
            playheadSec={playheadSec}
            onSelectHour={setHour}
            selection={selection}
            onSelectionChange={setSelection}
            onScrubTo={handleScrubTo}
            nowSecOfDay={nowSecOfDay}
            retentionOldestDay={retentionOldestDay}
          />
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          {/* Export */}
          {canExport && (
          <div className="card">
            <div className="flex items-start justify-between gap-2 mb-1">
              <h3 className="type-subheadline text-label-primary font-medium">
                {selection ? "Export selection" : "Export current hour"}
              </h3>
              {selection && (
                <button
                  type="button"
                  onClick={() => setSelection(null)}
                  className="flex items-center gap-1 type-caption-2 text-label-tertiary hover:text-label-primary"
                  aria-label="Clear selection"
                >
                  <X size={12} />
                  Clear
                </button>
              )}
            </div>
            <p className="type-caption-1 text-label-tertiary mb-3">
              {exportSpanLabel ? (
                <>
                  Saves <span className="font-mono">{exportSpanLabel}</span> to
                  your File Store under <span className="font-mono">/Clips</span>.
                </>
              ) : (
                <>Pick an hour or drag a range on the timeline first.</>
              )}
            </p>
            <button
              onClick={handleExport}
              disabled={exporting || exportRange.after === null}
              className="btn primary w-full disabled:opacity-60"
              style={{ justifyContent: "center" }}
              type="button"
            >
              {exporting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              <span className="type-subheadline">
                {exporting ? "Exporting…" : "Save to File Store"}
              </span>
            </button>
            {exportMsg && (
              <p
                className={`type-caption-1 mt-2 ${
                  exportMsg.startsWith("Saved")
                    ? "text-system-green"
                    : "text-system-red"
                }`}
              >
                {exportMsg}
              </p>
            )}
          </div>
          )}

          {/* Segment list */}
          <div className="card">
            <h3 className="type-subheadline text-label-primary font-medium mb-2">
              Segments
            </h3>
            {rangeHook.isLoading ? (
              <p className="type-caption-1 text-label-tertiary">Loading…</p>
            ) : rangeHook.segments.length === 0 ? (
              <p className="type-caption-1 text-label-tertiary">
                No recording segments in this window.
              </p>
            ) : (
              <ul className="space-y-1 max-h-96 overflow-y-auto -mx-1 px-1">
                {rangeHook.segments.map((s) => {
                  const start = new Date(s.startTime * 1000);
                  return (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--hover)] cursor-pointer"
                      onClick={() => {
                        if (range.after === null) return;
                        if (range.before === null) return;
                        playerRef.current?.seek(archiveToMediaTime(rangeHook.segments, range.after, range.before, s.startTime));
                      }}
                    >
                      <span className="type-caption-1 font-mono" style={{ color: "var(--text)" }}>
                        {String(start.getHours()).padStart(2, "0")}:
                        {String(start.getMinutes()).padStart(2, "0")}:
                        {String(start.getSeconds()).padStart(2, "0")}
                      </span>
                      <span className="type-caption-2" style={{ color: "var(--text-muted)" }}>
                        {Math.round(s.duration)}s
                      </span>
                      {s.objects > 0 && (
                        <span
                          className="type-caption-2 px-1.5 rounded"
                          style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
                        >
                          {s.objects} obj
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </ShellPage>
  );
}
