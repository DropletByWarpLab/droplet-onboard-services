"use client";

import { useState } from "react";
import { Loader2, Wrench } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import { useToast } from "@/components/Toast";
import { fetchRetentionBackfillPlan, runRetentionBackfill } from "@/lib/api";
import { describeRepairWindows } from "@/lib/camera-recording";
import { isCamerasUnavailableError } from "@/lib/files-unavailable";
import type { CameraInfo, RetentionBackfillDefaults } from "@/lib/types";

/**
 * WARP-3511 — the repair for a camera that is "Live · not saving".
 *
 * Cameras adopted before retention defaults existed have no retention
 * authored at all, so they decode and detect and keep nothing. The repair is
 * the appliance's own (`POST /api/cameras/retention/backfill`); this is the
 * way to reach it from the camera that is showing the symptom.
 *
 * Two things shape it:
 *
 *  - The repair is box-wide and restarts the camera service, so it checks
 *    first (the dry run) and says exactly which cameras it will touch before
 *    anything happens.
 *  - It only helps a camera whose retention was NEVER authored. One switched
 *    to zero on purpose is left alone by design, and running the repair for it
 *    would restart every camera to change nothing. For that camera it points
 *    at Settings instead.
 *
 * Owner / admin only; the caller does not render it for anyone else.
 */
export function RetentionFixButton({
  cameraName,
  cameras = [],
  onDone,
  appearance = "card",
}: {
  cameraName: string;
  /** Used only to show household names instead of keys. */
  cameras?: ReadonlyArray<Pick<CameraInfo, "name" | "displayName">>;
  /** Called after a repair was applied, so the page can refresh its list. */
  onDone?: () => void;
  appearance?: "card" | "dark";
}) {
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  const [targets, setTargets] = useState<string[] | null>(null);
  // What the repair will write, from the box. Never a figure of our own.
  const [willKeep, setWillKeep] = useState<RetentionBackfillDefaults | undefined>(undefined);

  const nameOf = (key: string) =>
    cameras.find((c) => c.name === key)?.displayName ?? key.replace(/_/g, " ");

  const failure = (e: unknown) =>
    isCamerasUnavailableError(e)
      ? "The camera service isn't responding. Try again in a moment."
      : e instanceof Error && e.message
        ? e.message
        : "Couldn't repair this camera.";

  const start = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const { plan, defaults } = await fetchRetentionBackfillPlan();
      const willWrite = plan.filter((p) => p.willWrite).map((p) => p.camera);
      if (!willWrite.includes(cameraName)) {
        toast(
          "Recording was set up this way on purpose, so there is nothing to repair. Change it in Settings.",
          "info",
        );
        return;
      }
      setWillKeep(defaults);
      setTargets(willWrite);
    } catch (e) {
      toast(failure(e), "error");
    } finally {
      setChecking(false);
    }
  };

  const apply = async () => {
    try {
      const result = await runRetentionBackfill();
      toast(
        result.noop
          ? "Nothing needed repairing."
          : `Recording settings updated for ${result.written.length} camera${result.written.length === 1 ? "" : "s"}. The camera service is restarting.`,
        "success",
      );
      onDone?.();
    } catch (e) {
      toast(failure(e), "error");
      // ConfirmDialog keeps itself open when this rejects.
      throw e;
    }
  };

  const buttonClass =
    appearance === "dark"
      ? "inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/15 text-white hover:bg-white/25 transition-colors type-caption-1 disabled:opacity-60"
      : "btn";

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={checking}
        className={buttonClass}
        aria-label={`Fix: start saving footage for ${nameOf(cameraName)}`}
      >
        {checking ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Wrench size={14} aria-hidden="true" />}
        Fix
      </button>

      <ConfirmDialog
        open={targets !== null}
        title="Start saving footage?"
        description={`This gives ${(targets ?? []).map(nameOf).join(", ")} the retention a new camera gets, so ${
          (targets ?? []).length === 1 ? "it starts" : "they start"
        } saving footage.${
          describeRepairWindows(willKeep) ? ` It keeps ${describeRepairWindows(willKeep)}.` : ""
        } It restarts the camera service, so every camera drops for a few seconds.`}
        confirmLabel="Fix"
        variant="neutral"
        accessory={<SafetyChip variant="write" />}
        onConfirm={apply}
        onCancel={() => setTargets(null)}
      />
    </>
  );
}
