"use client";

import { AlertTriangle, Eye, EyeOff, Layers } from "lucide-react";
import type { ReviewItem } from "@/lib/types";

interface Props {
  review: ReviewItem;
  onClick: (review: ReviewItem) => void;
}

const SEVERITY_BADGE: Record<
  ReviewItem["severity"],
  { label: string; bg: string; text: string; icon: typeof AlertTriangle }
> = {
  alert: {
    label: "Alert",
    bg: "bg-system-red/90",
    text: "text-white",
    icon: AlertTriangle,
  },
  detection: {
    label: "Detection",
    bg: "bg-system-orange/90",
    text: "text-white",
    icon: Eye,
  },
  significant_motion: {
    label: "Motion",
    bg: "bg-label-secondary/90",
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
  if (!end) return "Active";
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
export function ReviewCard({ review, onClick }: Props) {
  const cameraDisplay = review.camera.replace(/_/g, " ");
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
        <img
          src={review.thumbnailUrl}
          alt={`${review.severity} on ${cameraDisplay}`}
          className="w-full h-full object-cover transition-transform group-hover:scale-105"
          loading="lazy"
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
