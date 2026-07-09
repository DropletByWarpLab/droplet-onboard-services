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
        card hover group
        ${isRevoked ? "opacity-60" : ""}
      `}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className={`
            w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
            ${isRevoked ? "bg-[var(--surface-2)] text-[var(--text-muted)]" : "bg-[var(--brand-subtle)] text-[var(--brand)]"}
          `}
        >
          <Icon size={20} />
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <p
            className="type-subheadline font-medium truncate"
            style={{ color: "var(--text)" }}
          >
            {client.deviceName}
          </p>
          <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
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

        {/*
          WARP-300: revoke is always rendered (no opacity-0 hover gate)
          so touch + keyboard users can discover the action. p-2.5 →
          14 px icon + 20 px padding = 34 px hit-target, clearing the
          32 px ui-ux floor. aria-label names the device the action
          targets so screen-reader users hear which client they're
          about to revoke (fallback to id when deviceName is empty).
        */}
        {!isRevoked && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRevoke(client);
            }}
            className="p-2.5 rounded-[var(--radius-input)] text-[var(--text-faint)] hover:text-[#ef4444] hover:bg-[rgba(239,68,68,0.1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors"
            aria-label={`Revoke ${client.deviceName || client.id}`}
            title="Revoke this device"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
