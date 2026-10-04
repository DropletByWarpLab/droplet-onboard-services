"use client";
/**
 * WARP-3691 — a camera snapshot shown inline in chat.
 *
 * A current-frame snapshot (from `get_camera_snapshot`) can be refreshed and
 * switched to the live feed ("Go live"); a snapshot that belongs to a recorded
 * event is a fixed picture. The live feed only holds a connection while the
 * card is on screen (see LiveImage / useInView).
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { ExternalLink, Radio, RefreshCw } from "lucide-react";
import type { CameraSnapshotMedia } from "@droplet/shared-types";
import {
  LiveImage,
  MediaCaption,
  MediaError,
  MediaFrame,
  MediaSpinner,
  errorCopy,
  probeStatus,
  safeSrc,
  useInView,
  withBust,
} from "./shared";

export function CameraSnapshotCard({ media }: { media: CameraSnapshotMedia }) {
  const snapshotUrl = safeSrc(media.snapshotUrl);
  const liveUrl = safeSrc(media.liveUrl);
  const isEvent = Boolean(media.eventId);
  const [stamp, setStamp] = useState(0);
  const [live, setLive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ref, inView] = useInView<HTMLDivElement>();

  const fail = useCallback(() => {
    if (!snapshotUrl) {
      setError(errorCopy(404, true));
      return;
    }
    void probeStatus(withBust(snapshotUrl, Date.now())).then((s) => setError(errorCopy(s, true)));
  }, [snapshotUrl]);

  const refresh = () => {
    setError(null);
    setLoaded(false);
    setLive(false);
    setStamp(Date.now());
  };

  if (!snapshotUrl) return null;
  const label = media.label ? `${media.camera}: ${media.label}` : media.camera;
  const showLive = live && inView && !!liveUrl;

  return (
    <MediaFrame testId="camera-snapshot-card" label={`Camera snapshot, ${label}`}>
      {error ? (
        <MediaError message={error} onRetry={refresh} />
      ) : (
        <div ref={ref} className="relative aspect-video bg-[var(--card-inner)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={stamp ? withBust(snapshotUrl, stamp) : snapshotUrl}
            alt={`Snapshot from ${label}`}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={fail}
          />
          {showLive && liveUrl ? (
            <LiveImage src={liveUrl} alt={`Live view of ${media.camera}`} onError={fail} />
          ) : null}
          {!loaded ? <MediaSpinner /> : null}
        </div>
      )}
      <MediaCaption>
        <span className="font-medium text-[var(--text)] truncate">{label}</span>
        <span className="flex-1" />
        {!isEvent ? (
          <button
            type="button"
            className="btn sm"
            onClick={refresh}
            aria-label={`Refresh snapshot from ${media.camera}`}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        ) : null}
        {!isEvent && liveUrl ? (
          <button
            type="button"
            className="btn sm"
            aria-pressed={live}
            onClick={() => {
              setError(null);
              setLive((v) => !v);
            }}
          >
            <Radio size={14} aria-hidden="true" />
            <span>{live ? "Back to snapshot" : "Go live"}</span>
          </button>
        ) : null}
        <Link
          href={`/cameras/${encodeURIComponent(media.camera)}`}
          className="btn sm"
          aria-label={`Open ${media.camera} camera page`}
        >
          <ExternalLink size={14} aria-hidden="true" />
          <span className="hidden sm:inline">Open camera</span>
        </Link>
      </MediaCaption>
    </MediaFrame>
  );
}
