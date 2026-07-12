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
              className="card animate-in slide-in-from-right"
              style={{
                background: "var(--glass)",
                backdropFilter: "blur(20px) saturate(150%)",
                WebkitBackdropFilter: "blur(20px) saturate(150%)",
                boxShadow: "var(--lift)",
              }}
            >
              <div className="flex items-start gap-3">
                {notif.thumbnail && notif.thumbnail.startsWith("/api/") ? (
                  <img
                    src={notif.thumbnail}
                    alt={notif.label || "Detection"}
                    className="w-12 h-12 rounded object-cover flex-shrink-0"
                  />
                ) : (
                  <div
                    className="w-12 h-12 rounded flex items-center justify-center flex-shrink-0"
                    style={{ background: "var(--brand-subtle)" }}
                  >
                    <Icon size={20} style={{ color: "var(--brand)" }} />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p
                    className="type-footnote font-medium capitalize"
                    style={{ color: "var(--text)" }}
                  >
                    {notif.label} detected
                  </p>
                  <p className="type-caption-2" style={{ color: "var(--text-muted)" }}>
                    {notif.camera?.replace(/_/g, " ")}
                    {notif.score ? ` \u00B7 ${Math.round(notif.score * 100)}%` : ""}
                  </p>
                </div>
                <button
                  onClick={() => onDismiss(index)}
                  className="p-1 text-[color:var(--text-faint)] hover:text-[color:var(--text-muted)]"
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
              className="card animate-in slide-in-from-right"
              style={{
                background: "var(--glass)",
                backdropFilter: "blur(20px) saturate(150%)",
                WebkitBackdropFilter: "blur(20px) saturate(150%)",
                boxShadow: "var(--lift)",
                borderColor: "color-mix(in srgb, var(--brand) 30%, transparent)",
              }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: "var(--brand-subtle)" }}
                >
                  <Scan size={18} style={{ color: "var(--brand)" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className="type-footnote font-medium"
                    style={{ color: "var(--text)" }}
                  >
                    New camera found
                  </p>
                  <p
                    className="type-caption-2 truncate"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {notif.camera?.replace(/_/g, " ")}
                  </p>
                </div>
                <button
                  onClick={() => onDismiss(index)}
                  className="p-1 text-[color:var(--text-faint)] hover:text-[color:var(--text-muted)]"
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
