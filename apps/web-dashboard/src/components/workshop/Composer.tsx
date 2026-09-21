"use client";
/**
 * WARP-2974 (ADR-056) — the Workshop's composer: the chat capsule
 * (`chat-composer*`, chat-indigo.css) pointed at `POST /api/agent-runs`.
 *
 * The goal, a `Work in` chip choosing an ordinary run or one custom tool's
 * workspace (which makes it a WORKSHOP run — WARP-2896), the safety chips
 * every write surface carries, and Start. Enter sends, Shift+Enter breaks
 * a line — the chat's own rule.
 */
import { forwardRef, useState, type ForwardedRef } from "react";
import { Eye, Hammer, Pencil, Play } from "lucide-react";
import type { WorkspaceSummary } from "./workspaces/api";

const GOAL_MAX = 4000;

export interface ComposerProps {
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  onWorkspaceId: (id: string) => void;
  busy: boolean;
  disabled?: boolean;
  /** Resolves true when the run was started — the field clears only then. */
  onSubmit: (goal: string) => Promise<boolean>;
  /** A line under the row — a notice or a calm error. */
  status?: { text: string; title?: string } | null;
}

export const Composer = forwardRef(function Composer(
  { workspaces, workspaceId, onWorkspaceId, busy, disabled, onSubmit, status }: ComposerProps,
  ref: ForwardedRef<HTMLTextAreaElement>,
) {
  const [goal, setGoal] = useState("");
  const selected = workspaces.find((w) => w.id === workspaceId) ?? null;
  const canSend = !busy && !disabled && goal.trim().length > 0;

  const send = async () => {
    const trimmed = goal.trim();
    if (!trimmed || busy || disabled) return;
    if (await onSubmit(trimmed)) setGoal("");
  };

  return (
    <div className="chat-composer">
      <form
        className="chat-composer-inner"
        aria-label="Start a run"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={ref}
          rows={2}
          maxLength={GOAL_MAX}
          value={goal}
          disabled={busy || disabled}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            selected
              ? `Build ${selected.name} so that it… (what should this tool do?)`
              : "What should your Droplet do? e.g. go through last week's scans and draft a booking for each one without an appointment"
          }
          aria-label={selected ? `What should ${selected.name} do?` : "What should your Droplet do?"}
        />
        <div className="chat-crow">
          <label className="ws-workin" title="An ordinary run works across the box. A custom tool's workspace makes it a workshop run.">
            <Hammer size={13} aria-hidden />
            <span className="sr-only">Work in</span>
            <select value={workspaceId} disabled={busy || disabled} onChange={(e) => onWorkspaceId(e.target.value)} data-testid="workspace-select">
              <option value="">No workspace — an ordinary run</option>
              {workspaces
                .filter((w) => w.status === "active")
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </label>
          <span className="ws-safety">
            <span className="badge ok ws-chip">
              <Eye size={10} aria-hidden />
              Read · stays on LAN
            </span>
            <span className="badge warn ws-chip">
              <Pencil size={10} aria-hidden />
              Write · confirm to apply
            </span>
          </span>
          <button type="submit" className="chat-send" disabled={!canSend} aria-label="Start run" title="Start run">
            <Play size={15} aria-hidden />
          </button>
        </div>
        {status && (
          <p className="ws-status m-0" role="status" title={status.title}>
            {status.text}
          </p>
        )}
      </form>
    </div>
  );
});
