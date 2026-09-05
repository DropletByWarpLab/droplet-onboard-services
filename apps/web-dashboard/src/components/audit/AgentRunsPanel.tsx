"use client";
/**
 * WARP-2180 — background runs, on the Activity surface.
 *
 * Not a nav item (the nav is under pressure; WARP-1807 moved Knowledge and
 * Context out of it). A list of the person's runs on the left, the selected
 * run on the right: goal, status, step count, the trace, and — when the
 * run is parked on a Tier-2 call — the confirm prompt WITH PROVENANCE: which
 * run asked, what its goal was, the tool and a PHI-free summary of its
 * arguments. A prompt with no provenance is a prompt people click through.
 *
 * ONE component, TWO data sources. A finished run reads its trace once. A
 * live run (queued / running / needs approval) is re-read every few seconds
 * so the trace grows as the worker dispatches; nothing here streams from
 * the loop — the run has no browser attached by definition, and the
 * persisted trace is the progress. Polling stops the moment the run is
 * terminal.
 *
 * Mobile: the grid has one column by default and only gains a second at
 * `md:`; every cell is `min-w-0` so a long goal wraps instead of forcing
 * a horizontal scroll (the WARP-1785..1793 sweep's rule).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ShieldAlert } from "lucide-react";
import {
  AGENT_RUN_STATUSES,
  LIVE_STATUSES,
  STATUS_LABELS,
  cancelAgentRun,
  decideAgentRun,
  getAgentRun,
  listAgentRuns,
  type AgentRunDetail,
  type AgentRunStatus,
  type AgentRunSummary,
  type TraceEntry,
} from "./agent-runs/api";

const POLL_MS = 3_000;
const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";

const BADGE_KIND: Record<AgentRunStatus, string> = {
  queued: "muted",
  running: "info",
  awaiting_confirmation: "warn",
  succeeded: "ok",
  failed: "danger",
  cancelled: "muted",
};

function StatusBadge({ status }: { status: AgentRunStatus }) {
  return (
    <span className={`badge ${BADGE_KIND[status] ?? "muted"}`} data-status={status}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function TraceRow({ entry }: { entry: TraceEntry }) {
  const marker =
    entry.confirmation === "parked"
      ? "parked for approval"
      : entry.confirmation === "confirmed"
        ? "approved and run"
        : entry.confirmation === "denied"
          ? "declined"
          : entry.replayOf
            ? "replayed after resume"
            : entry.text === undefined
              ? "dispatched…"
              : entry.isError
                ? "error"
                : "ok";
  return (
    <li className="py-2 border-b last:border-b-0 min-w-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]">
        <span className="font-medium break-all">{entry.tool}</span>
        <span style={{ color: "var(--text-muted)" }}>step {entry.iteration + 1}</span>
        <span style={{ color: "var(--text-muted)" }}>{marker}</span>
        <span className="ml-auto" style={{ color: "var(--text-muted)" }}>
          {when(entry.completedAt ?? entry.dispatchedAt)}
        </span>
      </div>
      <div className="text-[12px] break-all" style={{ color: "var(--text-muted)" }} title="arguments">
        {compactJson(entry.args)}
      </div>
      {entry.text !== undefined && (
        <details className="text-[12px] mt-1">
          <summary className="cursor-pointer" style={{ color: "var(--text-muted)" }}>
            result
          </summary>
          <pre className="whitespace-pre-wrap break-all mt-1 p-2 rounded" style={{ background: "var(--inset)" }}>
            {clip(entry.text, 4000)}
          </pre>
        </details>
      )}
    </li>
  );
}

export function AgentRunsPanel({ initialRunId }: { initialRunId?: string | null }) {
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId ?? null);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const genRef = useRef(0);

  const loadList = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const { items } = await listAgentRuns({ status: statusFilter || undefined, limit: 25 });
      if (gen !== genRef.current) return;
      setRuns(items);
      setListError(null);
    } catch (err) {
      if (gen !== genRef.current) return;
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [statusFilter]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await getAgentRun(id);
      setDetail((prev) => (prev?.id === id || prev === null || prev.id !== id ? d : prev));
      setDetailError(null);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void loadList();
    return () => {
      genRef.current += 1;
    };
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetail(null);
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // The second data source: a live run is re-read until it settles.
  const live = detail !== null && LIVE_STATUSES.has(detail.status);
  useEffect(() => {
    if (!live || !selectedId) return;
    const t = setInterval(() => {
      void loadDetail(selectedId);
      void loadList();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [live, selectedId, loadDetail, loadList]);

  const act = async (fn: () => Promise<void>) => {
    if (!selectedId) return;
    setBusy(true);
    try {
      await fn();
      await Promise.all([loadDetail(selectedId), loadList()]);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const parked = detail?.status === "awaiting_confirmation" && detail.pending && !detail.pending.decision;

  return (
    <section aria-labelledby="agent-runs-heading" className="card" style={{ marginBottom: 16 }}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Bot size={15} aria-hidden />
        <h2 id="agent-runs-heading" className="text-[14px] font-semibold m-0">
          Background runs
        </h2>
        <div className="pills ml-auto" role="group" aria-label="Filter runs by state">
          <button
            type="button"
            className={statusFilter === "" ? "active" : undefined}
            aria-pressed={statusFilter === ""}
            onClick={() => setStatusFilter("")}
          >
            All
          </button>
          {AGENT_RUN_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={statusFilter === s ? "active" : undefined}
              aria-pressed={statusFilter === s}
              onClick={() => setStatusFilter(s)}
            >
              {STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {listError && (
        // `status`, not `alert`: the audit log below owns the page's alert
        // for its own failure, and a quiet panel must not shout over it.
        <p role="status" className="text-[13px] mb-2" title={listError}>
          {CALM_ERROR}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <ul className="m-0 p-0 list-none min-w-0" aria-label="Background runs" aria-busy={loading}>
          {!loading && runs.length === 0 && (
            <li className="text-[13px] py-6 text-center" style={{ color: "var(--text-muted)" }}>
              No background runs yet. Ask in chat to do something &ldquo;in the background&rdquo;.
            </li>
          )}
          {runs.map((r) => (
            <li key={r.id} className="min-w-0">
              <button
                type="button"
                onClick={() => setSelectedId(r.id)}
                aria-current={selectedId === r.id ? "true" : undefined}
                className="w-full text-left py-2 px-2 rounded flex flex-col gap-1 min-w-0"
                style={{
                  background: selectedId === r.id ? "var(--inset)" : "transparent",
                }}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate text-[13px] font-medium flex-1 min-w-0">{r.goal}</span>
                  <StatusBadge status={r.status} />
                </span>
                <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {when(r.createdAt)} · step {r.iteration}/{r.maxIter}
                  {r.status === "awaiting_confirmation" && r.pending ? ` · waiting on ${r.pending.tool}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-w-0" aria-live="polite">
          {!selectedId && (
            <p className="text-[13px] py-6 text-center" style={{ color: "var(--text-muted)" }}>
              Select a run to see what it did.
            </p>
          )}
          {selectedId && detailError && (
            <p role="status" className="text-[13px]" title={detailError}>
              {CALM_ERROR}
            </p>
          )}
          {selectedId && !detail && !detailError && (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }} aria-busy="true">
              Loading…
            </p>
          )}
          {detail && (
            <article className="min-w-0" data-testid="agent-run-detail">
              <header className="flex flex-wrap items-start gap-2 mb-2">
                <h3 className="text-[14px] font-semibold m-0 break-words flex-1 min-w-0">{detail.goal}</h3>
                <StatusBadge status={detail.status} />
              </header>
              <p className="text-[12px] m-0 mb-3" style={{ color: "var(--text-muted)" }}>
                step {detail.iteration}/{detail.maxIter} · started {when(detail.startedAt)}
                {detail.endedAt ? ` · ended ${when(detail.endedAt)}` : ""}
                {detail.attempts > 0 ? ` · resumed ${detail.attempts}×` : ""}
                {live ? " · updating" : ""}
              </p>

              {parked && detail.pending && (
                <div
                  className="rounded p-3 mb-3"
                  role="group"
                  aria-labelledby="agent-run-approval-heading"
                  style={{ border: "1px solid var(--border)", background: "var(--inset)" }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <ShieldAlert size={15} aria-hidden />
                    <strong id="agent-run-approval-heading" className="text-[13px]">
                      This run is waiting for your approval
                    </strong>
                  </div>
                  <p className="text-[13px] m-0 mb-2">
                    The run <q>{clip(detail.goal, 140)}</q> wants to run{" "}
                    <code className="break-all">{detail.pending.tool}</code>
                    {detail.pending.parkedAt ? ` — parked ${when(detail.pending.parkedAt)}` : ""}. Nothing has
                    been done yet.
                  </p>
                  {detail.pending.summary.fields.length > 0 && (
                    <dl className="text-[12px] m-0 mb-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                      {detail.pending.summary.fields.map((f) => (
                        <div key={f.key} className="contents">
                          <dt className="font-medium">{f.key}</dt>
                          <dd className="m-0 break-all">{f.detail}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void act(() => decideAgentRun(detail.id, "approved"))}
                    >
                      Approve and continue
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => void act(() => decideAgentRun(detail.id, "denied"))}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )}

              {detail.result && (
                <div className="mb-3">
                  <h4 className="text-[12px] font-semibold m-0 mb-1" style={{ color: "var(--text-muted)" }}>
                    Result
                  </h4>
                  <p className="text-[13px] m-0 whitespace-pre-wrap break-words">{detail.result}</p>
                </div>
              )}
              {detail.error && (
                <p className="text-[13px] mb-3 break-words" role="status">
                  <strong>Stopped:</strong> {detail.error}
                </p>
              )}

              {LIVE_STATUSES.has(detail.status) && (
                <div className="mb-3">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void act(() => cancelAgentRun(detail.id))}
                  >
                    Cancel run
                  </button>
                </div>
              )}

              <h4 className="text-[12px] font-semibold m-0 mb-1" style={{ color: "var(--text-muted)" }}>
                Trace
              </h4>
              {detail.trace.length === 0 ? (
                <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
                  No tool calls yet.
                </p>
              ) : (
                <ul className="m-0 p-0 list-none" aria-label="Tool calls">
                  {detail.trace.map((e, i) => (
                    <TraceRow key={`${e.tool_call_id}-${i}`} entry={e} />
                  ))}
                </ul>
              )}
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
