"use client";

/**
 * Sync & health footer (design brief §4.5) — restates the read-only guarantee
 * in plain words and always carries the freshness timestamp (never presents
 * stale data as current).
 */

import { RefreshCw } from "lucide-react";
import type { IntegrationConnection } from "@/lib/erp-types";
import { syncedAgo, inFromNow } from "@/lib/erp-format";

export function SyncFooter({
  connection,
  onSyncNow,
}: {
  connection: IntegrationConnection;
  onSyncNow: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        marginTop: 20,
        paddingTop: 16,
        borderTop: "1px solid var(--card-bd)",
      }}
    >
      <span className="type-caption-1 text-label-tertiary" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <RefreshCw size={13} />
        Synced {syncedAgo(connection.lastSyncedAt)}
        {connection.nextSyncAt ? <> · next sync in {inFromNow(connection.nextSyncAt)}</> : null}
      </span>
      <button type="button" className="type-caption-1 text-accent" onClick={onSyncNow}>
        Sync now
      </button>
      <span className="type-caption-1 text-label-tertiary" style={{ marginLeft: "auto" }}>
        Reading as a dedicated Droplet account with view-only access.
      </span>
    </div>
  );
}
