"use client";
/**
 * WARP-3691 — a live camera feed (MJPEG) inline in chat.
 *
 * Connection discipline, because a held MJPEG stream costs real bandwidth and
 * one of the browser's ~6 sockets per origin:
 *   - the stream is connected only while the card is VISIBLE (IntersectionObserver);
 *     scrolling away clears `src` and closes it, scrolling back reconnects if
 *     the viewer still wants it;
 *   - unmount closes it too (LiveImage cleanup);
 *   - it starts on click, except when this is the only feed in the message
 *     (`autoStart`) — several feeds in one answer never all connect at once.
 * Until then the card shows a snapshot poster.
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { ExternalLink, Pause, Play } from "lucide-react";
import type { CameraLiveMedia } from "@droplet/shared-types";
import {
  LiveImage,
  MediaCaption,
  MediaError,
  MediaFrame,
  errorCopy,
  probeStatus,
  safeSrc,
  useInView,
  withBust,
} from "./shared";

export function CameraLiveCard({ media, autoStart = false }: { media: CameraLiveMedia; autoStart?: boolean }) {
  const liveUrl = safeSrc(media.liveUrl);
  const snapshotUrl = safeSrc(media.snapshotUrl);
  const [want, setWant] = useState(autoStart);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ref, inView] = useInView<HTMLDivElement>();

  const fail = useCallback(() => {
    setWant(false);
    setConnected(false);
    // The stream URL never ends, so ask the snapshot route (same ACL) why.
    if (!snapshotUrl) {
      setError(errorCopy(404, true));
      return;
    }
    void probeStatus(withBust(snapshotUrl, Date.now())).then((s) => setError(errorCopy(s, true)));
  }, [snapshotUrl]);

  if (!liveUrl || !snapshotUrl) return null;
  const active = want && inView;

  return (
    <MediaFrame testId="camera-live-card" label={`Live camera, ${media.camera}`}>
      {error ? (
        <MediaError
          message={error}
          onRetry={() => {
            setError(null);
            setWant(true);
          }}
        />
      ) : (
        <div ref={ref} className="relative aspect-video bg-[var(--card-inner)]">
          {/* Poster stays underneath so a stalled or paused stream never shows a blank box. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={snapshotUrl}
            alt={`Latest frame from ${media.camera}`}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
          {active ? (
            <LiveImage
              src={liveUrl}
              alt={`Live view of ${media.camera}`}
              onError={fail}
              onLoad={() => setConnected(true)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setWant(true)}
              className="absolute inset-0 flex items-center justify-center bg-black/30 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              aria-label={`Play live view of ${media.camera}`}
            >
              <span className="flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 type-subheadline">
                <Play size={16} aria-hidden="true" />
                {want ? "Resume live view" : "Watch live"}
              </span>
            </button>
          )}
          {active && connected ? (
            <span className="absolute top-2 left-2 rounded-full bg-system-red px-2 py-0.5 type-caption-2 text-white">
              LIVE
            </span>
          ) : null}
        </div>
      )}
      <MediaCaption>
        <span className="font-medium text-[var(--text)] truncate">{media.camera}</span>
        <span className="flex-1" />
        {want && !error ? (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setWant(false);
              setConnected(false);
            }}
          >
            <Pause size={14} aria-hidden="true" />
            <span>Stop</span>
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
