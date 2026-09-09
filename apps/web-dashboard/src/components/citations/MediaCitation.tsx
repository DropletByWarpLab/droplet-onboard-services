"use client";

/**
 * Audio / video deep-link viewer. The `media-timestamp` anchor carries
 * `startMs` + `endMs` (the chunk's time bracket); we seek the element
 * to `startMs / 1000` on mount so the user lands on the cited segment.
 *
 * We pick `<audio>` vs `<video>` from the MIME type rather than the
 * anchor alone — the anchor is medium-agnostic on purpose so the same
 * extractor pattern works for podcasts, video lectures, conference
 * recordings, etc.
 */

import { useEffect, useRef, type JSX } from "react";
import Link from "next/link";
import type { MediaTimestampAnchor } from "@droplet/shared-types";
import type { CitationHit } from "./CitationCard";

export interface MediaCitationProps {
  hit: CitationHit;
  anchor: MediaTimestampAnchor;
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function MediaCitation({ hit, anchor }: MediaCitationProps): JSX.Element {
  const ref = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const isVideo = hit.mimeType.startsWith("video/");
  const src = `/api/files/${encodeURIComponent(hit.fileId)}/content`;
  const startSec = anchor.startMs / 1000;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Some browsers won't accept currentTime until the metadata is
    // loaded; bind both paths so the seek lands on first paint or as
    // soon as duration is known, whichever comes first.
    const seek = () => {
      try {
        el.currentTime = startSec;
      } catch {
        // ignore — browsers throw if duration is still NaN
      }
    };
    if (Number.isFinite(el.duration) && el.duration > 0) {
      seek();
    } else {
      el.addEventListener("loadedmetadata", seek, { once: true });
      return () => el.removeEventListener("loadedmetadata", seek);
    }
  }, [startSec]);

  const detailHref = `/files/${encodeURIComponent(hit.fileId)}`;
  return (
    <div
      className="overflow-hidden rounded-2xl"
      style={{ background: "var(--card-bg)", border: "1px solid var(--card-bd)" }}
      data-citation-kind="media-timestamp"
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid var(--card-bd)" }}
      >
        <Link
          href={detailHref}
          className="type-caption-1 truncate hover:underline text-[var(--text)]"
          title={hit.filename}
        >
          {hit.filename}
        </Link>
        <span className="type-caption-2 flex-shrink-0 text-[var(--text-muted)]">
          {formatMs(anchor.startMs)}–{formatMs(anchor.endMs)}
        </span>
      </div>
      {isVideo ? (
        <video
          ref={ref as React.RefObject<HTMLVideoElement>}
          data-testid="media-video"
          src={src}
          controls
          preload="metadata"
          className="w-full max-h-80 bg-black"
        />
      ) : (
        <audio
          ref={ref as React.RefObject<HTMLAudioElement>}
          data-testid="media-audio"
          src={src}
          controls
          preload="metadata"
          className="w-full"
        />
      )}
      {hit.chunkText && (
        <p className="px-3 py-2 type-caption-1 line-clamp-3 text-[var(--text-muted)]">
          {hit.chunkText}
        </p>
      )}
    </div>
  );
}
