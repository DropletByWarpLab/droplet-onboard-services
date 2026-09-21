"use client";
/**
 * WARP-2974 (ADR-056) — one run, read as a conversation.
 *
 * The goal is the person's message. Every tool call the run made is a step
 * row under it — mono tool name, what happened, the arguments, the result
 * behind a disclosure. When the run parks on a change it wants to make, the
 * decision card sits INLINE at that point with provenance: which run, which
 * tool, a PHI-free shape of the arguments (never a value). The result or the
 * stop is the run's closing message. This is the WARP-2180 panel's detail
 * half, re-read as a transcript; the data contract is unchanged.
 *
 * Nothing here streams — a run has no browser attached by definition and the
 * persisted trace IS its progress. The parent re-reads a live run every few
 * seconds and hands the fresh detail down.
 */
import { AlertTriangle, Check, CircleDashed, Hammer, ShieldAlert, ShieldCheck, ShieldX, User, X } from "lucide-react";
import { LIVE_STATUSES, STATUS_LABELS, type AgentRunDetail, type AgentRunStatus, type TraceEntry } from "./agent-runs/api";

const BADGE_KIND: Record<AgentRunStatus, string> = {
  queued: "muted",
  running: "info",
  awaiting_confirmation: "warn",
  succeeded: "ok",
  failed: "danger",
  cancelled: "muted",
};

export function RunStatusChip({ status, small }: { status: AgentRunStatus; small?: boolean }) {
  // An unknown wire value renders capitalised raw, never crashes.
  const label = STATUS_LABELS[status] ?? `${String(status).charAt(0).toUpperCase()}${String(status).slice(1)}`;
  return (
    <span className={`badge ${BADGE_KIND[status] ?? "muted"}${small ? " ws-chip" : ""}`} data-status={status}>
      <span className={`dot${status === "running" ? " is-live" : ""}`} style={{ background: "currentColor" }} aria-hidden />
      {label}
    </span>
  );
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function compactJson(v: unknown, max = 240): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return clip(s ?? "", max);
}

type StepKind = "ok" | "error" | "parked" | "working" | "muted";

function stepOf(entry: TraceEntry): { kind: StepKind; marker: string } {
  if (entry.confirmation === "parked") return { kind: "parked", marker: "parked for your OK" };
  if (entry.confirmation === "confirmed") return { kind: "ok", marker: "approved and run" };
  if (entry.confirmation === "denied") return { kind: "muted", marker: "declined" };
  if (entry.replayOf) return { kind: "ok", marker: "replayed after resume" };
  // WARP-2877 — it has no result and never will: the run was interrupted
  // mid-call and this tool writes, so it was not repeated. Anything else
  // here would read as "still working".
  if (entry.unknownOutcome) return { kind: "error", marker: "interrupted — may have run, not repeated" };
  if (entry.text === undefined) return { kind: "working", marker: "working…" };
  if (entry.isError) return { kind: "error", marker: "error" };
  return { kind: "ok", marker: "done" };
}

function StepIcon({ kind }: { kind: StepKind }) {
  const size = 11;
  if (kind === "ok") return <Check size={size} aria-hidden />;
  if (kind === "error") return <AlertTriangle size={size} aria-hidden />;
  if (kind === "parked") return <ShieldAlert size={size} aria-hidden />;
  if (kind === "working") return <CircleDashed size={size} aria-hidden />;
  return <X size={size} aria-hidden />;
}

function Step({ entry }: { entry: TraceEntry }) {
  const { kind, marker } = stepOf(entry);
  return (
    <li className={`ws-step is-${kind}`}>
      <span className="ws-step-ic">
        <StepIcon kind={kind} />
      </span>
      <div className="ws-step-line">
        <span className="ws-step-tool">{entry.tool}</span>
        <span className="ws-step-meta">step {entry.iteration + 1}</span>
        <span className="ws-step-meta">{marker}</span>
        <span className="ws-step-meta r">{when(entry.completedAt ?? entry.dispatchedAt)}</span>
      </div>
      <div className="ws-step-args" title="arguments">
        {compactJson(entry.args)}
      </div>
      {entry.text !== undefined && (
        <details>
          <summary>result</summary>
          <pre className="ws-pre">{clip(entry.text, 4000)}</pre>
        </details>
      )}
    </li>
  );
}

export interface RunTranscriptProps {
  detail: AgentRunDetail;
  /** True while a decision or cancel for THIS run is in flight. */
  busy: boolean;
  /** The workspace's name when the run works in one (its id otherwise). */
  workspaceName?: string | null;
  onApprove: () => void;
  onDecline: () => void;
  onCancel: () => void;
  onOpenWorkspace?: (id: string) => void;
}

export function RunTranscript({ detail, busy, workspaceName, onApprove, onDecline, onCancel, onOpenWorkspace }: RunTranscriptProps) {
  const live = LIVE_STATUSES.has(detail.status);
  const parked = detail.status === "awaiting_confirmation" && detail.pending && !detail.pending.decision;
  const proposed = detail.stopReason === "proposed";

  return (
    <article className="ws-thread" data-testid="agent-run-detail" aria-label="Run transcript">
      {/* The person's message: the goal. */}
      <div className="msg is-user">
        <span className="msg-ava is-user" aria-hidden>
          <User size={15} />
        </span>
        <div className="msg-col">
          <div className="msg-bubble is-user">{detail.goal}</div>
        </div>
      </div>

      <div className="ws-runline" aria-label="Run facts">
        <RunStatusChip status={detail.status} small />
        <span>
          step {detail.iteration}/{detail.maxIter}
        </span>
        <span>started {when(detail.startedAt)}</span>
        {detail.endedAt ? <span>ended {when(detail.endedAt)}</span> : null}
        {detail.attempts > 0 ? <span>resumed {detail.attempts}×</span> : null}
        {live ? <span>updating</span> : null}
        {detail.workspaceId ? (
          <button
            type="button"
            className="btn sm ghost"
            style={{ height: 24, padding: "0 8px", fontSize: 11.5 }}
            onClick={() => detail.workspaceId && onOpenWorkspace?.(detail.workspaceId)}
            data-testid="run-workspace-link"
          >
            <Hammer size={11} aria-hidden /> in {workspaceName ?? detail.workspaceId}
          </button>
        ) : null}
      </div>

      {detail.trace.length === 0 ? (
        <p className="ws-empty-steps">{live ? "Waiting for the box to pick this up…" : "No tool calls."}</p>
      ) : (
        <ol className="ws-steps" aria-label="Tool calls">
          {detail.trace.map((e, i) => (
            <Step key={`${e.tool_call_id}-${i}`} entry={e} />
          ))}
        </ol>
      )}

      {parked && detail.pending && (
        <div className="ws-decision" role="group" aria-labelledby="agent-run-approval-heading">
          <div className="ws-decision-h">
            <ShieldAlert size={16} aria-hidden />
            <span id="agent-run-approval-heading">This run is waiting for your OK</span>
          </div>
          <p>
            It wants to run <code className="ws-mono">{detail.pending.tool}</code>
            {detail.pending.parkedAt ? ` — parked ${when(detail.pending.parkedAt)}` : ""}. Nothing has been done yet.
          </p>
          {detail.pending.summary.fields.length > 0 && (
            <dl className="ws-facts">
              {detail.pending.summary.fields.map((f) => (
                <div key={f.key} className="contents">
                  <dt>{f.key}</dt>
                  <dd>{f.detail}</dd>
                </div>
              ))}
              {detail.pending.summary.truncatedFields > 0 && (
                <div className="contents">
                  <dt>…</dt>
                  <dd>+{detail.pending.summary.truncatedFields} more</dd>
                </div>
              )}
            </dl>
          )}
          <div className="ws-decision-acts">
            <button type="button" className="btn primary" disabled={busy} onClick={onApprove}>
              <ShieldCheck size={14} aria-hidden /> Approve and continue
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onDecline}>
              <ShieldX size={14} aria-hidden /> Decline
            </button>
          </div>
        </div>
      )}

      {detail.result && (
        <div className="ws-result">
          <div className="msg">
            <span className="msg-ava is-assistant" aria-hidden>
              <Hammer size={14} />
            </span>
            <div className="msg-col">
              <div className="msg-bubble is-assistant" style={{ whiteSpace: "pre-wrap" }}>
                {detail.result}
              </div>
            </div>
          </div>
        </div>
      )}

      {proposed && (
        <p className="ws-empty-steps" data-testid="run-proposed">
          Ended with a proposal — the workspace holds a tagged version for your review.
        </p>
      )}

      {detail.error && (
        <p className="ws-stop" role="status">
          <b>Stopped:</b> {detail.error}
        </p>
      )}

      {live && (
        <div className="ws-empty-steps">
          <button type="button" className="btn sm" disabled={busy} onClick={onCancel}>
            Cancel run
          </button>
        </div>
      )}
    </article>
  );
}
