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
  const effective =
    activeModel ?? (models.length === 1 ? models[0].name : null);

  async function choose(name: string) {
    if (!canManage || pending || name === effective) return;
    setPending(name);
    setError(null);
    try {
      await setActiveModel(name);
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

      <div
        className="card"
        role={canManage ? "radiogroup" : undefined}
        aria-label={canManage ? "Active model" : undefined}
        style={{ padding: 6 }}
      >
        <div className="rows">
          {models.map((m) => {
            const isActive = m.name === effective;
            const isPending = pending === m.name;
            const interactive = canManage && !isPending;
            return (
              <button
                key={m.name}
                type="button"
                role={canManage ? "radio" : undefined}
                aria-checked={canManage ? isActive : undefined}
                disabled={!interactive || isActive}
                onClick={() => choose(m.name)}
                className="row"
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: isActive ? "var(--brand-subtle)" : "transparent",
                  cursor:
                    !canManage || isActive
                      ? "default"
                      : isPending
                        ? "progress"
                        : "pointer",
                }}
              >
                <span
                  className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
                  style={{
                    background: "var(--brand-subtle)",
                    color: "var(--brand)",
                  }}
                  aria-hidden
                >
                  <Cpu size={16} strokeWidth={2} />
                </span>

                <span className="flex-1 min-w-0">
                  <span
                    className="type-subheadline font-medium truncate block"
                    style={{ color: "var(--text)" }}
                  >
                    {m.name}
                  </span>
                  <span
                    className="type-caption-1 truncate block"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {m.family}
                  </span>
                </span>

                {isPending ? (
                  <span
                    className="inline-flex items-center gap-1.5 type-caption-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <Loader2 size={14} className="animate-spin" aria-hidden />
                    Switching…
                  </span>
                ) : isActive ? (
                  <span
                    className="inline-flex items-center gap-1.5 type-caption-1 font-medium"
                    style={{ color: "var(--brand)" }}
                  >
                    <Check size={14} strokeWidth={2.5} aria-hidden />
                    Active
                  </span>
                ) : canManage ? (
                  <span
                    className="type-caption-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Use this
                  </span>
                ) : null}
              </button>
            );
          })}
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
