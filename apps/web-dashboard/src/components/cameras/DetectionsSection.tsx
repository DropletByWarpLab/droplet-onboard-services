"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { fetchCameras, fetchEventsFiltered } from "@/lib/api";
import { cameraLabeler } from "@/lib/camera-display";
import { isCamerasUnavailableError } from "@/lib/files-unavailable";
import type { CameraInfo, EventDetail } from "@/lib/types";
import { EventCard } from "@/components/events/EventCard";
import { EventClipModal } from "@/components/events/EventClipModal";

interface DetectionsSectionProps {
  /** Section heading, e.g. "People detections". */
  title: string;
  /** Lowercase Frigate labels to list, e.g. ["person"] or ["car"]. */
  labels: string[];
  /** Shown in an empty state: what is being listed ("people", "vehicles"). */
  noun: string;
  /** Icon for the empty state. */
  icon: ReactNode;
  /** Bump to reload (the page's Refresh button). */
  reloadKey?: number;
  limit?: number;
}

const CAMERAS_KEY = "/api/cameras";

/**
 * The detections the People and Plates pages lead with: the same events the
 * main Cameras page lists under "Recent detections", filtered to one kind of
 * thing and reaching further back (GET /api/cameras/events?labels=…).
 *
 * Reads are honest about their state: a camera service that cannot be reached
 * says so (the route answers 200 + an empty list marked degraded, which is
 * otherwise indistinguishable from "nothing was seen"), and a failed load has a
 * Retry. Cards and the clip viewer are the Events page's own.
 */
export function DetectionsSection({
  title,
  labels,
  noun,
  icon,
  reloadKey = 0,
  limit = 50,
}: DetectionsSectionProps) {
  const [events, setEvents] = useState<EventDetail[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EventDetail | null>(null);

  const { data: cameras } = useSWR<CameraInfo[]>(CAMERAS_KEY, fetchCameras);
  const cameraLabel = useMemo(() => cameraLabeler(cameras ?? []), [cameras]);

  const labelsKey = labels.join(",");
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const result = await fetchEventsFiltered({ labels: labelsKey.split(","), limit });
      setEvents(result.events);
    } catch (e) {
      if (isCamerasUnavailableError(e)) setUnavailable(true);
      else setError(e instanceof Error ? e.message : "Couldn't load detections");
    } finally {
      setLoading(false);
    }
  }, [labelsKey, limit]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const failed = unavailable || error !== null;

  return (
    <>
      <div className="sect flex-wrap">
        <h2>{title}</h2>
        {events && !failed && <span className="sx">{events.length}</span>}
      </div>

      {failed ? (
        <div
          className="card"
          role="alert"
          data-testid="detections-error"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <AlertTriangle size={14} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
          <span className="type-footnote" style={{ color: "var(--text-muted)", flex: 1 }}>
            {unavailable
              ? `The camera service is unreachable, so ${noun} detections can't be listed right now.`
              : `Couldn't load ${noun} detections: ${error}`}
          </span>
          <button type="button" className="btn ghost" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : loading && !events ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card h-48 animate-pulse" style={{ background: "var(--surface-2)" }} />
          ))}
        </div>
      ) : !events || events.length === 0 ? (
        <div className="card" data-testid="detections-empty">
          <div className="empty">
            <span className="ei">{icon}</span>
            <span className="eh">No {noun} detected yet</span>
            <span style={{ maxWidth: "44ch" }}>
              Detections show up here as your cameras see them, newest first.
            </span>
          </div>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
          aria-label={`${title} list`}
        >
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              cameraName={cameraLabel(event.camera)}
              onClick={setSelected}
            />
          ))}
        </div>
      )}

      {selected && (
        <EventClipModal
          key={selected.id}
          event={selected}
          cameraName={cameraLabel(selected.camera)}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
