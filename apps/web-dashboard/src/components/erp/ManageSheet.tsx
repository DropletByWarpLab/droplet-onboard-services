"use client";

/**
 * Manage Eaglesoft sheet — reached from the connected hero's "Manage" action
 * (design brief §4.1, §7.5, §10). Holds the write mode toggle (a confirmed
 * state change), Sync now, and Disconnect (destructive-ish, confirmed).
 *
 * WARP-2518 — the disconnect block is no longer this sheet's. It was the ONLY
 * Disconnect control in the product, which meant a cloud connection made from
 * `/integrations` or `/integrations/credentials` could be created in the
 * dashboard and removed only through the API. `DisconnectControl` now owns the
 * confirmation, the call and the failure, and this sheet is one of its three
 * consumers rather than the place the other two would have had to copy.
 */

import { useId } from "react";
import { RefreshCw, Lock, PlugZap } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { DisconnectControl } from "@/components/integrations/DisconnectControl";
import type { IntegrationConnection } from "@/lib/erp-types";
import { writeModeOf } from "@/lib/erp-types";

export function ManageSheet({
  open,
  onClose,
  connection,
  displayName = "Eaglesoft",
  canToggleWrites = true,
  onToggleWrites,
  onSyncNow,
  onDisconnected,
}: {
  open: boolean;
  onClose: () => void;
  connection: IntegrationConnection;
  /** What the owner calls this connection. Defaults to the one vendor this
   *  sheet is reached for today; carried as a prop so the sheet does not have
   *  to be forked for the second. */
  displayName?: string;
  /** Only owner/admin may flip the write kill-switch (RBAC). When false the
   *  toggle is hidden and the mode is shown read-only. */
  canToggleWrites?: boolean;
  onToggleWrites: (next: boolean) => void;
  onSyncNow: () => void;
  /** Fired after the box CONFIRMED the disconnect — see `DisconnectControl`.
   *  It replaces the old `onDisconnect`, which fired on the click and left the
   *  page owning a call whose failure it then swallowed (WARP-2519). */
  onDisconnected: () => void;
}) {
  const headingId = useId();
  const mode = writeModeOf(connection);
  const writesOn = mode === "writes-enabled";

  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId} maxWidth="md">
      <div className="p-5">
        <h2 id={headingId} className="type-title-3 text-label-primary">Manage {displayName}</h2>

        <div className="mt-4 dp-group">
          <button type="button" className="dp-row w-full text-left" onClick={onSyncNow}>
            <span className="flex items-center gap-2 type-subheadline text-label-primary">
              <PlugZap size={15} className="text-label-tertiary" /> Re-test connection
            </span>
          </button>
          <div className="dp-row">
            <span className="flex items-center gap-2 type-subheadline text-label-primary">
              {writesOn ? <PlugZap size={15} className="text-system-orange" /> : <Lock size={15} className="text-label-tertiary" />}
              {writesOn ? "Writes enabled" : "Read-only"}
            </span>
            {canToggleWrites && (
              <button
                type="button"
                className={`sw ${writesOn ? "on" : ""}`}
                role="switch"
                aria-checked={writesOn}
                aria-label="Toggle writes"
                onClick={() => onToggleWrites(!writesOn)}
              >
                <span className="ball" />
              </button>
            )}
          </div>
          <button type="button" className="dp-row w-full text-left" onClick={onSyncNow}>
            <span className="flex items-center gap-2 type-subheadline text-label-primary">
              <RefreshCw size={15} className="text-label-tertiary" /> Sync now
            </span>
          </button>
        </div>

        {writesOn && (
          <p className="type-caption-1 text-system-orange mt-2">
            Droplet still asks you to confirm every change before it writes.
          </p>
        )}

        <div className="mt-4 border-t border-separator pt-4">
          {/* The sheet no longer closes itself on the click. It used to —
              `onDisconnect(); onClose();` — which dismissed the one surface
              that could have reported the failure, at the exact moment the
              request was still in flight. It now closes when the box has
              answered, and only then. */}
          <DisconnectControl
            provider={connection.provider}
            displayName={displayName}
            onDisconnected={() => {
              onDisconnected();
              onClose();
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
