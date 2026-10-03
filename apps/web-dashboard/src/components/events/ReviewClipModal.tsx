"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, X } from "lucide-react";
import { prettifyCameraKey } from "@/lib/camera-display";
import type { ReviewItem } from "@/lib/types";
import { useToast } from "@/components/Toast";
import { ThumbImage } from "./ThumbImage";

interface Props {
  review: ReviewItem;
  /** The name the household gave the camera (WARP-3509). The page resolves it
   *  from the cameras list; without one the modal shows the prettified key,
   *  never the raw slug. */
  cameraName?: string;
  onClose: () => void;
  /** Mark-viewed handler. Called once when the modal opens (not every
   *  re-render) so the badge flips eagerly the moment the operator
   *  starts triaging. */
  onMarkViewed?: (review: ReviewItem) => Promise<void>;
}

/** WARP-3509 — a review with no end time has no clip yet: Frigate is still grouping detections into it. */
const IN_PROGRESS_NOTICE = "In progress — the clip is ready once this activity ends.";
const PREVIEW_FAILED_NOTICE = "The preview clip isn't available right now.";
const MARK_VIEWED_FAILED = "We couldn't mark that as viewed. Try again in a moment.";

/**
 * Inline player for a Frigate review item. Plays the cluster preview
 * mp4 when Frigate has rendered one; falls back to the cluster
 * thumbnail otherwise. Calls `onMarkViewed` on mount so the unreviewed
 * accent ring drops off without operator action — viewing == triaging
 * in this UX.
 *
 * WARP-3509: a review that is still in progress shows its thumbnail and an
 * "In progress" notice instead of a video pointed at a clip that does not exist
 * yet; a clip that fails to load falls back the same way, with its own notice;
 * and a failed mark-viewed is a toast, not silence — it never blocks the clip.
 */
export function ReviewClipModal({ review, cameraName, onClose, onMarkViewed }: Props) {
  const { toast } = useToast();

  // Track whether we've already fired the mark-viewed callback for this
  // review id. Switching to a different review re-arms it.
  const markedFor = useRef<string | null>(null);

  // The review whose clip failed to load. Keyed on the id, so moving the modal
  // to a different review gets a fresh attempt without an effect to reset it.
  const [clipFailedFor, setClipFailedFor] = useState<string | null>(null);

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
      // Not blocking: the clip still plays and the card keeps its "New" state,
      // so the operator can see it did not stick. Opening it again retries.
      toast(MARK_VIEWED_FAILED, "error");
    });
  }, [review, onMarkViewed, toast]);

  const cameraDisplay = cameraName || prettifyCameraKey(review.camera);
  const startedAt = new Date(review.startTime * 1000);

  const inProgress = review.endTime === null;
  const clipFailed = clipFailedFor === review.id;
  const clipUrl = !inProgress && !clipFailed ? review.previewUrl : null;
  const notice = inProgress ? IN_PROGRESS_NOTICE : clipFailed ? PREVIEW_FAILED_NOTICE : null;

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
          {clipUrl ? (
            <video
              key={review.id}
              src={clipUrl}
              controls
              autoPlay
              muted
              className="w-full max-h-[70vh] bg-black"
              onError={() => setClipFailedFor(review.id)}
            />
          ) : (
            <ThumbImage
              src={review.thumbnailUrl}
              alt={`${review.severity} on ${cameraDisplay}`}
              className="w-full max-h-[70vh] object-contain bg-black"
              placeholderClassName="w-full aspect-video"
              iconSize={40}
            />
          )}
          {notice && (
            <p role="status" className="px-4 py-3 type-footnote text-white/70">
              {notice}
            </p>
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
