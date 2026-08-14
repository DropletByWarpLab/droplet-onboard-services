"use client";
import { useRef, useState } from "react";
import * as Icons from "lucide-react";
import type { EnrichedNetworkDevice } from "@/lib/types";
import { DeviceSparkline } from "./DeviceSparkline";
import { useDeviceBlockMutation } from "@/lib/hooks/useDeviceBlockMutation";
import { toastForError } from "@/lib/hooks/useDeviceMutations";
import { translateError } from "@/lib/friendly-errors";
import { QuickSchedulePopover } from "./QuickSchedulePopover";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface Props {
  device: EnrichedNetworkDevice;
  onOpen: (device: EnrichedNetworkDevice) => void;
  // Optional channel for surfacing block/unblock failures. The card doesn't
  // own toast rendering — the page-level DevicesTab does. When omitted the
  // inner button falls back to a `title` tooltip so the message isn't lost.
  onError?: (message: string) => void;
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

export function DeviceCard({ device, onOpen, onError }: Props) {
  // WARP-1715: an approved coverage AP is a device on the household network,
  // not a separate silo — but it IS infrastructure, so give it the router icon
  // rather than the generic HelpCircle an un-iconed row would otherwise get.
  const IconComp = device.isAccessPoint && !device.icon ? Icons.Router : iconFor(device.icon);
  const displayName = device.displayName ?? device.hostname ?? device.vendor ?? "Device";

  function handleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    // Enter/Space from nested controls (e.g. the Block button) bubbles to this
    // wrapper. Without the target/currentTarget guard, pressing Enter on the
    // Block button would toggle the firewall AND open the detail panel.
    if (e.target !== e.currentTarget) return;
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
      className={`card text-left transition hover:border-[color-mix(in_srgb,var(--brand)_50%,var(--card-bd))] w-full group ${device.online ? "" : "opacity-70"}`}
      aria-label={`Open ${displayName} details`}
    >
      <div className="flex items-center gap-3">
        <IconComp className="w-12 h-12 text-[color:var(--brand)] shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="type-headline text-[color:var(--text)] truncate">{displayName}</p>
          <p className="type-footnote text-[color:var(--text-muted)] truncate">
            {/* An AP describes itself by what it IS — "Unknown vendor" on the
                household's own access point reads as a fault. */}
            {device.isAccessPoint
              ? (device.apModel ?? "Access point")
              : (device.vendor ?? "Unknown vendor")}
            {device.lastIp ? ` · ${device.lastIp}` : ""}
          </p>
          {device.viaAp && (
            <p className="type-caption-1 text-[color:var(--text-muted)] mt-0.5 truncate">
              via {device.viaAp}
            </p>
          )}
          {!device.online && (
            <p className="type-caption-1 text-[color:var(--text-muted)] mt-0.5">last seen {timeAgo(device.lastSeen)}</p>
          )}
        </div>
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${device.online ? "bg-system-green" : "bg-[var(--text-faint)]"}`}
          aria-label={device.online ? "online" : "offline"}
        />
      </div>
      {device.groups.length > 0 && (
        <div className="mt-2 flex gap-1 flex-wrap">
          {device.groups.map((g) => (
            <span
              key={g.id}
              className="type-caption-1 px-2 py-0.5 rounded-full bg-[var(--card-inner)] text-[color:var(--text-muted)] inline-flex items-center gap-1.5"
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
      {/*
        WARP-292: action row is always visible so touch + keyboard users
        can discover Quick Schedule / Block without hovering. The
        previous opacity-0 group-hover gate made these unreachable on
        mobile and required focus-within fallback to be keyboard-safe.
        Keeping the row visible at rest matches the WARP-220 pattern
        shipped on /users.
      */}
      <div className="mt-3 flex justify-end gap-2 transition">
        <QuickScheduleActionButton device={device} />
        <BlockActionButton device={device} onError={onError} />
      </div>
    </div>
  );
}

function QuickScheduleActionButton({
  device,
}: {
  device: EnrichedNetworkDevice;
}) {
  const [open, setOpen] = useState(false);
  const displayName =
    device.displayName ?? device.hostname ?? device.vendor ?? "this device";

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => {
          // The card wrapper treats any click as "open details" — keep this
          // one isolated so toggling the popover doesn't also spring the
          // detail panel open.
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        className="type-caption-1 px-2 py-1 rounded bg-[var(--card-inner)] text-[color:var(--text-muted)] hover:text-[color:var(--text)] inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        aria-label={`Quick schedule for ${displayName}`}
      >
        <Icons.CalendarClock className="w-3.5 h-3.5" />
        Quick schedule
      </button>
      {open && (
        <QuickSchedulePopover
          subject={{ type: "device", deviceMac: device.mac }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function BlockActionButton({
  device,
  onError,
}: {
  device: EnrichedNetworkDevice;
  onError?: (message: string) => void;
}) {
  const { toggleBlock } = useDeviceBlockMutation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Retained as a fallback for callers that don't wire up a toast handler —
  // primary error UX is the page-level toast via `onError`.
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const displayName =
    device.displayName ?? device.hostname ?? device.vendor ?? "this device";
  const isUnblocking = device.isBlocked;

  function openConfirm(e: React.MouseEvent) {
    // Prevent the wrapper div's onClick from firing (which would open the
    // detail panel) — clicking Block should ONLY open the confirm.
    e.stopPropagation();
    setError(null);
    setConfirmOpen(true);
  }

  async function handleConfirm() {
    setError(null);
    try {
      await toggleBlock(device);
    } catch (err) {
      const friendly = toastForError(err, translateError(err, "network"));
      if (onError) onError(friendly);
      setError(friendly);
      // Re-throw so the ConfirmDialog keeps itself open and the user can
      // retry without re-clicking the card.
      throw err;
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openConfirm}
        onKeyDown={(e) => e.stopPropagation()}
        className={`type-caption-1 px-2 py-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${device.isBlocked ? "bg-system-green/10 text-system-green" : "bg-system-red/10 text-system-red"}`}
        aria-label={
          isUnblocking
            ? `Unblock device ${displayName}`
            : `Block device ${displayName}`
        }
        title={error ?? undefined}
      >
        {isUnblocking ? "Unblock" : "Block"}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        triggerRef={triggerRef}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmOpen(false)}
        title={isUnblocking ? `Unblock ${displayName}?` : `Block ${displayName}?`}
        description={
          isUnblocking
            ? "This device will regain internet access."
            : "This device won't be able to reach the internet until you unblock it."
        }
        confirmLabel={isUnblocking ? "Unblock" : "Block"}
        variant={isUnblocking ? "neutral" : "destructive"}
      />
    </>
  );
}
