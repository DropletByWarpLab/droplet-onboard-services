"use client";
/**
 * WARP-2974 (ADR-056) — the Workshop's composer, pointed at
 * `POST /api/agent-runs`.
 *
 * One floating pill, the Mac app's composer anatomy (DropletAgent design
 * spec §5: `+`, field, a selector, send): `+` makes a new custom tool, the
 * goal field grows with what is typed, the `Work in` chip (WorkInPicker — a
 * themed menu, not a native select) chooses an ordinary run or one custom
 * tool's workspace (which makes it a WORKSHOP run — WARP-2896), and Start.
 * The safety chips every write surface carries sit on the quiet line under
 * the pill, with any notice. Enter sends, Shift+Enter breaks a line — the
 * chat's own rule.
 */
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ForwardedRef } from "react";
import { ArrowUp, Eye, Pencil, Plus } from "lucide-react";
import type { WorkspaceSummary } from "./workspaces/api";
import { WorkInPicker } from "./WorkInPicker";

const GOAL_MAX = 4000;

export interface ComposerProps {
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  onWorkspaceId: (id: string) => void;
  busy: boolean;
  disabled?: boolean;
  /** Resolves true when the run was started — the field clears only then. */
  onSubmit: (goal: string) => Promise<boolean>;
  /** The pill's `+`: open the new-custom-tool dialog from this trigger. */
  onNewTool?: (trigger: HTMLElement | null) => void;
  /** A line under the pill — a notice or a calm error. */
  status?: { text: string; title?: string } | null;
}

export const Composer = forwardRef(function Composer(
  { workspaces, workspaceId, onWorkspaceId, busy, disabled, onSubmit, onNewTool, status }: ComposerProps,
  ref: ForwardedRef<HTMLTextAreaElement>,
) {
  const [goal, setGoal] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => fieldRef.current as HTMLTextAreaElement);
  const selected = workspaces.find((w) => w.id === workspaceId) ?? null;
  const canSend = !busy && !disabled && goal.trim().length > 0;

  // The field grows with its text up to the CSS max-height, and shrinks back
  // when the goal is sent and cleared.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [goal]);

  const send = async () => {
    const trimmed = goal.trim();
    if (!trimmed || busy || disabled) return;
    if (await onSubmit(trimmed)) setGoal("");
  };

  return (
    <div className="chat-composer">
      <form
        className="chat-composer-inner ws-pill"
        aria-label="Start a run"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {onNewTool && (
          <button
            type="button"
            className="ws-pill-btn"
            aria-label="New custom tool"
            title="New custom tool"
            disabled={busy || disabled}
            onClick={(e) => onNewTool(e.currentTarget)}
          >
            <Plus size={17} aria-hidden />
          </button>
        )}
        <textarea
          ref={fieldRef}
          rows={1}
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
          placeholder={selected ? `Build ${selected.name} so that it…` : "What should your Droplet do?"}
          aria-label={selected ? `What should ${selected.name} do?` : "What should your Droplet do?"}
        />
        <WorkInPicker workspaces={workspaces} workspaceId={workspaceId} onWorkspaceId={onWorkspaceId} disabled={busy || disabled} />
        <button type="submit" className="chat-send" disabled={!canSend} aria-label="Start run" title="Start run">
          <ArrowUp size={16} aria-hidden />
        </button>
      </form>
      <div className="ws-hint">
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
        {status && (
          <p className="ws-status m-0" role="status" title={status.title}>
            {status.text}
          </p>
        )}
      </div>
    </div>
  );
});
