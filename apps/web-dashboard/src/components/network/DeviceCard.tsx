"use client";
import { useState } from "react";
import * as Icons from "lucide-react";
import type { EnrichedNetworkDevice } from "@/lib/types";
import { DeviceSparkline } from "./DeviceSparkline";
import { useDeviceBlockMutation } from "@/lib/hooks/useDeviceBlockMutation";

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

  function handleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(device);
    }
  }

  return (
    // The card wrapper used to be a <button>, but now needs to host a nested
    // Block/Unblock <button>. Nested buttons are invalid HTML, so the wrapper
    // becomes a div with role="button" + keyboard handler. The inner block
    // button calls stopPropagation so it doesn't also trigger onOpen.
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(device)}
      onKeyDown={handleKey}
      className={`dp-card p-4 text-left transition hover:border-accent/50 w-full group ${device.online ? "" : "opacity-70"}`}
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
              className="type-caption-1 px-2 py-0.5 rounded-full bg-surface-secondary text-label-secondary inline-flex items-center gap-1.5"
            >
              {g.color && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: g.color }}
                  aria-hidden="true"
                />
              )}
              {g.name}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2">
        <DeviceSparkline days={device.presenceDays ?? []} size="sm" />
      </div>
      <div className="mt-3 flex justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
        <BlockActionButton device={device} />
      </div>
    </div>
  );
}

function BlockActionButton({ device }: { device: EnrichedNetworkDevice }) {
  const { toggleBlock } = useDeviceBlockMutation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle(e: React.MouseEvent) {
    // Prevent the wrapper div's onClick from firing (which would open the
    // detail panel) — clicking Block should ONLY toggle the firewall.
    e.stopPropagation();
    // TODO(WARP-41): run tier-2 token-bound confirm here before hitting the
    // firewall endpoint. The hook doesn't exist on this branch yet.
    setPending(true);
    setError(null);
    try {
      await toggleBlock(device);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      setError(msg);
    } finally {
      setPending(false);
    }
  }

  // Intentional no optimistic flip: isBlocked reflects what the reconciler
  // (WARP-81) last saw. The SWR revalidate inside toggleBlock() is enough —
  // within ~10 s the card shows the new state.
  return (
    <button
      type="button"
      onClick={handle}
      onKeyDown={(e) => e.stopPropagation()}
      disabled={pending}
      className={`type-caption-1 px-2 py-1 rounded ${device.isBlocked ? "bg-system-green/10 text-system-green" : "bg-system-red/10 text-system-red"}`}
      aria-label={device.isBlocked ? "Unblock device" : "Block device"}
      title={error ?? undefined}
    >
      {pending ? "..." : device.isBlocked ? "Unblock" : "Block"}
    </button>
  );
}
