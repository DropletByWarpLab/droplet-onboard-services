"use client";

import { CameraCard } from "./CameraCard";
import type { CameraInfo } from "@/lib/types";

interface CameraGridProps {
  cameras: CameraInfo[];
  onCameraClick: (camera: CameraInfo) => void;
}

export function CameraGrid({ cameras, onCameraClick }: CameraGridProps) {
  if (cameras.length === 0) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {cameras.map((camera) => (
        <CameraCard
          key={camera.name}
          camera={camera}
          onClick={onCameraClick}
        />
      ))}
    </div>
  );
}
