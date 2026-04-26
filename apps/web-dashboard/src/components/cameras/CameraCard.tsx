"use client";

import { useEffect, useRef, useState } from "react";
import { VideoOff, Circle } from "lucide-react";
import { getCameraLiveUrl, getCameraSnapshotUrl } from "@/lib/api";
import type { CameraInfo } from "@/lib/types";

interface CameraCardProps {
  camera: CameraInfo;
  onClick: (camera: CameraInfo) => void;
}

// 1-second cache bucket: short enough to feel "near-live" on the grid, long
// enough that the browser still hits its HTTP cache between paint cycles
// rather than thrashing a fresh request every animation frame. Pairs with
// the orchestrator's `max-age=5` Cache-Control on /snapshot — overlapping
// short freshness windows let any transient 401/500/Frigate-restart unstick
// itself within a second instead of pinning the broken image forever.
const SNAPSHOT_BUCKET_MS = 1000;

// Switch to MJPEG only on hover/focus so the grid stays cheap by default.
// 6 cards in MJPEG would burn 30–90 Mbps; 6 cards on 1 s snapshots is
// ~480 kbps. The hovered card is the one the operator actually wants
// motion in.
const HOVER_LATENCY_DELAY_MS = 250;

function useSnapshotKey(intervalMs: number) {
  const [key, setKey] = useState(() => Math.floor(Date.now() / intervalMs));
  useEffect(() => {
    const id = window.setInterval(
      () => setKey(Math.floor(Date.now() / intervalMs)),
      intervalMs,
    );
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return key;
}

const STATUS_CONFIG = {
  recording: { label: "Recording", color: "bg-system-green", pulse: false },
  detecting: { label: "Detecting", color: "bg-system-orange", pulse: true },
  idle: { label: "Idle", color: "bg-label-quaternary", pulse: false },
  offline: { label: "Offline", color: "bg-system-red", pulse: false },
} as const;

export function CameraCard({ camera, onClick }: CameraCardProps) {
  const [imgError, setImgError] = useState(false);
  const [hovering, setHovering] = useState(false);
  const snapshotKey = useSnapshotKey(SNAPSHOT_BUCKET_MS);

  // Slight pointer-enter delay so a quick mouse-over while scrolling doesn't
  // open MJPEG streams on every card the cursor passes through. The viewer
  // has to actually rest on a card for ~250 ms before we light up the feed.
  const hoverTimer = useRef<number | undefined>(undefined);
  function startHover() {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovering(true), HOVER_LATENCY_DELAY_MS);
  }
  function endHover() {
    window.clearTimeout(hoverTimer.current);
    setHovering(false);
  }
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // Reset imgError on bucket flip so a transient failure (camera briefly
  // unreachable, Frigate restart, etc.) doesn't pin the card on the offline
  // icon forever.
  useEffect(() => {
    setImgError(false);
  }, [snapshotKey]);

  const statusCfg = STATUS_CONFIG[camera.status];
  const showImage = camera.status !== "offline" && !imgError;
  const useLive = showImage && hovering;

  return (
    <button
      onClick={() => onClick(camera)}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      onFocus={startHover}
      onBlur={endHover}
      className="dp-card overflow-hidden text-left w-full transition-all duration-200 ease-smooth hover:shadow-md"
    >
      <div className="relative aspect-video bg-surface-secondary">
        {showImage ? (
          // The MJPEG <img> on hover and the snapshot <img> at rest are
          // separate elements so React unmounts the multipart connection
          // cleanly the moment the operator moves the cursor away — keeps
          // open MJPEG streams to one at a time across the whole grid.
          useLive ? (
            <img
              key={`live-${camera.name}`}
              src={getCameraLiveUrl(camera.name)}
              alt={`${camera.displayName} live preview`}
              className="w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <img
              key={`snap-${snapshotKey}`}
              src={`${getCameraSnapshotUrl(camera.name)}?t=${snapshotKey}`}
              alt={camera.displayName}
              className="w-full h-full object-cover"
              onError={() => setImgError(true)}
              loading="lazy"
            />
          )
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

        {/* LIVE pip — only while the MJPEG stream is actually open. */}
        {useLive && (
          <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-system-red/90 backdrop-blur-sm">
            <Circle size={8} className="text-white fill-current animate-pulse" />
            <span className="type-caption-2 text-white font-medium tracking-wide">LIVE</span>
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
