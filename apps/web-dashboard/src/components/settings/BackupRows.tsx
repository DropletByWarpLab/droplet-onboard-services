"use client";

/**
 * WARP-1405 — backup health, visible to the owner in Settings → Device
 * information. Backups once failed every night for 16 days with nothing on
 * any screen; this row says when the last backup succeeded and, when backups
 * have stopped, why and what to do. Same values the hourly backup-health job
 * notifies on (the server computes `health`; this only words it). Read-only,
 * owner/admin (the route refuses everyone else; the row renders nothing).
 */
import { useEffect, useState } from "react";
import { fetchBackupStatus, type BackupStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export const BACKUP_ACTION = "Your files are safe on the Droplet, but they are not being backed up. Contact Droplet support to get backups running again.";

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

/** Pure, so every state is pinned by a test without rendering. */
export function backupCopy(b: BackupStatus): { value: string; warning: string | null } {
  switch (b.health) {
    case "healthy":
      return { value: `Last backup ${when(b.lastSuccessAt)}`, warning: null };
    case "pending":
      return { value: "Waiting for the first nightly backup", warning: null };
    case "failing":
      return {
        value: `Last night's backup failed · last good ${when(b.lastSuccessAt)}`,
        warning: null,
      };
    case "overdue":
      return {
        value: `Backups stopped · last good ${when(b.lastSuccessAt)}`,
        warning: `No backup has completed in ${b.windowHours} hours${b.reason ? ` (last attempt failed while ${b.reason})` : ""}. ${BACKUP_ACTION}`,
      };
    case "key_mismatch":
      return {
        value: `Backups stopped · last good ${when(b.lastSuccessAt)}`,
        warning: `The backup store no longer opens with this Droplet's key. ${BACKUP_ACTION}`,
      };
    default:
      return { value: "Status unavailable", warning: null };
  }
}

export function BackupRows() {
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchBackupStatus();
        if (!cancelled) setStatus(s);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin) return null;
  const copy = status ? backupCopy(status) : null;
  return (
    <>
      <div className="lrow" style={{ padding: "12px 16px" }} data-testid="backup-row">
        <span className="rt">
          <span className="nm" style={{ color: "var(--text-muted)", fontWeight: 400 }}>Backups</span>
        </span>
        <span className="rmeta mono">{copy ? copy.value : failed ? "—" : "Loading..."}</span>
      </div>
      {copy?.warning && (
        <div
          role="alert"
          data-testid="backup-warning"
          className="mx-4 mb-3 p-2 rounded type-caption-1 bg-system-red/10 text-system-red"
        >
          {copy.warning}
        </div>
      )}
    </>
  );
}
