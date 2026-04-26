"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Download, ExternalLink, X } from "lucide-react";
import type { EventDetail } from "@/lib/types";

interface Props {
  event: EventDetail;
  onClose: () => void;
}

/**
 * Inline player for an event. Renders the clip if Frigate saved one,
 * falls back to the high-res snapshot otherwise. Esc closes; the
 * backdrop click is also a close. The "Open camera" link routes to
 * the camera's fullscreen page so the operator can keep watching the
 * live feed without losing the events backdrop.
 *
 * `Download` is a direct link to the proxied clip URL — the browser
 * handles the save dialog. We don't add an explicit "Save" toggle
 * here yet; that's Phase 2.2 (retain_indefinitely).
 */
export function EventClipModal({ event, onClose }: Props) {
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cameraDisplay = event.camera.replace(/_/g, " ");
  const startedAt = new Date(event.startTime * 1000);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute -top-10 right-0 text-white/80 hover:text-white"
        >
          <X size={24} />
        </button>

        <div className="rounded-xl overflow-hidden bg-black shadow-2xl">
          {event.clipUrl ? (
            <video
              key={event.id}
              src={event.clipUrl}
              controls
              autoPlay
              className="w-full max-h-[70vh] bg-black"
            />
          ) : event.snapshotUrl ? (
            <img
              src={event.snapshotUrl}
              alt={`${event.label} on ${cameraDisplay}`}
              className="w-full max-h-[70vh] object-contain bg-black"
            />
          ) : (
            <img
              src={event.thumbnail}
              alt={`${event.label} on ${cameraDisplay}`}
              className="w-full max-h-[70vh] object-contain bg-black"
            />
          )}
        </div>

        {/* Metadata strip */}
        <div className="mt-3 flex items-start justify-between gap-4 text-white">
          <div className="min-w-0 flex-1">
            <h2 className="type-headline capitalize truncate">
              {event.label}
              {event.subLabel && (
                <span className="text-white/70 font-normal normal-case ml-2">
                  · {event.subLabel}
                </span>
              )}
            </h2>
            <p className="type-subheadline text-white/70 mt-0.5">
              {cameraDisplay} · {startedAt.toLocaleString()} ·{" "}
              {Math.round(event.score * 100)}% confidence
            </p>
            {event.zones.length > 0 && (
              <p className="type-caption-1 text-white/50 mt-1">
                Zones: {event.zones.join(", ")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Link
              href={`/cameras/${encodeURIComponent(event.camera)}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white type-subheadline transition-colors"
            >
              <ExternalLink size={14} />
              <span className="hidden sm:inline">Open camera</span>
            </Link>
            {event.clipUrl && (
              <a
                href={event.clipUrl}
                download={`${event.camera}-${event.label}-${event.id}.mp4`}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white type-subheadline transition-colors"
              >
                <Download size={14} />
                <span className="hidden sm:inline">Download</span>
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
