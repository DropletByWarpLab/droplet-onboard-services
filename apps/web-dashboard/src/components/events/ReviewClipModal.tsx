"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ExternalLink, X } from "lucide-react";
import type { ReviewItem } from "@/lib/types";

interface Props {
  review: ReviewItem;
  onClose: () => void;
  /** Mark-viewed handler. Called once when the modal opens (not every
   *  re-render) so the badge flips eagerly the moment the operator
   *  starts triaging. */
  onMarkViewed?: (review: ReviewItem) => Promise<void>;
}

/**
 * Inline player for a Frigate review item. Plays the cluster preview
 * mp4 when Frigate has rendered one; falls back to the cluster
 * thumbnail otherwise. Calls `onMarkViewed` on mount so the unreviewed
 * accent ring drops off without operator action — viewing == triaging
 * in this UX.
 */
export function ReviewClipModal({ review, onClose, onMarkViewed }: Props) {
  // Track whether we've already fired the mark-viewed callback for this
  // review id. Switching to a different review re-arms it.
  const markedFor = useRef<string | null>(null);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!onMarkViewed) return;
    if (review.hasBeenReviewed) return;
    if (markedFor.current === review.id) return;
    markedFor.current = review.id;
    void onMarkViewed(review).catch(() => {
      // Silent — failing to mark viewed is not blocking. The next
      // refresh tick will retry implicitly.
    });
  }, [review, onMarkViewed]);

  const cameraDisplay = review.camera.replace(/_/g, " ");
  const startedAt = new Date(review.startTime * 1000);

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
          {review.previewUrl ? (
            <video
              key={review.id}
              src={review.previewUrl}
              controls
              autoPlay
              muted
              className="w-full max-h-[70vh] bg-black"
            />
          ) : (
            <img
              src={review.thumbnailUrl}
              alt={`${review.severity} on ${cameraDisplay}`}
              className="w-full max-h-[70vh] object-contain bg-black"
            />
          )}
        </div>

        <div className="mt-3 flex items-start justify-between gap-4 text-white">
          <div className="min-w-0 flex-1">
            <h2 className="type-headline truncate">
              {review.objects.length > 0
                ? review.objects.join(", ")
                : review.audio.length > 0
                  ? review.audio.join(", ")
                  : "Motion"}{" "}
              <span className="text-white/60 font-normal capitalize ml-1">
                · {review.severity.replace("_", " ")}
              </span>
            </h2>
            <p className="type-subheadline text-white/70 mt-0.5">
              {cameraDisplay} · {startedAt.toLocaleString()} ·{" "}
              {review.detectionIds.length} detection
              {review.detectionIds.length === 1 ? "" : "s"}
            </p>
            {review.zones.length > 0 && (
              <p className="type-caption-1 text-white/50 mt-1">
                Zones: {review.zones.join(", ")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Link
              href={`/cameras/${encodeURIComponent(review.camera)}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white type-subheadline transition-colors"
            >
              <ExternalLink size={14} />
              <span className="hidden sm:inline">Open camera</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
