"use client";
/**
 * WARP-3904 — the one-line result of `disconnect_connection`, shown once the
 * approval has been given and the family has purged its credential. A line, not
 * a card with actions: there is nothing left to do.
 */
import { Check } from "lucide-react";
import type { ConnectionDisconnected as ConnectionDisconnectedData } from "@droplet/shared-types";
import "./connect-card.css";

export function ConnectionDisconnected({ disconnected }: { disconnected: ConnectionDisconnectedData }) {
  return (
    <div className="cc cc-line" role="status" data-testid="connection-disconnected" data-provider={disconnected.provider}>
      <Check size={16} strokeWidth={2} aria-hidden="true" className="cc-line-icon" />
      <p>Disconnected {disconnected.displayName}</p>
    </div>
  );
}
