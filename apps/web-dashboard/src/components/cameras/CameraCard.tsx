"use client";

import { useState } from "react";
import { Video, VideoOff, Eye, Circle } from "lucide-react";
import { getCameraSnapshotUrl } from "@/lib/api";
import type { CameraInfo } from "@/lib/types";

interface CameraCardProps {
  camera: CameraInfo;
  onClick: (camera: CameraInfo) => void;
}

const STATUS_CONFIG = {
  recording: { label: "Recording", color: "bg-system-green", pulse: false },
  detecting: { label: "Detecting", color: "bg-system-orange", pulse: true },
  idle: { label: "Idle", color: "bg-label-quaternary", pulse: false },
  offline: { label: "Offline", color: "bg-system-red", pulse: false },
} as const;

export function CameraCard({ camera, onClick }: CameraCardProps) {
  const [imgError, setImgError] = useState(false);
  const statusCfg = STATUS_CONFIG[camera.status];

  return (
    <button
      onClick={() => onClick(camera)}
      className="dp-card overflow-hidden text-left w-full transition-all duration-200 ease-smooth hover:shadow-md"
    >
      {/* Snapshot thumbnail */}
      <div className="relative aspect-video bg-surface-secondary">
        {camera.status !== "offline" && !imgError ? (
          <img
            src={getCameraSnapshotUrl(camera.name)}
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
