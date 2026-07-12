"use client";

import { Clock, User, Car, Dog } from "lucide-react";
import type { DetectionEvent } from "@/lib/types";

interface CameraEventsProps {
  events: DetectionEvent[];
}

const LABEL_ICONS: Record<string, typeof User> = {
  person: User,
  car: Car,
  dog: Dog,
};

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() / 1000) - timestamp);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function CameraEvents({ events }: CameraEventsProps) {
  if (events.length === 0) return null;

  return (
    <div className="space-y-3">
      <h2 className="type-headline" style={{ color: "var(--text)" }}>
        Recent Detections
      </h2>
      <div className="card" style={{ padding: 0 }}>
        <div className="rows">
          {events.map((event) => {
            const Icon = LABEL_ICONS[event.label] || Clock;
            return (
              <div key={event.id} className="lrow">
                {/* Thumbnail — only render if URL starts with our safe API prefix */}
                <div
                  className="w-16 h-12 rounded overflow-hidden flex-shrink-0"
                  style={{ background: "var(--card-inner)" }}
                >
                  {event.thumbnail && event.thumbnail.startsWith("/api/") ? (
                    <img
                      src={event.thumbnail}
                      alt={event.label}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Icon size={16} style={{ color: "var(--text-faint)" }} />
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="rt">
                  <div className="flex items-center gap-2">
                    <Icon size={14} className="flex-shrink-0" style={{ color: "var(--brand)" }} />
                    <span
                      className="type-subheadline font-medium capitalize"
                      style={{ color: "var(--text)" }}
                    >
                      {event.label}
                    </span>
                    <span className="type-caption-2" style={{ color: "var(--text-faint)" }}>
                      {Math.round(event.score * 100)}%
                    </span>
                  </div>
                  <p
                    className="type-caption-1 truncate mt-0.5"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {event.camera.replace(/_/g, " ")}
                  </p>
                </div>

                {/* Time */}
                <span
                  className="type-caption-1 flex-shrink-0"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatTimeAgo(event.startTime)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
