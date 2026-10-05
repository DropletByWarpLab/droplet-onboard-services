"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import { prettifyCameraKey } from "@/lib/camera-display";
import type { ReviewItem } from "@/lib/types";
import { useToast } from "@/components/Toast";
import { Dialog } from "@/components/Dialog";
import { HlsPlayer } from "@/components/recordings/HlsPlayer";
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
 * yet; a clip that fails to load falls back the same way, with an alert and a
 * Retry; and a failed mark-viewed is a toast, not silence — it never blocks the
 * clip.
 *
 * WARP-3509: built on the shared <Dialog>, like the event modal, so the ARIA
 * (role, aria-modal, label), the focus trap, the scroll lock and Escape come
 * from there rather than from a hand-rolled overlay that had none of them.
 */
function ReviewPlayback({ review, cameraDisplay }: { review: ReviewItem; cameraDisplay: string }) {
  const inProgress = review.endTime === null;
  const [playback, setPlayback] = useState<"preview" | "recording" | "failed">(!inProgress && review.previewUrl ? "preview" : "recording");
  const [attempt, setAttempt] = useState(0);
  const before = useMemo(() => review.endTime ?? Math.floor(Date.now() / 1000), [review.endTime, attempt]);
  const recordingUrl = `/api/cameras/${encodeURIComponent(review.camera)}/playback.m3u8?after=${review.startTime}&before=${Math.max(review.startTime + 1, before)}`;
  const handleRecordingError = useCallback(() => setPlayback("failed"), []);
  const startedAt = new Date(review.startTime * 1000);
  const date = `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, "0")}-${String(startedAt.getDate()).padStart(2, "0")}`;
  const retry = () => {
    setAttempt((n) => n + 1);
    setPlayback(!inProgress && review.previewUrl ? "preview" : "recording");
  };
  return (
    <div className="rounded-lg overflow-hidden" style={{ background: "var(--inset)" }}>
      {playback === "recording" ? (
        <HlsPlayer key={attempt} src={recordingUrl} onError={handleRecordingError} className="w-full max-h-[60vh]" muted />
      ) : playback === "preview" && !inProgress && review.previewUrl ? (
        <video key={attempt} src={review.previewUrl} controls autoPlay muted className="w-full max-h-[60vh]" onError={() => setPlayback("recording")} />
      ) : (
        <ThumbImage src={review.thumbnailUrl} alt={`${review.severity} on ${cameraDisplay}`} className="w-full max-h-[60vh] object-contain" placeholderClassName="w-full aspect-video" iconSize={40} retryKey={review.endTime} />
      )}
      {inProgress && <p role="status" className="px-3 py-2 type-footnote" style={{ color: "var(--text-muted)" }}>{IN_PROGRESS_NOTICE}</p>}
      {playback === "failed" && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
          <p role="alert" className="type-footnote text-[color:var(--danger-ink)]">{PREVIEW_FAILED_NOTICE}</p>
          <button type="button" className="btn ghost sm" onClick={retry}><RefreshCw size={12} /> Retry</button>
          <Link className="btn ghost sm" href={`/cameras/${encodeURIComponent(review.camera)}/recordings?date=${date}`}>Browse recordings</Link>
        </div>
      )}
    </div>
  );
}

export function ReviewClipModal({ review, cameraName, onClose, onMarkViewed }: Props) {
  const headingId = useId();
  const { toast } = useToast();

  // Track whether we've already fired the mark-viewed callback for this
  // review id. Switching to a different review re-arms it.
  const markedFor = useRef<string | null>(null);

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

  return (
    // `flush`: sectioned layout — the header divider owns its padding, like the
    // event modal (WARP-1153).
    <Dialog open onClose={onClose} labelledBy={headingId} maxWidth="xl" flush>
      <div
        className="flex items-center justify-between gap-3 px-4 py-3"
        style={{ borderBottom: "1px solid var(--card-bd)" }}
      >
        <h2 id={headingId} className="type-headline truncate" style={{ color: "var(--text)" }}>
          {review.objects.length > 0
            ? review.objects.join(", ")
            : review.audio.length > 0
              ? review.audio.join(", ")
              : "Motion"}
          <span className="font-normal capitalize ml-2" style={{ color: "var(--text-muted)" }}>
            · {review.severity.replace("_", " ")}
          </span>
        </h2>
        <button onClick={onClose} aria-label="Close" className="icon-btn" style={{ width: 32, height: 32 }}>
          <X size={18} />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <ReviewPlayback key={review.id} review={review} cameraDisplay={cameraDisplay} />

        {/* Details + actions. The details ask for 16rem before anything may sit
            beside them, as in the event modal. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-[16rem]">
            <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
              {cameraDisplay} · {startedAt.toLocaleString()} · {review.detectionIds.length} detection
              {review.detectionIds.length === 1 ? "" : "s"}
            </p>
            {review.zones.length > 0 && (
              <p className="type-caption-1 mt-1" style={{ color: "var(--text-muted)" }}>
                Zones: {review.zones.join(", ")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            <Link href={`/cameras/${encodeURIComponent(review.camera)}`} className="btn">
              <ExternalLink size={14} />
              <span className="hidden sm:inline">Open camera</span>
            </Link>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
