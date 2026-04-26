"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, VideoOff, Circle } from "lucide-react";
import { getCameraLiveUrl, getCameraSnapshotUrl } from "@/lib/api";
import type { CameraInfo } from "@/lib/types";

interface CameraCardProps {
  camera: CameraInfo;
  onClick: (camera: CameraInfo) => void;
}

// Snapshot refresh interval. The previous 1 s bucket was too short — every
// flip remounted the <img> element (because we keyed it on the bucket) and
// the browser flashed blank between mounts. Two changes here:
//   1. Bumped to 2 s — still feels live for a security camera, halves the
//      request rate.
//   2. The <img> uses a STABLE key, and the new src is preloaded in an
//      offscreen Image() before we swap. The visible <img> only ever
//      changes when the next frame is fully decoded, so there's no blink.
const SNAPSHOT_INTERVAL_MS = 2000;

// Switch to MJPEG only on hover/focus so the grid stays cheap by default.
// 6 cards in MJPEG would burn 30–90 Mbps; 6 cards on snapshots is
// ~250 kbps. The hovered card is the one the operator actually wants
// motion in.
const HOVER_LATENCY_DELAY_MS = 250;

const STATUS_CONFIG = {
  recording: { label: "Recording", color: "bg-system-green", pulse: false },
  detecting: { label: "Detecting", color: "bg-system-orange", pulse: true },
  idle: { label: "Idle", color: "bg-label-quaternary", pulse: false },
  offline: { label: "Offline", color: "bg-system-red", pulse: false },
} as const;

export function CameraCard({ camera, onClick }: CameraCardProps) {
  const [imgError, setImgError] = useState(false);
  const [hovering, setHovering] = useState(false);
  // The src on the visible <img>. We update this ONLY after the next
  // snapshot has decoded successfully — that's what eliminates the blink.
  const [snapshotSrc, setSnapshotSrc] = useState(() =>
    `${getCameraSnapshotUrl(camera.name)}?t=${Math.floor(Date.now() / SNAPSHOT_INTERVAL_MS)}`,
  );

  const statusCfg = STATUS_CONFIG[camera.status];

  // Slight pointer-enter delay so a quick mouse-over while scrolling doesn't
  // open MJPEG streams on every card the cursor passes through.
  const hoverTimer = useRef<number | undefined>(undefined);
  const startHover = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(
      () => setHovering(true),
      HOVER_LATENCY_DELAY_MS,
    );
  }, []);
  const endHover = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    setHovering(false);
  }, []);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // Preload-then-swap: every SNAPSHOT_INTERVAL_MS, build the next URL,
  // load it offscreen, and only commit it as the visible src once it's
  // decoded. The visible <img> is never replaced with a "blank
  // loading…" state, so no flicker. If the preload errors, we surface
  // the offline icon via setImgError; the next interval will retry.
  useEffect(() => {
    if (camera.status === "offline" || hovering) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      const next = `${getCameraSnapshotUrl(camera.name)}?t=${Math.floor(
        Date.now() / SNAPSHOT_INTERVAL_MS,
      )}`;
      const probe = new window.Image();
      probe.onload = () => {
        if (cancelled) return;
        setImgError(false);
        setSnapshotSrc(next);
      };
      probe.onerror = () => {
        if (cancelled) return;
        setImgError(true);
      };
      probe.src = next;
    }, SNAPSHOT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [camera.name, camera.status, hovering]);

  // Reset error on hover-out so a stale failure doesn't pin the card on
  // the offline icon when the user comes back to it.
  useEffect(() => {
    if (!hovering) setImgError(false);
  }, [hovering]);

  const showImage = camera.status !== "offline" && !imgError;
  const useLive = showImage && hovering;

  return (
    <button
      onClick={() => onClick(camera)}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      onFocus={startHover}
      onBlur={endHover}
      className="dp-card overflow-hidden text-left w-full transition-all duration-200 ease-smooth hover:shadow-md group"
    >
      <div className="relative aspect-video bg-surface-secondary">
        {showImage ? (
          // Two persistent <img> elements stacked. The MJPEG one is only
          // mounted while hovering (so we don't burn bandwidth at rest);
          // the snapshot one stays mounted, swapping `src` only after the
          // next frame is decoded — no blink between snapshots.
          <>
            <img
              src={snapshotSrc}
              alt={camera.displayName}
              className={`w-full h-full object-cover transition-opacity duration-200 ${
                useLive ? "opacity-0" : "opacity-100"
              }`}
              onError={() => setImgError(true)}
              loading="lazy"
            />
            {useLive && (
              <img
                src={getCameraLiveUrl(camera.name)}
                alt={`${camera.displayName} live preview`}
                className="absolute inset-0 w-full h-full object-cover"
                onError={() => setImgError(true)}
              />
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <VideoOff size={32} className="text-label-quaternary" />
          </div>
        )}

        {/* Status badge */}
        <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm">
          <Circle
            size={8}
            className={`${statusCfg.color} fill-current ${statusCfg.pulse ? "animate-pulse" : ""}`}
          />
          <span className="type-caption-2 text-white">{statusCfg.label}</span>
        </div>

        {/* LIVE pip — only visible while the MJPEG stream is actually open. */}
        {useLive && (
          <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-system-red/90 backdrop-blur-sm">
            <Circle
              size={8}
              className="text-white fill-current animate-pulse"
            />
            <span className="type-caption-2 text-white font-medium tracking-wide">
              LIVE
            </span>
          </div>
        )}

        {/* "Open fullscreen" affordance — visible at rest so operators on
            touch devices know there's a destination, not just a hover
            interaction. Group-hover bumps the opacity on desktop. */}
        {showImage && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm opacity-70 group-hover:opacity-100 transition-opacity">
            <Maximize2 size={12} className="text-white" />
            <span className="type-caption-2 text-white">Open</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3">
        <h3 className="type-subheadline text-label-primary font-medium truncate">
          {camera.displayName}
        </h3>
        <div className="flex items-center justify-between mt-1">
          <p className="type-caption-1 text-label-tertiary truncate">
            {camera.manufacturer
              ? `${camera.manufacturer}${camera.model ? ` ${camera.model}` : ""}`
              : camera.ipAddress}
          </p>
          {camera.lastDetection && (
            <span className="type-caption-2 text-accent flex-shrink-0 ml-2">
              {camera.lastDetection.label}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
