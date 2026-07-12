"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, RotateCcw, ShieldAlert } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  fetchDrives,
  adoptDrive,
  confirmStorageCommand,
  getResetStatus,
  triggerFactoryReset,
  type ResetJob,
} from "@/lib/api";
import type { DriveInfo } from "@/lib/types";
import {
  wholeDiskName,
  buildConfirmPhrase,
} from "@/components/setup/steps/StorageStep";
import { DestructiveConfirm } from "./DestructiveConfirm";
import { DestructiveConfirm as FactoryResetConfirm } from "@/components/DestructiveConfirm";

/**
 * Settings "Danger zone" (WARP-828 + WARP-825).
 *
 * Owner-only home for the rare, irreversible device actions. Two actions live
 * here, each fully self-contained:
 *   1. Reformat a data drive (WARP-828) — wipe + reformat + re-mount, reusing
 *      the existing owner-gated drive_adopt → confirm backend (storage.ts /
 *      WARP-662). Surfaces an existing capability behind type-to-confirm
 *      friction (<DestructiveConfirm/>).
 *   2. Factory reset (WARP-825) — erase every account/file/message/setting and
 *      return the box to first-run setup, through <DestructiveConfirm/> from
 *      @/components/DestructiveConfirm (re-aliased here as FactoryResetConfirm).
 *
 * Two gates, defence in depth, applied to BOTH actions:
 *   1. CLIENT (discovery only) — the section renders for the OWNER role only.
 *      Non-owners never see it and we never even probe the drives feed or the
 *      reset-status feed for them. This is a UX gate, not a security boundary.
 *   2. SERVER (the real boundary) — the orchestrator independently enforces
 *      owner-role + (for reformat) a single-use confirm token bound to
 *      {service, resourceId}, and the host script refuses the OS/boot disk; the
 *      factory-reset endpoint re-enforces the owner gate + typed-name check. A
 *      forced request from a non-owner still can't execute.
 *
 * Visual: separated from the rest of Settings with system-red accents from the
 * existing token set — no new tokens, no invented colours (ADR-002 home-user).
 */
export function DangerZoneSection() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";

  // Render absolutely nothing — and run no effects, no fetches — unless the
  // viewer is the owner. The early return is BEFORE the data effects so a
  // family/guest session never hits /api/storage/drives or the reset status.
  if (!isOwner) return null;
  return (
    <section className="mb-10" aria-labelledby="danger-zone-heading">
      <h2
        id="danger-zone-heading"
        className="type-footnote uppercase tracking-wider px-1 mb-2"
        style={{ color: "var(--danger)" }}
      >
        Danger zone
      </h2>
      <div className="space-y-3">
        <ReformatDriveCard />
        <FactoryResetCard />
      </div>
    </section>
  );
}

/**
 * WARP-828 — reformat-a-drive control. Self-contained card; owns its own drive
 * feed + confirm flow.
 */
function ReformatDriveCard() {
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
    <>
      {/* Danger-tinted card — visually set apart from the neutral settings
          groups above it. var(--danger) throughout, no invented colours. */}
      <div
        className="card"
        style={{
          borderColor: "color-mix(in srgb, var(--danger) 30%, var(--card-bd))",
          background: "color-mix(in srgb, var(--danger) 4%, var(--card-bg))",
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className="flex-none flex h-9 w-9 items-center justify-center rounded-lg"
            style={{
              background: "color-mix(in srgb, var(--danger) 12%, transparent)",
              color: "var(--danger)",
            }}
            aria-hidden="true"
          >
            <ShieldAlert size={18} />
          </span>
          <div className="min-w-0">
            <p className="type-subheadline" style={{ color: "var(--text)" }}>Reformat a drive</p>
            <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
              Erase everything on a drive and set it up fresh. This can't be
              undone — back up anything you want to keep first.
            </p>
          </div>
        </div>

        {loadError ? (
          <p className="type-footnote mt-4" style={{ color: "var(--text-muted)" }}>{loadError}</p>
        ) : dataDrives.length === 0 ? (
          <p className="type-footnote mt-4" style={{ color: "var(--text-muted)" }}>
            No drives available to reformat.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="danger-zone-drive"
                className="block type-footnote"
                style={{ color: "var(--text-muted)" }}
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
                className="w-full px-3 py-2.5 outline-none focus:border-[var(--brand)] transition-colors"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
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
                <p className="type-footnote" style={{ color: "var(--text)" }}>
                  This erases everything on {targetName}. It can't be undone.
                </p>
                {/* Only when the modal is closed — while it's open the modal
                    surfaces the same error, so don't render two alerts. */}
                {!confirmOpen && opError && (
                  <div
                    role="alert"
                    className="mt-2 flex items-start gap-2 type-footnote rounded-sm px-3 py-2"
                    style={{
                      color: "var(--text)",
                      background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                    }}
                  >
                    <AlertCircle
                      size={14}
                      className="mt-0.5 flex-shrink-0"
                      style={{ color: "var(--danger)" }}
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
                  className="btn danger mt-3"
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
    </>
  );
}

/**
 * WARP-825 — factory-reset control. Self-contained card; owns its own
 * reset-status feed + confirm flow. Uses the @/components/DestructiveConfirm
 * variant (aliased FactoryResetConfirm) shipped with this feature.
 */
function FactoryResetCard() {
  const [targetHint, setTargetHint] = useState<string>("");
  const [latestJob, setLatestJob] = useState<ResetJob | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // Once a reset is dispatched the box is tearing down; we flip to a terminal
  // "under way" notice rather than keep an actionable button live.
  const [dispatched, setDispatched] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // The owner gate is enforced at the section level, but skipping the fetch
  // here too keeps this card independently safe if ever reused.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getResetStatus();
        if (cancelled) return;
        setTargetHint(status.targetHint);
        setLatestJob(status.job);
        if (status.job?.status === "dispatched") setDispatched(true);
      } catch {
        // Non-fatal — the card still works without the hint: the typed name
        // is validated SERVER-side, so a failed status read can never let a
        // reset through that the server wouldn't have allowed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConfirm = useCallback(async (typed: string) => {
    // 2026-06-09 sweep: the owner confirms by typing the device's name (from
    // Settings → Device information). The API only ever gives us a masked
    // hint, so the typed value goes to the server verbatim and the SERVER
    // decides — a mismatch throws and the modal surfaces it for retry.
    const res = await triggerFactoryReset(typed);
    // Success: the wipe is dispatched and the box is going down. Close the modal
    // and switch the section to the terminal progress notice.
    setLatestJob({
      id: res.id,
      status: res.status,
      targetName: res.targetName,
      failureReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    setDispatched(true);
    setModalOpen(false);
  }, []);

  return (
    <>
      {/* Fenced, danger-tinted card so it reads as categorically dangerous. */}
      <div
        className="card"
        style={{
          borderColor: "color-mix(in srgb, var(--danger) 30%, var(--card-bd))",
          background: "color-mix(in srgb, var(--danger) 4%, var(--card-bg))",
          padding: 0,
          overflow: "hidden",
        }}
      >
        {dispatched ? (
          // Terminal progress notice — the box is wiping and returning to setup.
          <div className="flex items-start gap-3 p-4">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)" }}
            >
              <RotateCcw size={18} style={{ color: "var(--danger)" }} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="type-headline" style={{ color: "var(--text)" }}>Factory reset is under way</p>
              <p className="type-footnote mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                The box is erasing all data and returning to first-run setup. This
                takes a few minutes, and the dashboard will go offline while it
                works. When it comes back, you&rsquo;ll start from the setup wizard.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="flex items-start gap-3 min-w-0">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)" }}
              >
                <AlertTriangle size={18} style={{ color: "var(--danger)" }} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="type-headline" style={{ color: "var(--text)" }}>Factory reset</p>
                <p className="type-footnote mt-1 leading-relaxed" style={{ color: "var(--text-muted)" }}>
                  Erase every account, file, message, smart-home setup, and
                  setting on this box and return it to first-run setup. This
                  cannot be undone.
                </p>
                {latestJob?.status === "failed" && latestJob.failureReason && (
                  <p className="type-caption-1 mt-1" style={{ color: "var(--text-muted)" }}>
                    Last attempt didn&rsquo;t start: {latestJob.failureReason}
                  </p>
                )}
              </div>
            </div>
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setModalOpen(true)}
              className="btn danger shrink-0"
            >
              Factory reset…
            </button>
          </div>
        )}
      </div>

      <FactoryResetConfirm
        open={modalOpen}
        title="Factory reset this Droplet?"
        consequence={
          <>
            This erases every account, file, message, smart-home setup, and
            setting on the box, and returns it to first-run setup. Your data
            cannot be recovered afterward. The dashboard will go offline while
            the reset runs. To confirm, type your device&rsquo;s name — you can
            find it under Settings → Device information.
          </>
        }
        confirmPrompt="your device's name"
        confirmHint={targetHint || undefined}
        confirmLabel="Factory reset"
        busyLabel="Resetting…"
        targetSummary={targetHint || undefined}
        onConfirm={handleConfirm}
        onCancel={() => setModalOpen(false)}
        triggerRef={triggerRef}
      />
    </>
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
