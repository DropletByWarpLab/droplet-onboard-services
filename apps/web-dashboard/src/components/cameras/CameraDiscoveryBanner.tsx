"use client";

import { Scan, Check, X } from "lucide-react";
import type { DiscoveredCamera } from "@/lib/types";

interface CameraDiscoveryBannerProps {
  cameras: DiscoveredCamera[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
}

export function CameraDiscoveryBanner({
  cameras,
  onAccept,
  onReject,
  onAcceptAll,
}: CameraDiscoveryBannerProps) {
  if (cameras.length === 0) return null;

  return (
    <div className="dp-card bg-accent-subtle border-accent/20 mb-6">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Scan size={18} className="text-accent" />
            <span className="type-subheadline text-label-primary font-medium">
              {cameras.length} new camera{cameras.length !== 1 ? "s" : ""} detected
            </span>
          </div>
          <button
            onClick={onAcceptAll}
            className="dp-btn-primary px-3 py-1.5 rounded-lg type-caption-1"
          >
            Accept All
          </button>
        </div>

        <div className="space-y-2">
          {cameras.map((cam) => (
            <div
              key={cam.id}
              className="flex items-center justify-between bg-surface-primary rounded-lg px-3 py-2"
            >
              <div className="min-w-0">
                <p className="type-footnote text-label-primary font-medium truncate">
                  {cam.name.replace(/_/g, " ")}
                </p>
                <p className="type-caption-2 text-label-tertiary">
                  {cam.ip}
                  {cam.manufacturer ? ` \u00B7 ${cam.manufacturer}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                <button
                  onClick={() => onAccept(cam.id)}
                  className="p-1.5 rounded-sm text-system-green hover:bg-system-green/10 transition-colors"
                  title="Accept"
                >
                  <Check size={16} />
                </button>
                <button
                  onClick={() => onReject(cam.id)}
                  className="p-1.5 rounded-sm text-system-red hover:bg-system-red/10 transition-colors"
                  title="Reject"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
