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
      <h2 className="type-headline text-label-primary">Recent Detections</h2>
      <div className="dp-card divide-y divide-separator">
        {events.map((event) => {
          const Icon = LABEL_ICONS[event.label] || Clock;
          return (
            <div key={event.id} className="flex items-center gap-3 p-3">
              {/* Thumbnail */}
              <div className="w-16 h-12 rounded bg-surface-secondary overflow-hidden flex-shrink-0">
                {event.thumbnail ? (
                  <img
                    src={event.thumbnail}
                    alt={event.label}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Icon size={16} className="text-label-quaternary" />
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon size={14} className="text-accent flex-shrink-0" />
                  <span className="type-subheadline text-label-primary font-medium capitalize">
                    {event.label}
                  </span>
                  <span className="type-caption-2 text-label-quaternary">
                    {Math.round(event.score * 100)}%
                  </span>
                </div>
                <p className="type-caption-1 text-label-tertiary truncate mt-0.5">
                  {event.camera.replace(/_/g, " ")}
                </p>
              </div>

              {/* Time */}
              <span className="type-caption-1 text-label-tertiary flex-shrink-0">
                {formatTimeAgo(event.startTime)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
