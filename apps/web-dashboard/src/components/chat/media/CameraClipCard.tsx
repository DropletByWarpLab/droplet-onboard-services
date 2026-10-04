"use client";
/**
 * WARP-3691 — a recorded clip / event shown inline in chat.
 *
 * Nothing is fetched until the viewer presses play: the card shows the event
 * thumbnail, and only then mounts the player (HLS for a time-range playlist,
 * a plain `<video>` for a single event's MP4). A list of ten clips therefore
 * costs ten thumbnails, not ten video downloads.
 */
import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Play } from "lucide-react";
import type { CameraClipMedia } from "@droplet/shared-types";
import { HlsPlayer } from "@/components/recordings/HlsPlayer";
import { MediaCaption, MediaError, MediaFrame, errorCopy, probeStatus, safeSrc } from "./shared";

function when(sec: number | undefined): string | null {
  if (sec === undefined) return null;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

export function CameraClipCard({ media }: { media: CameraClipMedia }) {
  const clipUrl = safeSrc(media.clipUrl);
  const playbackUrl = safeSrc(media.playbackUrl);
  const thumbnailUrl = safeSrc(media.thumbnailUrl);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!clipUrl && !playbackUrl) return null;
  const source = playbackUrl ?? clipUrl!;
  const title = [media.camera, media.label].filter(Boolean).join(": ") || "Camera clip";
  const time = when(media.startTime);

  const fail = () => {
    setPlaying(false);
    void probeStatus(thumbnailUrl ?? source).then((s) => setError(errorCopy(s, true)));
  };

  return (
    <MediaFrame testId="camera-clip-card" label={`Camera clip, ${title}`}>
      {error ? (
        <MediaError
          message={error}
          onRetry={() => {
            setError(null);
            setPlaying(true);
          }}
        />
      ) : (
        <div className="relative aspect-video bg-[var(--card-inner)]">
          {playing ? (
            playbackUrl ? (
              <HlsPlayer src={playbackUrl} autoPlay onError={fail} className="absolute inset-0 w-full h-full" />
            ) : (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                src={clipUrl}
                poster={thumbnailUrl}
                controls
                autoPlay
                playsInline
                preload="metadata"
                className="absolute inset-0 w-full h-full bg-black"
                onError={fail}
              />
            )
          ) : (
            <>
              {thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbnailUrl}
                  alt={`Thumbnail of ${title}`}
                  className="absolute inset-0 w-full h-full object-cover"
                  loading="lazy"
                  onError={fail}
                />
              ) : null}
              <button
                type="button"
                onClick={() => setPlaying(true)}
                className="absolute inset-0 flex items-center justify-center bg-black/30 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                aria-label={`Play clip: ${title}`}
              >
                <span className="flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 type-subheadline">
                  <Play size={16} aria-hidden="true" />
                  Play clip
                </span>
              </button>
            </>
          )}
        </div>
      )}
      <MediaCaption>
        <span className="font-medium text-[var(--text)] truncate">{title}</span>
        {time ? <span className="truncate">{time}</span> : null}
        <span className="flex-1" />
        {media.camera ? (
          <Link
            href={`/cameras/${encodeURIComponent(media.camera)}`}
            className="btn sm"
            aria-label={`Open ${media.camera} camera page`}
          >
            <ExternalLink size={14} aria-hidden="true" />
            <span className="hidden sm:inline">Open camera</span>
          </Link>
        ) : null}
      </MediaCaption>
    </MediaFrame>
  );
}
