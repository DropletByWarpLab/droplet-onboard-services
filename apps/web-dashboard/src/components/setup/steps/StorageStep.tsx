"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, HardDrive } from "lucide-react";
import { fetchDrives, updateDriveLabel } from "@/lib/api";
import type { DriveInfo } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — name the drives the box detected.
 *
 * The device-bridge inventory of mounted drives comes back from
 * GET /api/storage/drives (Phase L wires this on the POC; in production
 * it's the device-bridge on the host). The customer types a friendly
 * name for each ("Wedding Photos", "Camera Footage") and we upsert via
 * PATCH /api/storage/drives/:uuid (new endpoint, WARP-174).
 *
 * Auto-skip when zero drives — a single-disk box has nothing to label
 * here, and the wizard shouldn't make the customer click "Skip" on a
 * no-op step. Same pattern the Cameras step (later commit) uses for
 * "no ONVIF cameras detected".
 *
 * Visual shape mirrors the NetworkDevice cards on `/network` per
 * ADR-002 Phase 1 — icon + name + secondary metadata, edit-in-place.
 */
export function StorageStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetchDrives();
      const list = resp.drives ?? [];
      setDrives(list);
      // Pre-fill with existing displayName (or the FS label as a placeholder).
      const initial: Record<string, string> = {};
      for (const d of list) {
        initial[d.uuid] = d.displayName ?? "";
      }
      setNames(initial);
      // Auto-skip when there's nothing to label. Lets the wizard land
      // on the next step without a "Skip" click on an empty page.
      if (list.length === 0) {
        onSkip();
      }
    } catch (e) {
      // Bridge unreachable / dev-mode without it — treat as "no drives"
      // and skip silently. Customer can label drives later from /storage.
      onSkip();
      const _msg = e instanceof Error ? e.message : String(e);
      void _msg;
    } finally {
      setLoading(false);
    }
  }, [onSkip]);

  useEffect(() => {
    load();
  }, [load]);

  const duplicateName = useMemo(() => {
    const seen = new Set<string>();
    for (const v of Object.values(names)) {
      const trimmed = v.trim().toLowerCase();
      if (!trimmed) continue;
      if (seen.has(trimmed)) return trimmed;
      seen.add(trimmed);
    }
    return null;
  }, [names]);

  async function handleSave() {
    if (duplicateName) {
      setError(`Two drives can't share the name "${duplicateName}".`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // Send a PATCH for each drive the customer named (skipped if blank).
      // Errors are collected — one bad PATCH doesn't kill the others; if
      // ANY succeeded the wizard advances and the customer can fix the
      // rest from /storage later.
      const results = await Promise.allSettled(
        drives
          .filter((d) => names[d.uuid]?.trim())
          .map((d) =>
            updateDriveLabel(d.uuid, { displayName: names[d.uuid].trim() }),
          ),
      );
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0 && failures.length === results.length) {
        // Every save failed → don't advance.
        setError(
          failures.length === 1
            ? "Couldn't save that name. Try again in a moment."
            : `Couldn't save any of the names yet. Try again in a moment.`,
        );
        setSaving(false);
        return;
      }
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed. Try again.");
      setSaving(false);
    }
  }

  // While loading, the auto-skip path may fire before render — show a
  // tiny placeholder so we don't briefly flash an empty page.
  if (loading && drives.length === 0) {
    return (
      <StepShell title="Name your storage" subtitle="One moment…">
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="dp-card !py-3 flex items-center gap-3 opacity-30"
            >
              <div className="w-9 h-9 rounded-lg bg-surface-secondary animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-32 bg-surface-secondary rounded animate-pulse" />
                <div className="h-2.5 w-20 bg-surface-secondary rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell
      title="Name your storage"
      subtitle="Give each drive a name so you remember what's on it."
      primary={{
        label: "Save and continue",
        loadingLabel: "Saving…",
        onClick: handleSave,
        isLoading: saving,
      }}
      skip={{ label: "Skip for now", onClick: onSkip }}
    >
      <div className="space-y-3">
        {drives.map((drive) => (
          <div key={drive.uuid} className="dp-card !p-4">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                <HardDrive size={18} className="text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline text-label-primary">
                  {drive.label || drive.device}
                </p>
                <p className="type-caption-1 text-label-tertiary">
                  {formatBytes(drive.size_bytes)}
                  {drive.mount && ` · ${drive.mount}`}
                </p>
              </div>
            </div>
            <input
              type="text"
              value={names[drive.uuid] ?? ""}
              onChange={(e) =>
                setNames((prev) => ({
                  ...prev,
                  [drive.uuid]: e.target.value,
                }))
              }
              placeholder="e.g. Wedding Photos"
              className="dp-input"
              maxLength={64}
            />
          </div>
        ))}

        {error && (
          <div className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <LearnMoreCard helpAnchor="storage">
        <p>
          Each drive can hold a different kind of file. Name them however
          helps you find things later — &ldquo;Wedding Photos&rdquo;,
          &ldquo;Client Backups&rdquo;, &ldquo;Camera Footage&rdquo;.
        </p>
        <p>
          You can rename a drive anytime from Settings &rsaquo; Storage.
          Names are stored on this Droplet — nothing leaves the box.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 GB";
  const tb = bytes / 1_000_000_000_000;
  if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 1)} TB`;
  const gb = bytes / 1_000_000_000;
  // 1 decimal for sub-10 GB (small USB sticks read "7.3 GB" instead
  // of "7 GB"), 0 decimals at 10 GB and up. Mirrors the TB branch
  // above. Prior version had `gb >= 100 ? 0 : 0` — both branches
  // returned 0, so a 1.5 GB drive rendered as "1 GB" (truncated).
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}
