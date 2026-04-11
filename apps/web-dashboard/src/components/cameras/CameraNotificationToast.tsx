"use client";

import { X, User, Car, Dog, Scan } from "lucide-react";
import type { CameraSSEEvent } from "@/lib/types";

interface CameraNotificationToastProps {
  notifications: CameraSSEEvent[];
  onDismiss: (index: number) => void;
}

const LABEL_ICONS: Record<string, typeof User> = {
  person: User,
  car: Car,
  dog: Dog,
};

export function CameraNotificationToast({
  notifications,
  onDismiss,
}: CameraNotificationToastProps) {
  if (notifications.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
      {notifications.map((notif, index) => {
        if (notif.type === "detection") {
          const Icon = LABEL_ICONS[notif.label || ""] || User;
          return (
            <div
              key={`${notif.timestamp}-${index}`}
              className="dp-card bg-[var(--color-surface-primary)] shadow-lg border border-separator animate-in slide-in-from-right"
            >
              <div className="flex items-start gap-3 p-3">
                {notif.thumbnail ? (
                  <img
                    src={notif.thumbnail}
                    alt={notif.label || "Detection"}
                    className="w-12 h-12 rounded object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-12 h-12 rounded bg-accent/10 flex items-center justify-center flex-shrink-0">
                    <Icon size={20} className="text-accent" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="type-footnote text-label-primary font-medium capitalize">
                    {notif.label} detected
                  </p>
                  <p className="type-caption-2 text-label-tertiary">
                    {notif.camera?.replace(/_/g, " ")}
                    {notif.score ? ` \u00B7 ${Math.round(notif.score * 100)}%` : ""}
                  </p>
                </div>
                <button
                  onClick={() => onDismiss(index)}
                  className="p-1 text-label-quaternary hover:text-label-secondary"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          );
        }

        if (notif.type === "camera_discovered") {
          return (
            <div
              key={`${notif.timestamp}-${index}`}
              className="dp-card bg-[var(--color-surface-primary)] shadow-lg border border-accent/30 animate-in slide-in-from-right"
            >
              <div className="flex items-center gap-3 p-3">
                <div className="w-10 h-10 rounded-full bg-accent/10 flex items-center justify-center flex-shrink-0">
                  <Scan size={18} className="text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="type-footnote text-label-primary font-medium">
                    New camera found
                  </p>
                  <p className="type-caption-2 text-label-tertiary truncate">
                    {notif.camera?.replace(/_/g, " ")}
                  </p>
                </div>
                <button
                  onClick={() => onDismiss(index)}
                  className="p-1 text-label-quaternary hover:text-label-secondary"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
