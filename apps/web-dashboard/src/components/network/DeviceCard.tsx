"use client";
import * as Icons from "lucide-react";
import type { EnrichedNetworkDevice } from "@/lib/types";
import { DeviceSparkline } from "./DeviceSparkline";

interface Props {
  device: EnrichedNetworkDevice;
  onOpen: (device: EnrichedNetworkDevice) => void;
}

function iconFor(name: string | null) {
  const fallback = Icons.HelpCircle;
  if (!name) return fallback;
  const candidate = (Icons as unknown as Record<string, typeof Icons.HelpCircle>)[name];
  return candidate ?? fallback;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function DeviceCard({ device, onOpen }: Props) {
  const IconComp = iconFor(device.icon);
  const displayName = device.displayName ?? device.hostname ?? device.vendor ?? "Device";
  return (
    <button
      type="button"
      onClick={() => onOpen(device)}
      className={`dp-card p-4 text-left transition hover:border-accent/50 w-full ${device.online ? "" : "opacity-70"}`}
      aria-label={`Open ${displayName} details`}
    >
      <div className="flex items-center gap-3">
        <IconComp className="w-12 h-12 text-accent shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="type-headline text-label-primary truncate">{displayName}</p>
          <p className="type-footnote text-label-secondary truncate">
            {device.vendor ?? "Unknown vendor"}
            {device.lastIp ? ` · ${device.lastIp}` : ""}
          </p>
          {!device.online && (
            <p className="type-caption-1 text-label-tertiary mt-0.5">last seen {timeAgo(device.lastSeen)}</p>
          )}
        </div>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${device.online ? "bg-system-green" : "bg-label-quaternary"}`}
          aria-label={device.online ? "online" : "offline"}
        />
      </div>
      {device.groups.length > 0 && (
        <div className="mt-2 flex gap-1 flex-wrap">
          {device.groups.map((g) => (
            <span
              key={g.id}
              className="type-caption-1 px-2 py-0.5 rounded-full bg-surface-secondary text-label-secondary"
              style={g.color ? { backgroundColor: g.color } : undefined}
            >
              {g.name}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2">
        <DeviceSparkline days={device.presenceDays ?? []} size="sm" />
      </div>
    </button>
  );
}
