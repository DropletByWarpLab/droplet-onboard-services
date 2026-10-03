"use client";

import { CameraCard } from "./CameraCard";
import type { CameraInfo } from "@/lib/types";

interface CameraGridProps {
  cameras: CameraInfo[];
  onCameraClick: (camera: CameraInfo) => void;
  /** Optional pin set + toggle handler. When both are wired, every card
   *  renders the pin affordance and reflects its pinned state. Kept
   *  optional so existing callers (e.g. the camera detail page rail) can
   *  still drop the grid in without taking on pin state. */
  pinnedSet?: Set<string>;
  onTogglePin?: (camera: CameraInfo) => void | Promise<void>;
  /** WARP-3511: opens a camera's settings from its tile. Wired only for
   *  owners and admins; absent, no tile draws the gear. */
  onOpenSettings?: (camera: CameraInfo) => void;
}

export function CameraGrid({
  cameras,
  onCameraClick,
  pinnedSet,
  onTogglePin,
  onOpenSettings,
}: CameraGridProps) {
  if (cameras.length === 0) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {cameras.map((camera) => (
        <CameraCard
          key={camera.name}
          camera={camera}
          onClick={onCameraClick}
          isPinned={pinnedSet?.has(camera.name) ?? false}
          onTogglePin={onTogglePin}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </div>
  );
}
