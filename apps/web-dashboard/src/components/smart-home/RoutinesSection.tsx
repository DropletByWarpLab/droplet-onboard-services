"use client";

import { useRef, useState } from "react";
import { Play, Loader2, Sparkles } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { runScene, type Scene } from "@/lib/api";

/**
 * Routines (scenes, WARP-474) on the smart-home page — a list of saved device
 * batches an owner can run in one tap. Running a routine fires Tier-2 device
 * actions, so it is confirm-gated: the Run button opens a ConfirmDialog (the
 * Write-tier safety gate), then calls the server with ?confirm=true. Authoring
 * routines (the drag-reorder action editor) is out of scope here — this surface
 * lists and runs them.
 */
export function RoutinesSection({ scenes }: { scenes: Scene[] }) {
  const [pending, setPending] = useState<Scene | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (scenes.length === 0) {
    return (
      <section>
        <h2 className="type-title-3 text-label-primary mb-3">Routines</h2>
        <div className="card">
          <div className="empty">
            <span className="ei">
              <Sparkles size={24} />
            </span>
            <span className="eh">No routines yet</span>
            <span>
              Routines run several devices at once — like dimming the lights and
              locking up for the night. Ask Droplet in chat to create one.
            </span>
          </div>
        </div>
      </section>
    );
  }

  async function doRun(scene: Scene) {
    setRunning(scene.id);
    try {
      const outcome = await runScene(scene.id);
      const { successCount, actionCount } = outcome;
      setToast(
        successCount === actionCount
          ? `${scene.name} ran — ${actionCount} action${actionCount === 1 ? "" : "s"}`
          : `${scene.name} ran with issues — ${successCount} of ${actionCount} succeeded`,
      );
    } catch (e) {
      setToast(
        e instanceof Error ? e.message : `Couldn't run ${scene.name}`,
      );
    } finally {
      setRunning(null);
    }
  }

  return (
    <section>
      <h2 className="type-title-3 text-label-primary mb-3">
        Routines{" "}
        <span className="type-subheadline text-label-tertiary">
          ({scenes.length})
        </span>
      </h2>
      <div className="grid c3">
        {scenes.map((scene) => (
          <div key={scene.id} className="card flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-accent/15 text-accent">
              <Sparkles size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="type-subheadline text-label-primary font-medium truncate">
                {scene.name}
              </p>
              <p className="type-caption-1 text-label-tertiary">
                {scene.actionCount} action{scene.actionCount === 1 ? "" : "s"}
              </p>
            </div>
            <button
              ref={pending?.id === scene.id ? triggerRef : undefined}
              type="button"
              className="btn sm"
              disabled={running !== null}
              onClick={() => setPending(scene)}
              aria-label={`Run ${scene.name}`}
            >
              {running === scene.id ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              Run
            </button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={pending !== null}
        triggerRef={triggerRef}
        title={pending ? `Run “${pending.name}”?` : "Run routine?"}
        description={
          pending
            ? `This runs ${pending.actionCount} device action${pending.actionCount === 1 ? "" : "s"} now. Logged to Activity.`
            : ""
        }
        confirmLabel="Run"
        variant="neutral"
        onConfirm={async () => {
          const scene = pending;
          setPending(null);
          if (scene) await doRun(scene);
        }}
        onCancel={() => setPending(null)}
      />

      {toast && (
        <div
          role="status"
          className="fixed bottom-4 right-4 bg-label-primary text-surface-primary px-3 py-2 rounded shadow flex items-center gap-2 z-50"
        >
          <span className="type-subheadline">{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss"
            className="ml-1 opacity-80 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}
