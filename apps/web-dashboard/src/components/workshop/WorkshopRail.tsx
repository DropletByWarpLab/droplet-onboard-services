"use client";
/**
 * WARP-2974 (ADR-056) — the Workshop's rail: the chat surface's
 * conversation rail (`conv-*`, chat-indigo.css), reused for three groups.
 *
 *   (top)        — `New run` and `New custom tool` as plain rows, always
 *                  first: the Mac app's sidebar shape (DropletAgent spec §5).
 *   Custom tools — one row per workspace (WARP-2896): its name, its
 *                  lifecycle chip, what its last run did. Selecting one
 *                  opens its context pane and points the composer at it.
 *   Runs         — the person's runs, PARKED FIRST regardless of age (a run
 *                  waiting for an OK is the one thing on this page that
 *                  needs a person), then newest first. A filter row for the
 *                  six wire statuses.
 *   Recurring    — the schedules (AgentRunSchedule), with add and delete.
 */
import { Hammer, Plus, Repeat, Trash2, X } from "lucide-react";
import { AGENT_RUN_STATUSES, STATUS_LABELS, describeRrule, type AgentRunSchedule, type AgentRunSummary } from "./agent-runs/api";
import { type WorkspaceSummary } from "./workspaces/api";
import { RunStatusChip, when } from "./RunTranscript";
import { WorkspaceStatusChip } from "./WorkspaceContext";

export interface WorkshopRailProps {
  workspaces: WorkspaceSummary[] | null;
  workspacesError: string | null;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onNewTool: (trigger: HTMLElement | null) => void;

  runs: AgentRunSummary[];
  runsLoading: boolean;
  runsError: string | null;
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  statusFilter: string;
  onStatusFilter: (s: string) => void;

  schedules: AgentRunSchedule[];
  schedulesError: string | null;
  scheduleBusy: boolean;
  onAddSchedule: (trigger: HTMLElement | null) => void;
  onDeleteSchedule: (id: string) => void;

  /** Rendered inside the mobile drawer: shows a close control. */
  onClose?: () => void;
}

const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";

/** Parked rows first, then newest first (brief §4.1). */
export function orderRuns(runs: AgentRunSummary[]): AgentRunSummary[] {
  return [...runs].sort((a, b) => {
    const pa = a.status === "awaiting_confirmation" ? 0 : 1;
    const pb = b.status === "awaiting_confirmation" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export function WorkshopRail(p: WorkshopRailProps) {
  return (
    <>
      <div className="conv-head">
        <span className="conv-head-t">Workshop</span>
        {p.onClose && (
          <button type="button" className="conv-new-btn" aria-label="Close" onClick={p.onClose}>
            <X size={15} aria-hidden />
          </button>
        )}
      </div>

      {/* The Mac app's sidebar opens with its actions as plain rows (New
          chat, Search); the Workshop's are a new run and a new custom tool. */}
      <div className="ws-rail-top">
        <button type="button" onClick={p.onNewRun}>
          <Plus size={15} aria-hidden /> New run
        </button>
        <button type="button" onClick={(e) => p.onNewTool(e.currentTarget)} data-testid="new-tool">
          <Hammer size={15} aria-hidden /> New custom tool
        </button>
      </div>

      <div className="conv-list">
        <div className="conv-group">
          <div className="conv-cap">Custom tools</div>
          {p.workspacesError ? (
            <div className="conv-none" role="status" title={p.workspacesError}>
              {CALM_ERROR}
            </div>
          ) : p.workspaces === null ? (
            <div className="conv-none" aria-busy="true">
              Loading…
            </div>
          ) : p.workspaces.length === 0 ? (
            <div className="conv-none">No custom tools yet. Create one and give it a goal.</div>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-0.5" aria-label="Custom tools">
              {p.workspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    className={`conv-item${p.selectedWorkspaceId === w.id ? " is-active" : ""}`}
                    aria-current={p.selectedWorkspaceId === w.id ? "true" : undefined}
                    onClick={() => p.onSelectWorkspace(w.id)}
                  >
                    <span className="ws-rail-row">
                      <span className="l">
                        <span className="conv-it-t">{w.name}</span>
                        <WorkspaceStatusChip status={w.status} small />
                      </span>
                      <span className="conv-it-s">
                        {w.lastRun
                          ? `Last run: ${STATUS_LABELS[w.lastRun.status as keyof typeof STATUS_LABELS] ?? w.lastRun.status} · ${when(w.lastRun.createdAt)}`
                          : "No run yet"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="conv-group">
          <div className="conv-cap">Runs</div>
          <div className="ws-rail-filter" role="group" aria-label="Filter runs by state">
            <button type="button" className={p.statusFilter === "" ? "active" : undefined} aria-pressed={p.statusFilter === ""} onClick={() => p.onStatusFilter("")}>
              All
            </button>
            {AGENT_RUN_STATUSES.map((s) => (
              <button key={s} type="button" className={p.statusFilter === s ? "active" : undefined} aria-pressed={p.statusFilter === s} onClick={() => p.onStatusFilter(s)}>
                {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
          {p.runsError && (
            <div className="conv-none" role="status" title={p.runsError}>
              {CALM_ERROR}
            </div>
          )}
          {!p.runsError && !p.runsLoading && p.runs.length === 0 && (
            <div className="conv-none">No runs yet. Give your Droplet a goal below and it shows up here.</div>
          )}
          <ul className="m-0 p-0 list-none flex flex-col gap-0.5" aria-label="Runs" aria-busy={p.runsLoading}>
            {orderRuns(p.runs).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`conv-item${p.selectedRunId === r.id ? " is-active" : ""}`}
                  aria-current={p.selectedRunId === r.id ? "true" : undefined}
                  onClick={() => p.onSelectRun(r.id)}
                >
                  <span className="ws-rail-row">
                    <span className="l">
                      <span className="conv-it-t">{r.goal}</span>
                      <RunStatusChip status={r.status} small />
                    </span>
                    <span className="conv-it-s">
                      {when(r.createdAt)} · step {r.iteration}/{r.maxIter}
                      {r.status === "awaiting_confirmation" && r.pending ? ` · ${r.pending.tool}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="conv-group">
          <div className="conv-cap flex items-center">
            Recurring
            <button
              type="button"
              className="ws-rail-act"
              aria-label="Add a recurring run"
              title="Add a recurring run"
              onClick={(e) => p.onAddSchedule(e.currentTarget)}
            >
              <Plus size={13} aria-hidden />
            </button>
          </div>
          {p.schedulesError && (
            <div className="conv-none" role="status" title={p.schedulesError}>
              {CALM_ERROR}
            </div>
          )}
          {!p.schedulesError && p.schedules.length === 0 && <div className="conv-none">Nothing on a schedule.</div>}
          <ul className="m-0 p-0 list-none flex flex-col gap-0.5" aria-label="Recurring runs">
            {p.schedules.map((s) => (
              <li key={s.id} className="conv-item" style={{ cursor: "default" }}>
                <span className="ws-rail-row">
                  <span className="l">
                    <Repeat size={12} aria-hidden style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                    <span className="conv-it-t">{s.goal}</span>
                    {!s.enabled && <span className="badge muted ws-chip">Disabled</span>}
                    <button
                      type="button"
                      className="ws-rail-act"
                      disabled={p.scheduleBusy}
                      aria-label={`Delete recurring run: ${s.goal}`}
                      onClick={() => p.onDeleteSchedule(s.id)}
                    >
                      <Trash2 size={12} aria-hidden />
                    </button>
                  </span>
                  <span className="conv-it-s">
                    {describeRrule(s.rrule)} · {s.timezone} · {s.enabled ? `next ${when(s.nextFireAt)}` : "disabled — see the activity log for why"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
