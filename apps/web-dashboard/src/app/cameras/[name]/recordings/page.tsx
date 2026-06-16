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
  Video,
} from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import {
  useRecordingsRange,
  useRecordingsSummary,
} from "@/lib/hooks/useRecordings";
import { authFetch } from "@/lib/auth";
import { getRecordingHlsUrl } from "@/lib/api";
import { HlsPlayer, type HlsPlayerHandle } from "@/components/recordings/HlsPlayer";
import {
  RecordingsTimeline,
  fmtSecOfDay,
  type TimelineSelection,
} from "@/components/recordings/RecordingsTimeline";
import type { CameraInfo } from "@/lib/types";
import { X } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";

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
  const name = useMemo(
    () => (typeof params?.name === "string" ? decodeURIComponent(params.name) : ""),
    [params],
  );

  const { cameras } = useCameras();
  const camera: CameraInfo | undefined = cameras.find((c) => c.name === name);

  const [day, setDay] = useState<string>(() => localDayString(new Date()));
  const [hour, setHour] = useState<number | null>(null);
  // Operator-drawn range over the timeline — minute precision in
  // seconds-since-midnight on the visible day. Drives the export
  // button when set; null falls back to the current hour.
  const [selection, setSelection] = useState<TimelineSelection | null>(null);

  // Selection is per-day — switching days clears it so an operator
  // doesn't accidentally export Tuesday's range from Wednesday.
  useEffect(() => {
    setSelection(null);
  }, [day]);

  const summaryHook = useRecordingsSummary(name || null);

  // Snap to the most recent hour with activity on first load.
  useEffect(() => {
    if (hour !== null) return;
    if (summaryHook.isLoading) return;
    const dayEntry = summaryHook.days.find((d) => d.day === day);
    if (!dayEntry) return;
    const withEvents = dayEntry.hours.filter((h) => h.events > 0 || h.motion > 0);
    if (withEvents.length === 0) return;
    const latest = withEvents.reduce((acc, h) => (h.hour > acc.hour ? h : acc));
    setHour(latest.hour);
  }, [day, summaryHook.days, summaryHook.isLoading, hour]);

  // [after, before] for the currently-selected hour.
  const range = useMemo(() => {
    if (hour === null) return { after: null as number | null, before: null as number | null };
    const [y, m, d] = day.split("-").map(Number);
    const start = Math.floor(new Date(y, m - 1, d, hour, 0, 0).getTime() / 1000);
    return { after: start, before: start + PLAYBACK_WINDOW_SEC };
  }, [day, hour]);

  const rangeHook = useRecordingsRange(name || null, range.after, range.before);

  const playbackUrl =
    range.after !== null && range.before !== null
      ? getRecordingHlsUrl(name, range.after, range.before)
      : null;

  // Track the player's current time so the scrubber playhead can move.
  const playerRef = useRef<HlsPlayerHandle | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playerError, setPlayerError] = useState<string | null>(null);
  useEffect(() => {
    setCurrentTime(0);
    setPlayerError(null);
  }, [playbackUrl]);

  const playheadFraction = useMemo(() => {
    if (hour === null || range.after === null) return undefined;
    // Within the selected hour cell, where are we (0..1)?
    const offset = currentTime / PLAYBACK_WINDOW_SEC;
    return Math.min(1, Math.max(0, offset));
  }, [hour, currentTime, range.after]);

  // ---------- Export ----------
  //
  // Export prefers the operator's drag selection (minute precision)
  // when one is set; otherwise it falls back to the current hour.
  // The selection is in seconds-since-midnight on `day`, so we add
  // the day's epoch start to convert to absolute Unix seconds.
  const exportRange = useMemo(() => {
    if (selection) {
      const [y, m, d] = day.split("-").map(Number);
      const dayStart = Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000);
      return {
        after: dayStart + selection.startSec,
        before: dayStart + selection.endSec,
      };
    }
    return range;
  }, [selection, day, range]);

  const exportSpanLabel = useMemo(() => {
    if (selection) {
      return `${fmtSecOfDay(selection.startSec)} – ${fmtSecOfDay(selection.endSec)}`;
    }
    if (hour === null) return null;
    return `${String(hour).padStart(2, "0")}:00 – ${String((hour + 1) % 24).padStart(2, "0")}:00`;
  }, [selection, hour]);

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
      setExportMsg(body.ncPath ? `Saved to ${body.ncPath}` : "Saved to Nextcloud");
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  if (!name) return null;

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
      sub="Browse the past 7 days. Click an hour on the timeline to jump in."
      actions={actions}
    >
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
                ref={playerRef}
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
            {playerError && (
              <div className="absolute inset-x-0 bottom-0 bg-system-red/90 text-white p-2 text-center type-caption-1">
                {playerError}
              </div>
            )}
          </div>

          {/* Hour navigation under the player. */}
          {hour !== null && (
            <div className="card flex items-center justify-between" style={{ padding: "8px 12px" }}>
              <button
                onClick={() => {
                  if (hour > 0) setHour(hour - 1);
                }}
                disabled={hour === 0}
                className="btn ghost sm disabled:opacity-50"
                type="button"
              >
                <ChevronLeft size={14} />
                <span className="type-caption-1">Earlier hour</span>
              </button>
              <span className="type-subheadline text-label-primary font-mono">
                {String(hour).padStart(2, "0")}:00 —{" "}
                {String((hour + 1) % 24).padStart(2, "0")}:00
              </span>
              <button
                onClick={() => {
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
            timeline={rangeHook.timeline}
            selectedHour={hour}
            playheadFraction={playheadFraction}
            onSelectHour={setHour}
            selection={selection}
            onSelectionChange={setSelection}
          />
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          {/* Export */}
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
                  your Nextcloud under <span className="font-mono">/Clips</span>.
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
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-secondary cursor-pointer"
                      onClick={() => {
                        if (range.after === null) return;
                        const offset = s.startTime - range.after;
                        if (offset >= 0 && offset <= PLAYBACK_WINDOW_SEC) {
                          playerRef.current?.seek(offset);
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
    </ShellPage>
  );
}
