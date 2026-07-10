"use client";

import { useId } from "react";
import { X, Laptop, Smartphone } from "lucide-react";
import type { DeviceClientInfo } from "@/lib/types";
import { Dialog } from "./Dialog";

interface ClientDetailPanelProps {
  client: DeviceClientInfo;
  onRevoke: (client: DeviceClientInfo) => void;
  onClose: () => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Paired-device detail side-panel.
 *
 * WARP-289: rebuilt on the shared `<Dialog placement="right">` primitive.
 */
export function ClientDetailPanel({
  client,
  onRevoke,
  onClose,
}: ClientDetailPanelProps) {
  const Icon = client.platform === "ios" || client.platform === "android" ? Smartphone : Laptop;
  const isRevoked = client.status === "revoked";
  const headingId = useId();

  return (
    // `flush`: sectioned side panel — full-width dividers, sections own their
    // padding (WARP-1153).
    <Dialog open onClose={onClose} labelledBy={headingId} placement="right" flush>
      {/* Header */}
      <div className="flex items-center justify-between p-5 border-b border-separator">
        <div className="flex items-center gap-3">
          <div
            className={`
              w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0
              ${isRevoked ? "bg-surface-secondary text-label-tertiary" : "bg-accent/15 text-accent"}
            `}
          >
            <Icon size={20} />
          </div>
          <div>
            <h2 id={headingId} className="type-title-3 text-label-primary">
              {client.deviceName}
            </h2>
            <p className="type-caption-1 text-label-tertiary">
              {client.platform} &middot; {client.deviceType}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-2 rounded-lg text-label-tertiary hover:bg-surface-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X size={20} />
        </button>
      </div>

      {/* Details */}
      <div className="p-5 space-y-6">
        {/* Status */}
        <div className="flex items-center justify-between">
          <span className="type-subheadline text-label-primary">Status</span>
          <span
            className={`
              type-caption-1 px-2.5 py-1 rounded-full font-medium
              ${isRevoked
                ? "bg-system-red/10 text-system-red"
                : "bg-system-green/10 text-system-green"
              }
            `}
          >
            {isRevoked ? "Revoked" : "Active"}
          </span>
        </div>

        {/* Info rows */}
        <div className="pt-4 border-t border-separator space-y-3">
          <div>
            <span className="type-caption-1 text-label-tertiary block mb-1">
              Platform
            </span>
            <span className="type-caption-1 text-label-secondary capitalize">
              {client.platform}
            </span>
          </div>
          <div>
            <span className="type-caption-1 text-label-tertiary block mb-1">
              Device Type
            </span>
            <span className="type-caption-1 text-label-secondary capitalize">
              {client.deviceType}
            </span>
          </div>
          {client.appVersion && (
            <div>
              <span className="type-caption-1 text-label-tertiary block mb-1">
                App Version
              </span>
              <span className="type-caption-1 text-label-secondary">
                v{client.appVersion}
              </span>
            </div>
          )}
          <div>
            <span className="type-caption-1 text-label-tertiary block mb-1">
              Last Seen
            </span>
            <span className="type-caption-1 text-label-secondary">
              {formatDate(client.lastSeen)}
            </span>
          </div>
          <div>
            <span className="type-caption-1 text-label-tertiary block mb-1">
              Paired
            </span>
            <span className="type-caption-1 text-label-secondary">
              {formatDate(client.createdAt)}
            </span>
          </div>
        </div>

        {/* Revoke button */}
        {!isRevoked && (
          <div className="pt-4 border-t border-separator">
            <button
              onClick={() => onRevoke(client)}
              className="w-full py-2.5 rounded-lg type-subheadline font-medium text-system-red bg-system-red/10 hover:bg-system-red/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Revoke Device
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
