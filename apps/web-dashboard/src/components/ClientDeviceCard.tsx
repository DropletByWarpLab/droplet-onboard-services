"use client";

import {
  Laptop,
  Smartphone,
  Trash2,
  CircleDot,
  type LucideIcon,
} from "lucide-react";
import type { DeviceClientInfo } from "@/lib/types";

function platformIcon(platform: DeviceClientInfo["platform"]): LucideIcon {
  if (platform === "ios" || platform === "android") return Smartphone;
  return Laptop;
}

function formatLastSeen(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const delta = Math.floor((now - d.getTime()) / 1000);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface ClientDeviceCardProps {
  client: DeviceClientInfo;
  onRevoke: (client: DeviceClientInfo) => void;
  onClick?: () => void;
}

export function ClientDeviceCard({
  client,
  onRevoke,
  onClick,
}: ClientDeviceCardProps) {
  const Icon = platformIcon(client.platform);
  const isRevoked = client.status === "revoked";

  return (
    <div
      onClick={onClick}
      className={`
        dp-card p-4 cursor-pointer transition-all duration-200 group
        ${isRevoked ? "opacity-60" : ""}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className={`
            w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
            ${isRevoked ? "bg-surface-secondary text-label-tertiary" : "bg-accent/15 text-accent"}
          `}
        >
          <Icon size={20} />
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <p className="type-subheadline text-label-primary font-medium truncate">
            {client.deviceName}
          </p>
          <p className="type-caption-1 text-label-tertiary">
            {client.platform} &middot; {client.deviceType}
            {client.appVersion ? ` \u00b7 v${client.appVersion}` : ""}
            {isRevoked ? (
              <span className="text-system-red"> &middot; Revoked</span>
            ) : (
              <>
                {" \u00b7 "}
                <CircleDot
                  size={9}
                  className="inline text-system-green align-middle -mt-0.5 mr-0.5"
                />
                {formatLastSeen(client.lastSeen)}
              </>
            )}
          </p>
        </div>

        {/* Revoke button */}
        {!isRevoked && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRevoke(client);
            }}
            className="p-1.5 rounded-sm text-label-quaternary hover:text-system-red hover:bg-system-red/10 opacity-0 group-hover:opacity-100 transition-all"
            title="Revoke this device"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
