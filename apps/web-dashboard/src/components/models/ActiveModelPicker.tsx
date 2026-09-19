"use client";

/**
 * WARP-1112 — pick the box's active local model on the Models surface.
 *
 * The one control that changes which installed local model this Droplet
 * answers with by default. Selecting a model calls PATCH /api/models/active
 * (owner/admin only); the choice persists and the chat picker defaults to it.
 *
 * Honesty contract (matches the rest of /models):
 *   - Only offers models already installed on the box — this never pulls.
 *   - Members (non owner/admin) see the active model read-only, with a plain
 *     note about who can change it — buttons aren't shown as disabled walls.
 *   - One model installed → the selector still shows it (marked active) so the
 *     capability is visible; there's simply nothing else to switch to yet.
 *   - "Takes effect on your next message" is stated, not hidden: switching
 *     only re-points the default; the model loads when chat next uses it.
 */

import { useState } from "react";
import { Check, Cpu, Loader2 } from "lucide-react";
import { setActiveModel } from "@/lib/api";
import { formatContext } from "./LocalModelCard";
import type { LocalModelRow } from "@/lib/types";

interface ActiveModelPickerProps {
  models: LocalModelRow[];
  /** The persisted active model (`ai.model.chat`), or null when unset. */
  activeModel: string | null;
  /** True for owner/admin — only they can change the model. */
  canManage: boolean;
  /** Re-fetch the page payload after a successful change. */
  onChanged: () => void;
}

export function ActiveModelPicker({
  models,
  activeModel,
  canManage,
  onChanged,
}: ActiveModelPickerProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (models.length === 0) return null;

  // The model the box effectively answers with: the explicit setting, else
  // the single installed model (chat falls back to it regardless), else none.
  // WARP-2882 — select/compare on the runtime id; `name` is display copy.
  // `?? name` keeps an orchestrator that predates `id` working unchanged.
  const idOf = (m: LocalModelRow) => m.id ?? m.name;
  const effective =
    activeModel ?? (models.length === 1 ? idOf(models[0]) : null);

  async function choose(id: string) {
    if (!canManage || pending || id === effective) return;
    setPending(id);
    setError(null);
    try {
      await setActiveModel(id);
      onChanged();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn’t change the model. Try again.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="active-model-heading">
      <div className="sect">
        <h2 id="active-model-heading">Active model</h2>
        <span className="sx">The model your Droplet answers with</span>
      </div>

      {/* Same 2-up grid as the Local cards below, so this card shares their
          column width and left/right edges instead of stretching a single
          row across the whole page. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div
          className="card"
          role={canManage ? "radiogroup" : undefined}
          aria-label={canManage ? "Active model" : undefined}
          style={{ padding: 6 }}
        >
          <div className="rows">
            {models.map((m) => {
              const isActive = idOf(m) === effective;
              const isPending = pending === idOf(m);
              const interactive = canManage && !isPending;
              // What actually distinguishes one installed model from another:
              // family, size, quantization, context window, and whether it is
              // already resident (an unloaded model pays a load on first use).
              const spec = [
                m.family,
                m.parameterSize,
                m.quantization,
                // WARP-2882 — trained length, display only; the served
                // window is an operator setting.
                m.trainedContextLength != null
                  ? `${formatContext(m.trainedContextLength)} trained context`
                  : null,
                m.loaded ? "in memory" : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <button
                  key={idOf(m)}
                  type="button"
                  role={canManage ? "radio" : undefined}
                  aria-checked={canManage ? isActive : undefined}
                  disabled={!interactive || isActive}
                  onClick={() => choose(idOf(m))}
                  className="lrow enabled:hover:bg-[var(--inset)] focus-visible:outline-2 focus-visible:outline-[var(--brand)]"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: 0,
                    font: "inherit",
                    padding: "10px 12px",
                    borderRadius: 11,
                    background: isActive ? "var(--brand-subtle)" : "transparent",
                    cursor:
                      !canManage || isActive
                        ? "default"
                        : isPending
                          ? "progress"
                          : "pointer",
                  }}
                >
                  <span className="ri brand" aria-hidden>
                    <Cpu size={17} strokeWidth={2} />
                  </span>

                  <span className="rt">
                    <span className="nm">{m.name}</span>
                    <span className="sub" title={spec}>
                      {spec}
                    </span>
                  </span>

                  {isPending ? (
                    <span className="rmeta inline-flex items-center gap-1.5">
                      <Loader2 size={14} className="animate-spin" aria-hidden />
                      Switching…
                    </span>
                  ) : isActive ? (
                    <span
                      className="rmeta inline-flex items-center gap-1.5 font-medium"
                      style={{ color: "var(--brand)" }}
                    >
                      <Check size={14} strokeWidth={2.5} aria-hidden />
                      Active
                    </span>
                  ) : canManage ? (
                    <span className="rmeta">Use this</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Honest framing beneath the picker. */}
      <p
        className="type-caption-1"
        role={error ? "alert" : undefined}
        style={{
          color: error ? "var(--system-red, #ff3b30)" : "var(--text-muted)",
          marginTop: 12,
        }}
      >
        {error
          ? error
          : canManage
            ? models.length <= 1
              ? "This is the only model installed on your Droplet right now, so there’s nothing else to switch to yet."
              : "Switching takes effect on your next message — the first reply may take a moment while the model loads."
            : "Only owners and admins can change the model."}
      </p>
    </section>
  );
}
