"use client";
/**
 * WARP-3303 — a background run started from chat, shown where it started.
 *
 * `RunCard` replaces the plain tool chip for a `start_agent_run` call that
 * produced a run. Its state ALWAYS comes from the run itself (GET on mount,
 * then the `droplet/agent-runs/<user>` frames), never from the persisted tool
 * result — that result is a snapshot of the moment the run was queued, so a
 * reload an hour later would otherwise show "Queued" forever.
 *
 * A parked run asks for its approval here, in the chat that started it. The
 * decision goes to the run's own confirm route; unlike a chat approval no
 * "go ahead" turn is sent, because the run resumes by itself.
 *
 * `RunResultCard` renders the `agent_run_result` message the worker posts
 * into the thread when the run ends (WARP-3300).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileText, Loader2, ShieldAlert, ShieldCheck, ShieldX, Square } from "lucide-react";
import {
  cancelAgentRun,
  decideAgentRun,
  getAgentRun,
  LIVE_STATUSES,
  type AgentRunArtifact,
  type AgentRunDetail,
  type AgentRunStatus,
} from "@/components/workshop/agent-runs/api";
import { RunStatusChip, Step } from "@/components/workshop/RunTranscript";
import { subscribeAgentRunEvents } from "@/lib/agent-run-events";
import type { ChatToolCall } from "@/lib/types";
import "@/components/workshop/workshop.css";

/** The run id a `start_agent_run` result carries, or null (refused, pending, other tool). */
export function runIdOf(call: ChatToolCall): string | null {
  if (call.name !== "start_agent_run" || call.ok !== true) return null;
  const d = call.data as { runId?: unknown; data?: { runId?: unknown } } | null | undefined;
  const id = d?.runId ?? d?.data?.runId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** `search_content` → "search content". */
export function plainTool(name: string | null | undefined): string {
  return (name ?? "").replace(/_/g, " ").trim();
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

type Live = Pick<AgentRunDetail, "status" | "iteration" | "maxIter" | "queuePosition" | "waitingFor"> & {
  lastTool?: string | null;
};

/** The one line under the title: honest about queues and the shared model. */
export function progressLine(run: Live): string {
  if (run.status === "queued") {
    if (run.waitingFor === "chat") return "Waiting for chat";
    return typeof run.queuePosition === "number" && run.queuePosition > 0
      ? `Queued, ${ordinal(run.queuePosition)}`
      : "Queued";
  }
  if (run.status === "running") {
    const step = `Step ${Math.max(1, run.iteration)} of ${run.maxIter}`;
    return run.lastTool ? `${step} · ${plainTool(run.lastTool)}` : step;
  }
  if (run.status === "awaiting_confirmation") return "Waiting for your OK";
  if (run.status === "cancelled") return `Stopped, kept ${run.iteration} step${run.iteration === 1 ? "" : "s"}`;
  if (run.status === "failed") return "Didn't finish";
  return `Finished in ${run.iteration} step${run.iteration === 1 ? "" : "s"}`;
}

export function RunCard({ call }: { call: ChatToolCall }) {
  const runId = runIdOf(call);
  const [run, setRun] = useState<(AgentRunDetail & { lastTool?: string | null }) | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef<string | null>(null);
  statusRef.current = run?.status ?? null;

  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      const detail = await getAgentRun(runId);
      setRun((prev) => ({ ...detail, lastTool: prev?.lastTool ?? detail.trace.at(-1)?.tool ?? null }));
    } catch (err) {
      // 403/404: not this person's run (or a role without the Workshop).
      // The card stays, read-only, rather than vanishing from the thread.
      if (/HTTP 40[34]|forbidden|not.found/i.test(String((err as Error)?.message))) setHidden(true);
      else setError("Couldn't load this task.");
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!runId) return;
    return subscribeAgentRunEvents((evt) => {
      if (evt.runId !== runId) return;
      const statusChanged = statusRef.current !== evt.status;
      setRun((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: evt.status,
          iteration: evt.iteration,
          maxIter: evt.maxIter,
          queuePosition: evt.queuePosition,
          waitingFor: evt.waitingFor,
          lastTool: evt.lastTool ?? prev.lastTool,
          ...(evt.summary ? { summary: evt.summary } : {}),
        };
      });
      // A park or an end brings things a frame does not carry (the pending
      // call's summary, the error, the full trace): read the run again.
      if (statusChanged || evt.status === "awaiting_confirmation" || !LIVE_STATUSES.has(evt.status)) void refresh();
    });
  }, [runId, refresh]);

  if (!runId) return null;
  const title = run?.title || (typeof call.args.title === "string" ? call.args.title : "") || "Background task";

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError((err as Error)?.message || "That didn't go through.");
    } finally {
      setBusy(false);
    }
  };

  const parked = run?.status === "awaiting_confirmation" && run.pending && !run.pending.decision;
  const live = run ? LIVE_STATUSES.has(run.status) : false;

  return (
    <section
      className="mb-2 rounded-lg border border-[var(--card-bd)] bg-[var(--card-inner)] p-3 type-caption-1 text-[var(--text)]"
      aria-label={`Background task: ${title}`}
      data-testid="run-card"
      data-run-id={runId}
      data-status={run?.status ?? "loading"}
    >
      <div className="flex flex-wrap items-center gap-2">
        {run ? <RunStatusChip status={run.status as AgentRunStatus} small /> : <Loader2 size={12} className="animate-spin" aria-hidden />}
        <span className="font-medium">{title}</span>
      </div>

      {hidden ? (
        <p className="mt-1 text-[var(--text-muted)]" data-testid="run-card-hidden">
          This background task isn&apos;t visible to your account.
        </p>
      ) : run ? (
        <p className="mt-1 text-[var(--text-muted)]" role="status" aria-live="polite" data-testid="run-card-progress">
          {progressLine(run)}
        </p>
      ) : null}

      {parked && run?.pending && (
        <div className="ws-decision mt-2" role="group" aria-labelledby={`run-${runId}-ask`}>
          <div className="ws-decision-h">
            <ShieldAlert size={16} aria-hidden />
            <span id={`run-${runId}-ask`}>
              {title} wants to {plainTool(run.pending.tool)}
            </span>
          </div>
          {(run.pending.summary.fields.length > 0 || (run.pending.summary.shown ?? []).length > 0) && (
            <dl className="ws-facts" data-testid="run-card-pending-summary">
              {(run.pending.summary.shown ?? []).map((v) => (
                <div key={`shown-${v.key}`} className="contents">
                  <dt>{v.key}</dt>
                  <dd className="break-words">{v.text}</dd>
                </div>
              ))}
              {run.pending.summary.fields
                .filter((f) => !(run.pending!.summary.shown ?? []).some((v) => v.key === f.key))
                .map((f) => (
                  <div key={f.key} className="contents">
                    <dt>{f.key}</dt>
                    <dd>{f.detail}</dd>
                  </div>
                ))}
            </dl>
          )}
          <div className="ws-decision-acts">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void act(() => decideAgentRun(runId, "approved"))}
              data-testid="run-card-approve"
            >
              <ShieldCheck size={14} aria-hidden /> Approve and continue
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void act(() => decideAgentRun(runId, "denied"))}
              data-testid="run-card-decline"
            >
              <ShieldX size={14} aria-hidden /> Decline
            </button>
          </div>
        </div>
      )}

      {run?.error && !live && <p className="mt-1 text-system-red">{run.error}</p>}
      {error && (
        <p className="mt-1 text-system-red" role="alert">
          {error}
        </p>
      )}

      {!hidden && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Link href={`/workshop?run=${encodeURIComponent(runId)}`} className="text-[var(--brand)] hover:underline font-medium">
            View
          </Link>
          {live && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => cancelAgentRun(runId))}
              className="inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-60"
              data-testid="run-card-stop"
            >
              <Square size={11} aria-hidden /> Stop
            </button>
          )}
        </div>
      )}

      {run && run.trace.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[var(--text-muted)]">Steps ({run.trace.length})</summary>
          <ol className="ws-steps mt-2" aria-label="Steps this task took">
            {run.trace.map((e, i) => (
              <Step key={`${e.tool_call_id}-${i}`} entry={e} />
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

export interface RunResult {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  title: string;
  summary: string;
  artifacts: AgentRunArtifact[];
}

function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

export function RunResultCard({ result }: { result: RunResult }) {
  const heading =
    result.status === "succeeded"
      ? `Background task finished: ${result.title}`
      : result.status === "cancelled"
        ? `Background task stopped: ${result.title}`
        : `Background task didn't finish: ${result.title}`;
  return (
    <section
      className="rounded-lg border border-[var(--card-bd)] bg-[var(--card-inner)] p-3 type-caption-1 text-[var(--text)]"
      aria-label={heading}
      data-testid="run-result-card"
      data-run-id={result.runId}
    >
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusChip status={result.status} small />
        <span className="font-medium">{result.title}</span>
      </div>
      {result.summary && <p className="mt-2 whitespace-pre-wrap">{result.summary}</p>}
      {result.artifacts.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Files this task made">
          {result.artifacts.map((a) => (
            <li key={a.ref}>
              <Link
                href={a.kind === "file" ? `/files?path=${encodeURIComponent(folderOf(a.ref))}` : `/workshop?run=${encodeURIComponent(result.runId)}`}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--inset)] text-[var(--text)] hover:text-[var(--brand)]"
                title={a.ref}
              >
                <FileText size={12} aria-hidden /> {a.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2">
        <Link href={`/workshop?run=${encodeURIComponent(result.runId)}`} className="text-[var(--brand)] hover:underline font-medium">
          View full run
        </Link>
      </div>
    </section>
  );
}
