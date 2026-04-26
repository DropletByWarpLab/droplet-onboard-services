"use client";

import { useEffect, useState } from "react";
import { Video, VideoOff, Eye, Circle } from "lucide-react";
import { getCameraSnapshotUrl } from "@/lib/api";
import type { CameraInfo } from "@/lib/types";

interface CameraCardProps {
  camera: CameraInfo;
  onClick: (camera: CameraInfo) => void;
}

// Bucket Date.now() into 5-second windows so the <img> URL changes every
// 5s and the browser can't pin a stale 401/500 response under HTTP cache.
// The orchestrator already sets max-age=5 on the snapshot, so this matches
// its freshness window — refresh = one network request, not a thrash.
function useSnapshotKey(intervalMs = 5000) {
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
  const snapshotKey = useSnapshotKey();
  const statusCfg = STATUS_CONFIG[camera.status];

  // Reset the imgError flag whenever the cache-bucket flips so a transient
  // failure (camera briefly unreachable, Frigate restart, etc.) doesn't
  // pin the card on the offline icon forever.
  useEffect(() => {
    setImgError(false);
  }, [snapshotKey]);

  return (
    <button
      onClick={() => onClick(camera)}
      className="dp-card overflow-hidden text-left w-full transition-all duration-200 ease-smooth hover:shadow-md"
    >
      {/* Snapshot thumbnail */}
      <div className="relative aspect-video bg-surface-secondary">
        {camera.status !== "offline" && !imgError ? (
          <img
            key={snapshotKey}
            src={`${getCameraSnapshotUrl(camera.name)}?t=${snapshotKey}`}
            alt={camera.displayName}
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
            loading="lazy"
          />
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
