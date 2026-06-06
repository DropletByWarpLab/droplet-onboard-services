"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useAuth } from "@/lib/auth";
import {
  getResetStatus,
  triggerFactoryReset,
  type ResetJob,
} from "@/lib/api";
import { DestructiveConfirm } from "@/components/DestructiveConfirm";

/**
 * WARP-825 — Settings "Danger Zone".
 *
 * The owner-only home for the factory reset. It sits at the very bottom of
 * Settings, visually fenced off in system-red so it reads as categorically more
 * dangerous than the configuration above it. The reset itself runs through
 * <DestructiveConfirm> (blunt copy + type-to-confirm friction + progress/error
 * states), and the server re-enforces both the owner gate (requireRole) and the
 * typed-name check — this section is the UX layer, not the authority.
 *
 * Tokens only: system-red for the destructive frame + button, dp-* / type-* /
 * text-label-*. No invented colors.
 */
export function DangerZoneSection() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner";

  const [targetName, setTargetName] = useState<string>("");
  const [latestJob, setLatestJob] = useState<ResetJob | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // Once a reset is dispatched the box is tearing down; we flip to a terminal
  // "under way" notice rather than keep an actionable button live.
  const [dispatched, setDispatched] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Only an owner ever loads the reset surface. Skipping the fetch for
  // non-owners also avoids a needless 403 in their console.
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await getResetStatus();
        if (cancelled) return;
        setTargetName(status.targetName);
        setLatestJob(status.job);
        if (status.job?.status === "dispatched") setDispatched(true);
      } catch {
        // Non-fatal — leave the entry without a target name; the confirm flow
        // can't enable until we have one (the friction phrase would be empty),
        // so a failed status read fails safe (reset can't be triggered blind).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  const handleConfirm = useCallback(async () => {
    const res = await triggerFactoryReset(targetName);
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
  }, [targetName]);

  // Non-owners: render nothing at all (no empty fenced box, no dead control).
  if (!isOwner) return null;

  return (
    <section className="mb-10">
      <h2 className="type-footnote text-system-red uppercase tracking-wider px-1 mb-2">
        Danger zone
      </h2>

      {/* Fenced, system-red-tinted card so it reads as categorically dangerous. */}
      <div className="rounded-lg border border-system-red/30 bg-system-red/[0.04] overflow-hidden">
        {dispatched ? (
          // Terminal progress notice — the box is wiping and returning to setup.
          <div className="flex items-start gap-3 p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-system-red/10">
              <RotateCcw size={18} className="text-system-red" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="type-headline text-label-primary">Factory reset is under way</p>
              <p className="type-footnote text-label-secondary mt-1 leading-relaxed">
                The box is erasing all data and returning to first-run setup. This
                takes a few minutes, and the dashboard will go offline while it
                works. When it comes back, you&rsquo;ll start from the setup wizard.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="flex items-start gap-3 min-w-0">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-system-red/10">
                <AlertTriangle size={18} className="text-system-red" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="type-headline text-label-primary">Factory reset</p>
                <p className="type-footnote text-label-secondary mt-1 leading-relaxed">
                  Erase every account, file, message, and setting on this box and
                  return it to first-run setup. This cannot be undone.
                </p>
                {latestJob?.status === "failed" && latestJob.failureReason && (
                  <p className="type-caption-1 text-label-tertiary mt-1">
                    Last attempt didn&rsquo;t start: {latestJob.failureReason}
                  </p>
                )}
              </div>
            </div>
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setModalOpen(true)}
              className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-sm border border-system-red/40 bg-transparent px-4 py-2.5 font-medium text-system-red type-subheadline transition-all duration-200 ease-smooth hover:bg-system-red/10 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-system-red/50"
            >
              Factory reset…
            </button>
          </div>
        )}
      </div>

      <DestructiveConfirm
        open={modalOpen}
        title="Factory reset this Droplet?"
        consequence={
          <>
            This erases every account, file, message, smart-home setup, and
            setting on the box, and returns it to first-run setup. Your data
            cannot be recovered afterward. The dashboard will go offline while
            the reset runs.
          </>
        }
        confirmPhrase={targetName}
        confirmLabel="Factory reset"
        busyLabel="Resetting…"
        targetSummary={targetName || undefined}
        onConfirm={handleConfirm}
        onCancel={() => setModalOpen(false)}
        triggerRef={triggerRef}
      />
    </section>
  );
}
