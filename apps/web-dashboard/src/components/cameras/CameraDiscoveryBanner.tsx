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
    <div
      className="card mb-6"
      style={{
        background: "var(--brand-subtle)",
        borderColor: "color-mix(in srgb, var(--brand) 20%, transparent)",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Scan size={18} style={{ color: "var(--brand)" }} />
          <span
            className="type-subheadline font-medium"
            style={{ color: "var(--text)" }}
          >
            {cameras.length} new camera{cameras.length !== 1 ? "s" : ""} detected
          </span>
        </div>
        <button onClick={onAcceptAll} className="btn primary sm type-caption-1">
          Accept All
        </button>
      </div>

      <div className="space-y-2">
        {cameras.map((cam) => (
          <div
            key={cam.id}
            className="flex items-center justify-between rounded-lg px-3 py-2"
            style={{ background: "var(--surface)" }}
          >
            <div className="min-w-0">
              <p
                className="type-footnote font-medium truncate"
                style={{ color: "var(--text)" }}
              >
                {cam.name.replace(/_/g, " ")}
              </p>
              <p
                className="type-caption-2"
                style={{ color: "var(--text-muted)" }}
              >
                {cam.ip}
                {cam.manufacturer ? ` \u00B7 ${cam.manufacturer}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0 ml-2">
              <button
                onClick={() => onAccept(cam.id)}
                className="p-1.5 rounded-sm max-lg:inline-flex max-lg:items-center max-lg:justify-center max-lg:h-11 max-lg:w-11 hover:bg-[rgba(34,197,94,0.1)] transition-colors"
                style={{ color: "var(--success)" }}
                title="Accept"
              >
                <Check size={16} />
              </button>
              <button
                onClick={() => onReject(cam.id)}
                className="p-1.5 rounded-sm max-lg:inline-flex max-lg:items-center max-lg:justify-center max-lg:h-11 max-lg:w-11 hover:bg-[rgba(239,68,68,0.1)] transition-colors"
                style={{ color: "var(--danger)" }}
                title="Reject"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
