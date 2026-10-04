"use client";

import { AlertTriangle, Eye, EyeOff, Layers } from "lucide-react";
import { prettifyCameraKey } from "@/lib/camera-display";
import type { ReviewItem } from "@/lib/types";
import { ThumbImage } from "./ThumbImage";

interface Props {
  review: ReviewItem;
  /** The name the household gave the camera (WARP-3509). The page resolves it
   *  from the cameras list; without one the card shows the prettified key,
   *  never the raw slug. */
  cameraName?: string;
  onClick: (review: ReviewItem) => void;
}

/**
 * The badge sits on the thumbnail, so it carries its own contrast: an OPAQUE
 * fill, with the ink that clears 4.5:1 on it in both themes — white on the
 * shell's `--danger` (6.5:1 light, 10:1 dark), black on the system orange
 * (9.5:1), white on a black scrim for plain motion. These were `bg-system-red/90`
 * and friends: Tailwind cannot put an alpha on a colour that is a CSS variable,
 * so it emitted nothing, and the badge was transparent with a white label on the
 * light placeholder (~1.08:1). events-surfaces.contrast.test.ts measures the
 * pairs; tailwind-var-alpha.guard.test.ts keeps the alpha from coming back.
 */
const SEVERITY_BADGE: Record<
  ReviewItem["severity"],
  { label: string; bg: string; text: string; icon: typeof AlertTriangle }
> = {
  alert: {
    label: "Alert",
    bg: "bg-[var(--danger)]",
    text: "text-white",
    icon: AlertTriangle,
  },
  detection: {
    label: "Detection",
    bg: "bg-system-orange",
    text: "text-black",
    icon: Eye,
  },
  significant_motion: {
    label: "Motion",
    bg: "bg-black/60",
    text: "text-white",
    icon: Layers,
  },
};

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

function fmtRange(start: number, end: number | null): string {
  // No end time: Frigate is still grouping detections into this cluster.
  if (!end) return "In progress";
  const sec = Math.max(0, Math.round(end - start));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/**
 * Tile for a Frigate review item — a cluster of detections grouped by
 * the engine. The card surfaces severity (alert/detection/motion) as
 * a coloured badge, the cluster duration, the detected object labels
 * (deduplicated), and a "viewed" pip on the right edge so the
 * operator can see at a glance which clusters they've already
 * triaged.
 *
 * The unreviewed state gets a subtle brand ring so it pops out of
 * the grid — cuts down on hunt-and-peck triage.
 */
export function ReviewCard({ review, cameraName, onClick }: Props) {
  const cameraDisplay = cameraName || prettifyCameraKey(review.camera);
  const sev = SEVERITY_BADGE[review.severity];
  const SevIcon = sev.icon;

  return (
    <button
      onClick={() => onClick(review)}
      className={`card hover overflow-hidden text-left w-full group transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${
        !review.hasBeenReviewed
          ? "ring-2 ring-[color:color-mix(in_srgb,var(--brand)_40%,transparent)]"
          : ""
      }`}
      style={{ padding: 0 }}
    >
      <div className="relative aspect-video overflow-hidden" style={{ background: "var(--inset)" }}>
        <ThumbImage
          src={review.thumbnailUrl}
          alt={`${review.severity} on ${cameraDisplay}`}
          className="w-full h-full object-cover transition-transform group-hover:scale-105"
          loading="lazy"
          retryKey={review.endTime}
        />

        {/* Top-left: severity badge */}
        <div
          className={`absolute top-2 left-2 flex items-center gap-1 px-2 py-1 rounded-full backdrop-blur-sm ${sev.bg} ${sev.text}`}
        >
          <SevIcon size={12} />
          <span className="type-caption-2 font-medium">{sev.label}</span>
        </div>

        {/* Top-right: viewed pip */}
        <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm text-white">
          {review.hasBeenReviewed ? (
            <>
              <Eye size={12} />
              <span className="type-caption-2">Viewed</span>
            </>
          ) : (
            <>
              <EyeOff size={12} />
              <span className="type-caption-2">New</span>
            </>
          )}
        </div>

        {/* Bottom-right: duration / activity */}
        <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-white type-caption-2">
          {fmtRange(review.startTime, review.endTime)}
        </div>

        {/* Bottom-left: detection count */}
        <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded bg-black/70 text-white type-caption-2 font-mono">
          {review.detectionIds.length} ev
        </div>
      </div>

      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="type-subheadline font-medium truncate text-[color:var(--text)]">
            {review.objects.length > 0
              ? review.objects.slice(0, 3).join(", ")
              : review.audio.length > 0
                ? review.audio.slice(0, 3).join(", ")
                : "Motion"}
          </span>
          <span className="type-caption-1 font-mono flex-shrink-0 text-[color:var(--text-muted)]">
            {fmtRel(review.startTime)}
          </span>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="type-caption-1 font-mono truncate text-[color:var(--text-muted)]">
            {cameraDisplay}
          </span>
        </div>
        {review.zones.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {review.zones.slice(0, 3).map((zone) => (
              <span key={zone} className="badge muted">
                {zone}
              </span>
            ))}
            {review.zones.length > 3 && (
              <span className="type-caption-2 text-[color:var(--text-muted)]">
                +{review.zones.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
