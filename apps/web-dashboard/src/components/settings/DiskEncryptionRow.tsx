"use client";

/**
 * WARP-3608 — whether the Droplet's data disk is encrypted at rest, visible to
 * the owner in Settings → Device information. The state is an explicit enum
 * the box reports (device-bridge `system_disk.encryption`); this only words it.
 * A box with no TPM keeps its data in plain text, and the owner must be able to
 * see that rather than assume it. Owner/admin only.
 */
import { useEffect, useState } from "react";
import { fetchDrives } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { DiskEncryptionState } from "@/lib/types";

/** Pure, so every state is pinned by a test without rendering. */
export function encryptionCopy(state: DiskEncryptionState): { value: string; warning: string | null } {
  switch (state) {
    case "tpm_sealed":
      return { value: "Encrypted, unlocks automatically on this Droplet", warning: null };
    case "recovery_key_only":
      return {
        value: "Encrypted, recovery key only",
        warning: null,
      };
    case "not_encrypted":
      return {
        value: "Not encrypted",
        warning:
          "Your files and the Droplet's keys are stored on this disk without encryption. Anyone who takes the disk can read them. Contact Droplet support about disk encryption for this hardware.",
      };
    default:
      return { value: "Status unavailable", warning: null };
  }
}

export function DiskEncryptionRow() {
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const [state, setState] = useState<DiskEncryptionState | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchDrives();
        // Older bridge, or none running: unknown, never "encrypted".
        if (!cancelled) setState(d.system_disk?.encryption ?? "unknown");
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin) return null;
  const copy = state ? encryptionCopy(state) : null;
  return (
    <>
      <div className="lrow" style={{ padding: "12px 16px" }} data-testid="encryption-row">
        <span className="rt">
          <span className="nm" style={{ color: "var(--text-muted)", fontWeight: 400 }}>Disk encryption</span>
        </span>
        <span className="rmeta mono">{copy ? copy.value : failed ? "—" : "Loading..."}</span>
      </div>
      {copy?.warning && (
        <div
          role="alert"
          data-testid="encryption-warning"
          className="mx-4 mb-3 p-2 rounded type-caption-1 bg-system-red/10 text-system-red"
        >
          {copy.warning}
        </div>
      )}
    </>
  );
}
