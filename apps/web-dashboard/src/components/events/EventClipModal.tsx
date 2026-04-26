"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Bookmark,
  Download,
  ExternalLink,
  Loader2,
  Tag,
  X,
} from "lucide-react";
import { tagEventAsFace } from "@/lib/api";
import type { EventDetail } from "@/lib/types";

interface Props {
  event: EventDetail;
  onClose: () => void;
  /** Toggle the retain-indefinitely flag. When wired, the modal
   *  renders a "Save / Saved" button. The handler should call the
   *  /retain route and invalidate the events SWR cache so the badge on
   *  the underlying card flips on close. */
  onToggleRetain?: (event: EventDetail, retain: boolean) => Promise<void>;
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
export function EventClipModal({ event, onClose, onToggleRetain }: Props) {
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Local optimistic state for the Save toggle so the button flips
  // immediately on click. Reset whenever the modal switches to a new
  // event (operator clicked through to a different one).
  const [retained, setRetained] = useState(event.retainIndefinitely);
  const [retainBusy, setRetainBusy] = useState(false);
  useEffect(() => {
    setRetained(event.retainIndefinitely);
  }, [event.id, event.retainIndefinitely]);

  const handleToggleRetain = async () => {
    if (!onToggleRetain || retainBusy) return;
    const next = !retained;
    setRetainBusy(true);
    setRetained(next); // optimistic
    try {
      await onToggleRetain(event, next);
    } catch (e) {
      // Roll back on failure — leave the operator with an accurate state.
      setRetained(!next);
      alert(e instanceof Error ? e.message : "Failed to update Saved state");
    } finally {
      setRetainBusy(false);
    }
  };

  // "Tag as person" — feeds Frigate's face recogniser. Only meaningful
  // for person-labeled events; we render the button conditionally
  // below to avoid suggesting "tag this car as Alice."
  const [tagging, setTagging] = useState(false);
  const handleTag = async () => {
    const name = window
      .prompt("Tag this person — letters, numbers, spaces, hyphens, underscores")
      ?.trim();
    if (!name) return;
    if (!/^[a-zA-Z0-9_ -]{1,40}$/.test(name)) {
      alert("Invalid name — keep it under 40 chars, no special characters.");
      return;
    }
    setTagging(true);
    try {
      await tagEventAsFace(event.id, name);
      alert(`Tagged as ${name}. Frigate will use this snapshot for future recognition.`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Tag failed");
    } finally {
      setTagging(false);
    }
  };

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
            {event.label === "person" && (
              <button
                onClick={handleTag}
                disabled={tagging}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 type-subheadline transition-colors disabled:opacity-50"
                title="Tag this person for face recognition"
              >
                {tagging ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Tag size={14} />
                )}
                <span className="hidden sm:inline">Tag person</span>
              </button>
            )}
            {onToggleRetain && (
              <button
                onClick={handleToggleRetain}
                disabled={retainBusy}
                aria-pressed={retained}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg type-subheadline transition-colors ${
                  retained
                    ? "bg-system-yellow/20 text-system-yellow hover:bg-system-yellow/30"
                    : "bg-white/10 text-white hover:bg-white/20"
                } ${retainBusy ? "opacity-60 cursor-wait" : ""}`}
                title={retained ? "Unsave (allow normal retention)" : "Save (retain indefinitely)"}
              >
                {retainBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Bookmark
                    size={14}
                    className={retained ? "fill-current" : ""}
                  />
                )}
                <span className="hidden sm:inline">
                  {retained ? "Saved" : "Save"}
                </span>
              </button>
            )}
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
