"use client";

import { Bookmark, Film, Image as ImageIcon } from "lucide-react";
import type { EventDetail } from "@/lib/types";

interface Props {
  event: EventDetail;
  onClick: (event: EventDetail) => void;
}

function fmtRel(epochSec: number): string {
  const ms = Date.now() - epochSec * 1000;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function fmtDuration(start: number, end: number | null): string {
  if (!end) return "—";
  const sec = Math.max(0, Math.round(end - start));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/**
 * Single event tile rendered in the Events grid. Mirrors the camera
 * card aspect ratio + clickable area, but the metadata strip below the
 * thumbnail is event-centric: label, score, camera, time-since,
 * duration. Badges in the corners surface saved-clip vs snapshot-only
 * and the retain-indefinitely state ("Saved").
 */
export function EventCard({ event, onClick }: Props) {
  const cameraDisplay = event.camera.replace(/_/g, " ");
  return (
    <button
      onClick={() => onClick(event)}
      className="dp-card overflow-hidden text-left w-full group transition-all hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="relative aspect-video bg-surface-secondary overflow-hidden">
        <img
          src={event.thumbnail}
          alt={`${event.label} on ${cameraDisplay}`}
          className="w-full h-full object-cover transition-transform group-hover:scale-105"
          loading="lazy"
        />

        {/* Top-left: media-type pill (clip > snapshot > none) */}
        {(event.hasClip || event.hasSnapshot) && (
          <div className="absolute top-2 left-2 flex items-center gap-1 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm text-white">
            {event.hasClip ? <Film size={12} /> : <ImageIcon size={12} />}
            <span className="type-caption-2">
              {event.hasClip ? "Clip" : "Photo"}
            </span>
          </div>
        )}

        {/* Top-right: retain badge — "Saved" when retain_indefinitely. */}
        {event.retainIndefinitely && (
          <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-full bg-system-yellow/90 backdrop-blur-sm text-black">
            <Bookmark size={12} className="fill-current" />
            <span className="type-caption-2 font-medium">Saved</span>
          </div>
        )}

        {/* Bottom-right: duration when there's a clip. */}
        {event.hasClip && event.endTime && (
          <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-white type-caption-2">
            {fmtDuration(event.startTime, event.endTime)}
          </div>
        )}

        {/* Bottom-left: score chip. */}
        <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded bg-black/70 text-white type-caption-2 font-mono">
          {Math.round(event.score * 100)}%
        </div>
      </div>

      <div className="p-3">
        <div className="flex items-center justify-between">
          <span className="type-subheadline text-label-primary font-medium capitalize truncate">
            {event.label}
            {event.subLabel && (
              <span className="text-label-tertiary font-normal ml-1.5 normal-case">
                · {event.subLabel}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="type-caption-1 text-label-tertiary truncate">
            {cameraDisplay}
          </span>
          <span className="type-caption-1 text-label-tertiary flex-shrink-0 ml-2">
            {fmtRel(event.startTime)}
          </span>
        </div>
        {event.zones.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {event.zones.slice(0, 3).map((zone) => (
              <span
                key={zone}
                className="type-caption-2 px-1.5 py-0.5 rounded bg-surface-secondary text-label-secondary"
              >
                {zone}
              </span>
            ))}
            {event.zones.length > 3 && (
              <span className="type-caption-2 text-label-tertiary">
                +{event.zones.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
