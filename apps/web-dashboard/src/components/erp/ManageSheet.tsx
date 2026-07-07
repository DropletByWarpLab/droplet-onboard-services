"use client";

/**
 * Manage Eaglesoft sheet — reached from the connected hero's "Manage" action
 * (design brief §4.1, §7.5, §10). Holds the write mode toggle (a confirmed
 * state change), Sync now, and Disconnect (destructive-ish, confirmed).
 */

import { useId, useState } from "react";
import { RefreshCw, Lock, PlugZap, Unplug } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { IntegrationConnection } from "@/lib/erp-types";
import { writeModeOf } from "@/lib/erp-types";

export function ManageSheet({
  open,
  onClose,
  connection,
  onToggleWrites,
  onSyncNow,
  onDisconnect,
}: {
  open: boolean;
  onClose: () => void;
  connection: IntegrationConnection;
  onToggleWrites: (next: boolean) => void;
  onSyncNow: () => void;
  onDisconnect: () => void;
}) {
  const headingId = useId();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const mode = writeModeOf(connection);
  const writesOn = mode === "writes-enabled";

  return (
    <Dialog open={open} onClose={onClose} labelledBy={headingId} maxWidth="md">
      <div className="p-5">
        <h2 id={headingId} className="type-title-3 text-label-primary">Manage Eaglesoft</h2>

        <div className="mt-4 dp-group">
          <div className="dp-row">
            <span className="flex items-center gap-2 type-subheadline text-label-primary">
              {writesOn ? <PlugZap size={15} className="text-system-orange" /> : <Lock size={15} className="text-label-tertiary" />}
              {writesOn ? "Writes enabled" : "Read-only"}
            </span>
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
          {!confirmDisconnect ? (
            <button
              type="button"
              className="flex items-center gap-2 type-footnote text-system-red"
              onClick={() => setConfirmDisconnect(true)}
            >
              <Unplug size={14} /> Disconnect Eaglesoft
            </button>
          ) : (
            <div className="rounded-sm bg-system-red/8 p-3">
              <p className="type-footnote text-label-primary">
                Disconnect Eaglesoft? Droplet will stop reading your practice. Your Eaglesoft data is
                untouched.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button type="button" className="type-footnote text-label-secondary px-2" onClick={() => setConfirmDisconnect(false)}>
                  Keep connected
                </button>
                <button
                  type="button"
                  className="dp-btn-primary"
                  style={{ background: "var(--color-system-red)" }}
                  onClick={() => { onDisconnect(); onClose(); }}
                >
                  Disconnect
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
