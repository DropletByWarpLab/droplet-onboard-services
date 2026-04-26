"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import {
  useRecordingsRange,
  useRecordingsSummary,
} from "@/lib/hooks/useRecordings";
import { authFetch } from "@/lib/auth";
import { getRecordingPlaybackUrl } from "@/lib/api";
import { RecordingsTimeline } from "@/components/recordings/RecordingsTimeline";
import type { CameraInfo } from "@/lib/types";

/** Half-hour playback window (in seconds). The orchestrator caps the
 *  range-mp4 endpoint at 30 minutes; we lock the window size to that
 *  cap so the operator can't construct an over-long range. */
const PLAYBACK_WINDOW_SEC = 30 * 60;

function localDayString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayPlusOffset(day: string, offsetDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + offsetDays);
  return localDayString(date);
}

/**
 * Recordings + timeline page for a single camera (Phase 3.1).
 *
 * Compose:
 *   - Header: back to camera, date picker (yesterday / today / +1 / +7),
 *     refresh.
 *   - Player: <video> sourced from /api/cameras/:name/playback?after=&before=,
 *     auto-loaded on every (day, hour, halfHour) change. Time updates
 *     drive the playhead on the timeline.
 *   - Timeline: 24 hour cells, click-to-navigate.
 *   - Side rail: segment list (clickable to seek), Export-to-Nextcloud
 *     for the current visible window (reuses the existing clip-export
 *     route from PR #3 — no new backend needed).
 *
 * Phase 3.2 will swap mp4 for HLS so longer scrubs work without the
 * 30-min hard cap, and add a drag-to-select range on the timeline.
 */
export default function RecordingsPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const name = useMemo(
    () => (typeof params?.name === "string" ? decodeURIComponent(params.name) : ""),
    [params],
  );

  const { cameras } = useCameras();
  const camera: CameraInfo | undefined = cameras.find((c) => c.name === name);

  const [day, setDay] = useState<string>(() => localDayString(new Date()));
  const [hour, setHour] = useState<number | null>(null);
  /** 0 = first 30 min of the hour, 1 = second 30 min. Operator advances
   *  through with the chevron buttons under the player. */
  const [halfHour, setHalfHour] = useState<0 | 1>(0);

  const summaryHook = useRecordingsSummary(name || null);

  // Snap to the most recent hour with activity on first load (or when
  // switching days). Avoids dropping the operator on an empty 00:00.
  useEffect(() => {
    if (hour !== null) return;
    if (summaryHook.isLoading) return;
    const dayEntry = summaryHook.days.find((d) => d.day === day);
    if (!dayEntry) return;
    const withEvents = dayEntry.hours.filter((h) => h.events > 0 || h.motion > 0);
    if (withEvents.length === 0) return;
    const latest = withEvents.reduce((acc, h) => (h.hour > acc.hour ? h : acc));
    setHour(latest.hour);
    setHalfHour(0);
  }, [day, summaryHook.days, summaryHook.isLoading, hour]);

  // Compute the [after, before] window for the current selection.
  const range = useMemo(() => {
    if (hour === null) return { after: null as number | null, before: null as number | null };
    const [y, m, d] = day.split("-").map(Number);
    const baseStart = new Date(y, m - 1, d, hour, halfHour === 0 ? 0 : 30, 0).getTime() / 1000;
    return {
      after: Math.floor(baseStart),
      before: Math.floor(baseStart) + PLAYBACK_WINDOW_SEC,
    };
  }, [day, hour, halfHour]);

  const rangeHook = useRecordingsRange(name || null, range.after, range.before);

  const playbackUrl =
    range.after !== null && range.before !== null
      ? getRecordingPlaybackUrl(name, range.after, range.before)
      : null;

  // Track the <video>'s current time so the scrubber playhead can move
  // smoothly. We just compute a fraction over the 24-hour day.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  useEffect(() => {
    setCurrentTime(0);
  }, [playbackUrl]);

  const playheadFraction = useMemo(() => {
    if (hour === null || range.after === null) return undefined;
    // Where the playhead sits in the day, expressed as offset within
    // the selected hour cell (0..1).
    const offsetWithinHour =
      ((halfHour === 0 ? 0 : 30 * 60) + currentTime) / (60 * 60);
    return Math.min(1, Math.max(0, offsetWithinHour));
  }, [hour, halfHour, currentTime, range.after]);

  // ---------- Export ----------
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const handleExport = async () => {
    if (range.after === null || range.before === null) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const res = await authFetch(`/api/cameras/${encodeURIComponent(name)}/clips/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          starts_at: new Date(range.after * 1000).toISOString(),
          ends_at: new Date(range.before * 1000).toISOString(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
      }
      const body = (await res.json()) as { ncPath?: string };
      setExportMsg(body.ncPath ? `Saved to ${body.ncPath}` : "Saved to Nextcloud");
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  // ---------- Render ----------
  if (!name) return null;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => router.push(`/cameras/${encodeURIComponent(name)}`)}
          className="p-2 -ml-2 rounded-full hover:bg-surface-secondary transition-colors"
          aria-label="Back to camera"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="type-large-title text-label-primary truncate">
            {camera?.displayName ?? name} · Recordings
          </h1>
          <p className="type-subheadline text-label-tertiary mt-0.5">
            Browse the past 7 days of recordings. Click an hour on the
            timeline to jump in.
          </p>
        </div>
        <button
          onClick={() => {
            summaryHook.refresh();
            rangeHook.refresh();
          }}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} />
          <span className="type-subheadline">Refresh</span>
        </button>
      </div>

      {/* Date picker + day/hour controls */}
      <div className="dp-card p-3 mb-4 flex items-center gap-2">
        <button
          onClick={() => {
            setDay((d) => dayPlusOffset(d, -1));
            setHour(null);
          }}
          className="dp-btn-secondary p-2 rounded-lg"
          aria-label="Previous day"
        >
          <ChevronLeft size={16} />
        </button>
        <input
          type="date"
          value={day}
          onChange={(e) => {
            setDay(e.target.value);
            setHour(null);
          }}
          max={localDayString(new Date())}
          className="flex-1 h-9 px-3 rounded-lg border border-separator bg-surface-secondary type-subheadline text-label-primary"
        />
        <button
          onClick={() => {
            setDay((d) => dayPlusOffset(d, 1));
            setHour(null);
          }}
          disabled={day >= localDayString(new Date())}
          className="dp-btn-secondary p-2 rounded-lg disabled:opacity-50"
          aria-label="Next day"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        {/* Player + timeline column */}
        <div className="space-y-4">
          <div className="dp-card overflow-hidden bg-black aspect-video relative">
            {playbackUrl ? (
              <video
                ref={videoRef}
                key={playbackUrl}
                src={playbackUrl}
                controls
                autoPlay
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-white/70">
                <p className="type-subheadline">
                  {summaryHook.isLoading
                    ? "Loading recordings…"
                    : "Pick an hour on the timeline to start playback"}
                </p>
              </div>
            )}
          </div>

          {/* Sub-hour navigation under the player. */}
          {hour !== null && (
            <div className="flex items-center justify-between dp-card px-3 py-2">
              <button
                onClick={() => {
                  if (halfHour === 1) setHalfHour(0);
                  else if (hour > 0) {
                    setHour(hour - 1);
                    setHalfHour(1);
                  }
                }}
                disabled={hour === 0 && halfHour === 0}
                className="dp-btn-secondary flex items-center gap-1 px-2 py-1 rounded-lg disabled:opacity-50"
              >
                <ChevronLeft size={14} />
                <span className="type-caption-1">Earlier 30 min</span>
              </button>
              <span className="type-subheadline text-label-primary font-mono">
                {String(hour).padStart(2, "0")}:{halfHour === 0 ? "00" : "30"} —{" "}
                {String(halfHour === 0 ? hour : (hour + 1) % 24).padStart(2, "0")}:
                {halfHour === 0 ? "30" : "00"}
              </span>
              <button
                onClick={() => {
                  if (halfHour === 0) setHalfHour(1);
                  else if (hour < 23) {
                    setHour(hour + 1);
                    setHalfHour(0);
                  }
                }}
                disabled={hour === 23 && halfHour === 1}
                className="dp-btn-secondary flex items-center gap-1 px-2 py-1 rounded-lg disabled:opacity-50"
              >
                <span className="type-caption-1">Later 30 min</span>
                <ChevronRight size={14} />
              </button>
            </div>
          )}

          <RecordingsTimeline
            day={day}
            summary={summaryHook.days}
            timeline={rangeHook.timeline}
            selectedHour={hour}
            playheadFraction={playheadFraction}
            onSelectHour={(h) => {
              setHour(h);
              setHalfHour(0);
            }}
          />
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          {/* Export */}
          <div className="dp-card p-4">
            <h3 className="type-subheadline text-label-primary font-medium mb-1">
              Export current window
            </h3>
            <p className="type-caption-1 text-label-tertiary mb-3">
              Saves the visible 30-minute clip to your Nextcloud
              under <span className="font-mono">/Clips</span>.
            </p>
            <button
              onClick={handleExport}
              disabled={exporting || range.after === null}
              className="dp-btn-primary w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg disabled:opacity-60"
            >
              {exporting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              <span className="type-subheadline">
                {exporting ? "Exporting…" : "Save to Nextcloud"}
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

          {/* Segment list */}
          <div className="dp-card p-4">
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
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-secondary cursor-pointer"
                      onClick={() => {
                        if (!videoRef.current || range.after === null) return;
                        const offset = s.startTime - range.after;
                        if (offset >= 0 && offset <= PLAYBACK_WINDOW_SEC) {
                          videoRef.current.currentTime = offset;
                        }
                      }}
                    >
                      <span className="type-caption-1 text-label-primary font-mono">
                        {String(start.getHours()).padStart(2, "0")}:
                        {String(start.getMinutes()).padStart(2, "0")}:
                        {String(start.getSeconds()).padStart(2, "0")}
                      </span>
                      <span className="type-caption-2 text-label-tertiary">
                        {Math.round(s.duration)}s
                      </span>
                      {s.objects > 0 && (
                        <span className="type-caption-2 px-1.5 rounded bg-accent/15 text-accent">
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
    </div>
  );
}
