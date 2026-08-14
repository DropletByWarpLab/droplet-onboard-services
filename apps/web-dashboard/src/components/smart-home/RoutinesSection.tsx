"use client";

import { useRef, useState } from "react";
import { Play, Loader2, Sparkles, Plus, Pencil, Trash2, CalendarClock } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { runScene, deleteScene, type Scene } from "@/lib/api";
import { SceneEditorModal } from "./SceneEditorModal";
import { SceneScheduleEditor } from "./SceneScheduleEditor";

/**
 * Routines (scenes, WARP-474) on the smart-home page — saved device batches an
 * owner can run in one tap. Running fires Tier-2 device actions, so it is
 * confirm-gated (ConfirmDialog → ?confirm=true). When `canAuthor` (owner/admin),
 * the section also surfaces create / edit / delete via SceneEditorModal, wired
 * to the /api/scenes CRUD. `onChanged` lets the parent revalidate (the KPI count
 * + this list share the SWR cache, so a refresh updates both).
 */
type Editor = { mode: "create" } | { mode: "edit"; sceneId: string } | null;

export function RoutinesSection({
  scenes,
  canAuthor = false,
  onChanged,
}: {
  scenes: Scene[];
  canAuthor?: boolean;
  onChanged?: () => void;
}) {
  const [pending, setPending] = useState<Scene | null>(null);
  const [deleting, setDeleting] = useState<Scene | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [scheduling, setScheduling] = useState<Scene | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  async function doRun(scene: Scene) {
    setRunning(scene.id);
    try {
      const { successCount, actionCount } = await runScene(scene.id);
      setToast(
        actionCount > 0 && successCount === actionCount
          ? `${scene.name} ran — ${actionCount} action${actionCount === 1 ? "" : "s"}`
          : `${scene.name} ran with issues — ${successCount} of ${actionCount} succeeded`,
      );
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Couldn't run ${scene.name}`);
    } finally {
      setRunning(null);
    }
  }

  async function doDelete(scene: Scene) {
    try {
      await deleteScene(scene.id);
      setToast(`${scene.name} deleted`);
      onChanged?.();
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Couldn't delete ${scene.name}`);
    }
  }

  const header = (
    <div className="flex items-center justify-between mb-3">
      <h2 className="type-title-3" style={{ color: "var(--text)" }}>
        Routines{" "}
        {scenes.length > 0 && (
          <span className="type-subheadline" style={{ color: "var(--text-muted)" }}>({scenes.length})</span>
        )}
      </h2>
      {canAuthor && (
        <button type="button" className="btn sm" onClick={() => setEditor({ mode: "create" })}>
          <Plus size={14} /> New routine
        </button>
      )}
    </div>
  );

  return (
    <section>
      {header}

      {scenes.length === 0 ? (
        <div className="card">
          <div className="empty">
            <span className="ei">
              <Sparkles size={24} />
            </span>
            <span className="eh">No routines yet</span>
            <span>
              Routines run several devices at once — like dimming the lights and
              locking up for the night.
            </span>
            {canAuthor && (
              <button
                type="button"
                className="btn primary"
                style={{ marginTop: 10 }}
                onClick={() => setEditor({ mode: "create" })}
              >
                <Plus size={16} /> Create your first routine
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="grid c3">
          {scenes.map((scene) => (
            <div key={scene.id} className="card flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
              >
                <Sparkles size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline font-medium truncate" style={{ color: "var(--text)" }}>
                  {scene.name}
                </p>
                <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
                  {scene.actionCount} action{scene.actionCount === 1 ? "" : "s"}
                </p>
              </div>
              {canAuthor && (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setScheduling(scene)}
                    aria-label={`Schedule ${scene.name}`}
                  >
                    <CalendarClock size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setEditor({ mode: "edit", sceneId: scene.id })}
                    aria-label={`Edit ${scene.name}`}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setDeleting(scene)}
                    aria-label={`Delete ${scene.name}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              )}
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
      )}

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
          const btn = triggerRef.current;   // capture before setPending clears the conditional ref
          setPending(null);
          if (scene) {
            await doRun(scene);
            requestAnimationFrame(() => btn?.focus());
          }
        }}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete “${deleting.name}”?` : "Delete routine?"}
        description="This removes the routine. The devices it controlled are unaffected."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={async () => {
          const scene = deleting;
          setDeleting(null);
          if (scene) await doDelete(scene);
        }}
        onCancel={() => setDeleting(null)}
      />

      {editor && (
        <SceneEditorModal
          mode={editor.mode}
          sceneId={editor.mode === "edit" ? editor.sceneId : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => onChanged?.()}
        />
      )}

      {scheduling && (
        <SceneScheduleEditor
          sceneId={scheduling.id}
          sceneName={scheduling.name}
          onClose={() => setScheduling(null)}
        />
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-[calc(72px+env(safe-area-inset-bottom))] right-4 lg:bottom-4 z-50 bg-label-primary text-surface-primary px-3 py-2 rounded shadow flex items-center gap-2"
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
