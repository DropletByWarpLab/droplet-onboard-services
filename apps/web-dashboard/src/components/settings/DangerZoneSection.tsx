"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ShieldAlert } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { fetchDrives, adoptDrive, confirmStorageCommand } from "@/lib/api";
import type { DriveInfo } from "@/lib/types";
import {
  wholeDiskName,
  buildConfirmPhrase,
} from "@/components/setup/steps/StorageStep";
import { DestructiveConfirm } from "./DestructiveConfirm";

/**
 * WARP-828 — Settings "Danger zone".
 *
 * Owner-only home for the rare, irreversible device actions. v1 action:
 * reformat a data drive (wipe + reformat + re-mount), reusing the existing
 * owner-gated drive_adopt → confirm backend (storage.ts / WARP-662). Nothing
 * here is a new destructive capability — it surfaces the existing one behind
 * the type-to-confirm friction (<DestructiveConfirm/>).
 *
 * Two gates, defence in depth:
 *   1. CLIENT (discovery only) — the section renders for the OWNER role only.
 *      Non-owners never see it and we never even probe the drives feed for
 *      them. This is a UX gate, not a security boundary.
 *   2. SERVER (the real boundary) — the orchestrator independently enforces
 *      owner-role + a single-use confirm token bound to {service, resourceId},
 *      and the host script refuses the OS/boot disk. A forced request from a
 *      non-owner still can't execute (storage-pools.routes.test.ts).
 *
 * Visual: separated from the rest of Settings with system-red accents from the
 * existing token set — no new tokens, no invented colours (ADR-002 home-user).
 */
export function DangerZoneSection() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";

  // Render absolutely nothing — and run no effects, no fetches — unless the
  // viewer is the owner. The early return is BEFORE the data effect so a
  // family/guest session never hits /api/storage/drives.
  if (!isOwner) return null;
  return <DangerZoneOwnerView />;
}

function DangerZoneOwnerView() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [selectedUuid, setSelectedUuid] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetchDrives();
      setDrives(resp.drives ?? []);
    } catch {
      // Bridge unavailable / dev mode — show a calm hint, not a crash. The
      // section stays mounted (the owner can retry by reloading).
      setDrives([]);
      setLoadError("Couldn't read your drives right now.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // CLIENT-SIDE data-only guard. WARP-827 is adding a server-side filter to
  // GET /api/storage/drives, but it may not be merged when this branches —
  // and we must never offer a system/boot/phantom entry for a wipe regardless
  // of what the feed returns. A reformattable drive must:
  //   - resolve to a real WHOLE-disk kernel name (sd*/nvme*/mmcblk*/vd*),
  //   - have a filesystem UUID (real, mountable data volume),
  //   - report a non-trivial size, and
  //   - not be mounted at an obvious system path.
  // The host script is still the authority (it refuses the OS disk); this is
  // the front-line "don't even show it" guard.
  const dataDrives = useMemo(() => isReformattable(drives), [drives]);

  const selected = useMemo(
    () => dataDrives.find((d) => d.uuid === selectedUuid) ?? null,
    [dataDrives, selectedUuid],
  );

  // The phrase the owner must type, and the name shown everywhere: the
  // friendly displayName, else the FS label, else the device tail.
  const targetName = selected ? driveLabel(selected) : "";
  const wholeDisk = selected ? wholeDiskName(selected.device) : "";

  async function handleReformat() {
    if (!selected) return;
    setOpError(null);
    // Step 1 — mint a confirm token (does NOT wipe). The device is the WHOLE
    // disk; the host script refuses the OS disk regardless.
    const token = await adoptDrive({
      device: wholeDisk,
      wipeMethod: "quick",
      confirmPhrase: buildConfirmPhrase([wholeDisk]),
    });
    // Step 2 — confirm + execute, echoing the token's service + resourceId.
    await confirmStorageCommand({
      confirmationToken: token.confirmationToken,
      service: token.service,
      resourceId: token.resourceId,
    });
    // Success — close, drop the selection, and refresh (the drive re-appears
    // freshly formatted + mounted).
    setConfirmOpen(false);
    setSelectedUuid("");
    await load();
  }

  return (
    <section className="mb-10" aria-labelledby="danger-zone-heading">
      <h2
        id="danger-zone-heading"
        className="type-footnote text-system-red uppercase tracking-wider px-1 mb-2"
      >
        Danger zone
      </h2>

      {/* System-red framed card — visually set apart from the neutral settings
          groups above it. Tokens only (border/text/bg system-red). */}
      <div className="rounded-xl border border-system-red/30 bg-system-red/[0.03] p-4">
        <div className="flex items-start gap-3">
          <span
            className="flex-none flex h-9 w-9 items-center justify-center rounded-lg bg-system-red/10 text-system-red"
            aria-hidden="true"
          >
            <ShieldAlert size={18} />
          </span>
          <div className="min-w-0">
            <p className="type-subheadline text-label-primary">Reformat a drive</p>
            <p className="type-caption-1 text-label-tertiary mt-0.5">
              Erase everything on a drive and set it up fresh. This can't be
              undone — back up anything you want to keep first.
            </p>
          </div>
        </div>

        {loadError ? (
          <p className="type-footnote text-label-tertiary mt-4">{loadError}</p>
        ) : dataDrives.length === 0 ? (
          <p className="type-footnote text-label-tertiary mt-4">
            No drives available to reformat.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="danger-zone-drive"
                className="block type-footnote text-label-secondary"
              >
                Choose a drive
              </label>
              <select
                id="danger-zone-drive"
                value={selectedUuid}
                onChange={(e) => {
                  setSelectedUuid(e.target.value);
                  setOpError(null);
                }}
                className="dp-input"
              >
                <option value="">Select a drive…</option>
                {dataDrives.map((d) => (
                  <option key={d.uuid} value={d.uuid}>
                    {driveLabel(d)} · {formatBytes(d.size_bytes)}
                  </option>
                ))}
              </select>
            </div>

            {selected && (
              <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
                <p className="type-footnote text-label-primary">
                  This erases everything on {targetName}. It can't be undone.
                </p>
                {/* Only when the modal is closed — while it's open the modal
                    surfaces the same error, so don't render two alerts. */}
                {!confirmOpen && opError && (
                  <div
                    role="alert"
                    className="mt-2 flex items-start gap-2 type-footnote text-label-primary bg-system-red/10 rounded-sm px-3 py-2"
                  >
                    <AlertCircle
                      size={14}
                      className="mt-0.5 flex-shrink-0 text-system-red"
                      aria-hidden="true"
                    />
                    <span>{opError}</span>
                  </div>
                )}
                <button
                  ref={triggerRef}
                  type="button"
                  onClick={() => {
                    setOpError(null);
                    setConfirmOpen(true);
                  }}
                  className="mt-3 type-subheadline px-4 rounded-md bg-system-red text-white hover:bg-system-red/90 transition-colors min-h-[44px]"
                >
                  Reformat this drive
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {selected && (
        <DestructiveConfirm
          open={confirmOpen}
          triggerRef={triggerRef}
          title="Reformat this drive?"
          consequence={`This erases everything on ${targetName} and sets it up fresh. It can't be undone.`}
          affectedSummary={`${targetName} · ${formatBytes(selected.size_bytes)}`}
          confirmPhrase={targetName}
          confirmLabel="Erase and reformat"
          progressMessage="Reformatting the drive — this can take a moment. Keep this open until it finishes."
          errorMessage={opError ?? undefined}
          onConfirm={async () => {
            try {
              await handleReformat();
            } catch (e) {
              setOpError(friendlyReformatError(e));
              throw e; // keep the modal open + show its error state
            }
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * Client-side data-only guard (see the call site for why this exists even with
 * WARP-827's server filter). Keeps only entries that look like a real,
 * mountable data volume on a whole disk — never a system/boot/phantom mount.
 */
export function isReformattable(drives: DriveInfo[]): DriveInfo[] {
  return drives.filter((d) => {
    if (!d.uuid) return false; // no FS UUID → not a real mountable data volume
    if (!wholeDiskName(d.device)) return false; // unrecognised device shape
    if (!d.size_bytes || d.size_bytes < 100 * 1024 * 1024) return false; // <100MB sliver
    const mp = d.mount || "";
    // Obvious system mounts never belong in a reformat picker. The bridge feed
    // is /mnt-scoped already, but guard the classic system paths defensively.
    if (/^\/(boot|$)/.test(mp) || mp === "/" || mp.startsWith("/boot")) return false;
    return true;
  });
}

/** Friendly drive name: displayName → FS label → device tail. Title-cased. */
function driveLabel(d: DriveInfo): string {
  const tail = d.device.split("/").filter(Boolean).pop() ?? "";
  const raw = (d.displayName || d.label || tail).trim();
  return raw || "Drive";
}

/** Map a reformat failure to calm, honest home-user copy. The host pre-flight
 *  refusal (OS disk / busy) is surfaced specifically; everything else is a
 *  generic retry. Raw wipefs/mkfs strings never reach the screen. */
function friendlyReformatError(err: unknown): string {
  const raw = err instanceof Error ? err.message.toLowerCase() : "";
  // eslint-disable-next-line no-console
  console.error("[danger-zone:reformat]", err);
  if (/os|boot|system disk|never adoptable/.test(raw)) {
    return "That's the Droplet's system disk — it can't be reformatted.";
  }
  if (/mounted|in use|busy/.test(raw)) {
    return "That drive is busy right now. Close anything using it and try again.";
  }
  if (/forbidden|denied|403/.test(raw)) {
    return "You don't have permission to reformat drives.";
  }
  return "We couldn't reformat that drive right now. Try again in a moment.";
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 GB";
  const tb = bytes / 1_000_000_000_000;
  if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 1)} TB`;
  const gb = bytes / 1_000_000_000;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}
