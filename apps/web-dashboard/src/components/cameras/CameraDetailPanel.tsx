"use client";

import { useState, useEffect } from "react";
import {
  X,
  Video,
  VideoOff,
  Power,
  PowerOff,
  Trash2,
  ExternalLink,
  Circle,
} from "lucide-react";
import { getCameraSnapshotUrl } from "@/lib/api";
import type { CameraInfo } from "@/lib/types";

interface CameraDetailPanelProps {
  camera: CameraInfo;
  onEnable: (name: string) => void;
  onDisable: (name: string) => void;
  onRemove: (name: string) => void;
  onClose: () => void;
}

export function CameraDetailPanel({
  camera,
  onEnable,
  onDisable,
  onRemove,
  onClose,
}: CameraDetailPanelProps) {
  // Refresh snapshot every 5 seconds
  const [snapshotKey, setSnapshotKey] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setSnapshotKey((k) => k + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  const statusColors = {
    recording: "text-system-green",
    detecting: "text-system-orange",
    idle: "text-label-quaternary",
    offline: "text-system-red",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto bg-[var(--color-surface-primary)] dp-material rounded-t-2xl sm:rounded-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-separator bg-[var(--color-surface-primary)]">
          <div>
            <h2 className="type-title-3 text-label-primary">
              {camera.displayName}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              <Circle
                size={8}
                className={`${statusColors[camera.status]} fill-current`}
              />
              <span className="type-caption-1 text-label-tertiary capitalize">
                {camera.status}
              </span>
              {camera.manufacturer && (
                <>
                  <span className="text-label-quaternary">·</span>
                  <span className="type-caption-1 text-label-tertiary">
                    {camera.manufacturer} {camera.model || ""}
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-surface-secondary transition-colors"
          >
            <X size={20} className="text-label-secondary" />
          </button>
        </div>

        {/* Live snapshot */}
        <div className="relative aspect-video bg-black">
          {camera.status !== "offline" ? (
            <img
              key={snapshotKey}
              src={`${getCameraSnapshotUrl(camera.name)}?t=${snapshotKey}`}
              alt={camera.displayName}
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <VideoOff size={48} className="text-label-quaternary" />
              <p className="type-subheadline text-label-tertiary ml-3">
                Camera offline
              </p>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="p-4 space-y-4">
          {/* Details grid */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="type-caption-2 text-label-quaternary">IP Address</p>
              <p className="type-footnote text-label-primary">
                {camera.ipAddress || "Unknown"}
              </p>
            </div>
            <div>
              <p className="type-caption-2 text-label-quaternary">MAC Address</p>
              <p className="type-footnote text-label-primary">
                {camera.macAddress || "Unknown"}
              </p>
            </div>
            <div>
              <p className="type-caption-2 text-label-quaternary">Last Seen</p>
              <p className="type-footnote text-label-primary">
                {new Date(camera.lastSeen).toLocaleString()}
              </p>
            </div>
            <div>
              <p className="type-caption-2 text-label-quaternary">Discovery</p>
              <p className="type-footnote text-label-primary">
                {camera.autoDiscovered ? "Auto-discovered" : "Manual"}
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2 border-t border-separator">
            {camera.enabled ? (
              <button
                onClick={() => onDisable(camera.name)}
                className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
              >
                <PowerOff size={16} />
                <span className="type-subheadline">Disable</span>
              </button>
            ) : (
              <button
                onClick={() => onEnable(camera.name)}
                className="dp-btn-primary flex items-center gap-2 px-3 py-2 rounded-lg"
              >
                <Power size={16} />
                <span className="type-subheadline">Enable</span>
              </button>
            )}

            <a
              href="/frigate/"
              target="_blank"
              rel="noopener noreferrer"
              className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
            >
              <ExternalLink size={16} />
              <span className="type-subheadline">Frigate UI</span>
            </a>

            <button
              onClick={() => {
                if (confirm(`Remove camera "${camera.displayName}"? This cannot be undone.`)) {
                  onRemove(camera.name);
                  onClose();
                }
              }}
              className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg text-system-red hover:bg-system-red/10 ml-auto"
            >
              <Trash2 size={16} />
              <span className="type-subheadline">Remove</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
