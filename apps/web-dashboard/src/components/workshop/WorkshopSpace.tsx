"use client";
/**
 * WARP-2974 (ADR-056) — the Workshop as a space.
 *
 * Three panes, the chat surface's own layout (chat-indigo.css):
 *
 *   rail        the custom tools (workspaces, WARP-2896), the runs — parked
 *               first — and the recurring runs. A drawer under `lg`.
 *   transcript  the selected run read as a conversation (RunTranscript),
 *               with the composer underneath: a goal, a `Work in` chip, Start.
 *   context     the selected custom tool's workspace — branch, changes, last
 *               command, history, clone URL (WorkspaceContext). A drawer
 *               under `xl`.
 *
 * This component owns the state the WARP-2180 panel owned — and keeps its
 * two hard-won rules: (1) a detail response that arrives after the person
 * moved to another run is dropped (`selectedRef`), so a stale run's decision
 * card never lands on the run they are looking at; (2) an action's busy
 * flag and its failure belong to the run it was for (`busyId`), never to
 * whatever run the person moved to (WARP-2878). A live run is re-read every
 * 3 s until it settles; nothing polls otherwise.
 *
 * Deep links: `?run=<id>` opens a run (the `/admin/audit` forward, and the
 * notifier's link); `?workspace=<id>` opens a custom tool and points the
 * composer at it (the old `/workshop/<id>` page forwards here).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Hammer, PanelLeft, PanelRight } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import {
  LIVE_STATUSES,
  cancelAgentRun,
  decideAgentRun,
  deleteAgentRunSchedule,
  getAgentRun,
  listAgentRunSchedules,
  listAgentRuns,
  startAgentRun,
  type AgentRunDetail,
  type AgentRunSchedule,
  type AgentRunSummary,
} from "./agent-runs/api";
import { listWorkspaces, type WorkspaceSummary } from "./workspaces/api";
import { Composer } from "./Composer";
import { NewToolDialog } from "./NewToolDialog";
import { RecurringDialog } from "./RecurringDialog";
import { RunStatusChip, RunTranscript } from "./RunTranscript";
import { WorkshopRail } from "./WorkshopRail";
import { WorkspaceContext, WorkspaceStatusChip } from "./WorkspaceContext";

import "@/components/chat/chat-indigo.css";
import "./workshop.css";

const POLL_MS = 3_000;
const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";

function syncUrl(runId: string | null, workspaceId: string | null) {
  if (typeof window === "undefined") return;
  try {
    const qs = new URLSearchParams();
    if (runId) qs.set("run", runId);
    if (workspaceId) qs.set("workspace", workspaceId);
    const q = qs.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
  } catch {
    /* a browser that refuses history writes still gets the page */
  }
}

export function WorkshopSpace() {
  const searchParams = useSearchParams();
  const deepLinkRunId = searchParams?.get("run") ?? null;
  const deepLinkWorkspace = searchParams?.get("workspace") ?? null;

  // ── Runs ─────────────────────────────────────────────────────────────
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedRunId, setSelectedRunIdState] = useState<string | null>(deepLinkRunId);
  const selectedRef = useRef<string | null>(deepLinkRunId);
  const [detail, setDetail] = useState<AgentRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const genRef = useRef(0);

  // ── Workspaces (custom tools) ─────────────────────────────────────────
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(deepLinkWorkspace);
  // "" = an ordinary run; an id makes the next run a workshop run.
  const [composeWorkspaceId, setComposeWorkspaceId] = useState<string>(deepLinkWorkspace ?? "");

  // ── Schedules ────────────────────────────────────────────────────────
  const [schedules, setSchedules] = useState<AgentRunSchedule[]>([]);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);

  // ── Chrome ───────────────────────────────────────────────────────────
  const [railOpen, setRailOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [newToolOpen, setNewToolOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const newToolTrigger = useRef<HTMLElement | null>(null);
  const recurringTrigger = useRef<HTMLElement | null>(null);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const contextTrigger = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerStatus, setComposerStatus] = useState<{ text: string; title?: string } | null>(null);

  const selectRun = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedRunIdState(id);
  }, []);

  useEffect(() => {
    if (deepLinkRunId && deepLinkRunId !== selectedRef.current) selectRun(deepLinkRunId);
  }, [deepLinkRunId, selectRun]);

  const loadRuns = useCallback(async () => {
    const gen = ++genRef.current;
    try {
      const { items } = await listAgentRuns({ status: statusFilter || undefined, limit: 25 });
      if (gen !== genRef.current) return;
      setRuns(items);
      setRunsError(null);
    } catch (err) {
      if (gen !== genRef.current) return;
      setRunsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === genRef.current) setRunsLoading(false);
    }
  }, [statusFilter]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await getAgentRun(id);
      if (selectedRef.current !== id) return;
      setDetail(d);
      setDetailError(null);
    } catch (err) {
      if (selectedRef.current !== id) return;
      setDetailError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await listWorkspaces());
      setWorkspacesError(null);
    } catch (err) {
      setWorkspacesError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadSchedules = useCallback(async () => {
    try {
      setSchedules(await listAgentRunSchedules());
      setSchedulesError(null);
    } catch (err) {
      setSchedulesError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    setRunsLoading(true);
    void loadRuns();
    return () => {
      genRef.current += 1;
    };
  }, [loadRuns]);

  useEffect(() => {
    void loadWorkspaces();
    void loadSchedules();
  }, [loadWorkspaces, loadSchedules]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setDetail(null);
    setDetailError(null);
    void loadDetail(selectedRunId);
  }, [selectedRunId, loadDetail]);

  // The second data source: a live run is re-read until it settles.
  const live = detail !== null && LIVE_STATUSES.has(detail.status);
  useEffect(() => {
    if (!live || !selectedRunId) return;
    const t = setInterval(() => {
      void loadDetail(selectedRunId);
      void loadRuns();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [live, selectedRunId, loadDetail, loadRuns]);

  // A workshop run's workspace is the context; opening the run opens it and
  // points the composer at it — the next goal continues the same tool.
  useEffect(() => {
    if (detail?.workspaceId) {
      setSelectedWorkspaceId(detail.workspaceId);
      setComposeWorkspaceId(detail.workspaceId);
    }
  }, [detail?.workspaceId]);

  useEffect(() => {
    syncUrl(selectedRunId, selectedWorkspaceId);
  }, [selectedRunId, selectedWorkspaceId]);

  // WARP-2878 — the run id is an ARGUMENT, not a closure capture, and the
  // failure path is guarded the way `loadDetail`'s is: a POST that fails
  // after the person selected another run must not write its error into the
  // transcript they are now reading, nor reload the run they left.
  const act = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
      if (selectedRef.current !== id) return;
      await Promise.all([loadDetail(id), loadRuns()]);
    } catch (err) {
      if (selectedRef.current !== id) return;
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId((cur) => (cur === id ? null : cur));
    }
  };

  const start = async (goal: string): Promise<boolean> => {
    setComposerBusy(true);
    setComposerStatus(null);
    try {
      const { id } = await startAgentRun(goal, composeWorkspaceId ? { workspaceId: composeWorkspaceId } : {});
      selectRun(id);
      setComposerStatus({
        text: composeWorkspaceId
          ? "Queued. It works in that workspace and ends by proposing the result to you."
          : "Queued. It starts on the box in a moment.",
      });
      void loadRuns();
      if (composeWorkspaceId) void loadWorkspaces();
      return true;
    } catch (err) {
      // The goal stays in the field so the person can try again.
      const cause = err instanceof Error ? err.message : String(err);
      setComposerStatus({ text: CALM_ERROR, title: cause });
      return false;
    } finally {
      setComposerBusy(false);
    }
  };

  const openWorkspace = (id: string) => {
    setSelectedWorkspaceId(id);
    setComposeWorkspaceId(id);
    setRailOpen(false);
  };

  const newRun = () => {
    selectRun(null);
    setComposerStatus(null);
    setRailOpen(false);
    composerRef.current?.focus();
  };

  const removeSchedule = async (id: string) => {
    setScheduleBusy(true);
    try {
      await deleteAgentRunSchedule(id);
      await loadSchedules();
    } catch (err) {
      setSchedulesError(err instanceof Error ? err.message : String(err));
    } finally {
      setScheduleBusy(false);
    }
  };

  const selectedWorkspace = workspaces?.find((w) => w.id === selectedWorkspaceId) ?? null;
  const workspaceLive = Boolean(live && detail?.workspaceId && detail.workspaceId === selectedWorkspaceId);

  const rail = (onClose?: () => void) => (
    <WorkshopRail
      workspaces={workspaces}
      workspacesError={workspacesError}
      selectedWorkspaceId={selectedWorkspaceId}
      onSelectWorkspace={openWorkspace}
      onNewTool={(t) => {
        newToolTrigger.current = t;
        setNewToolOpen(true);
      }}
      runs={runs}
      runsLoading={runsLoading}
      runsError={runsError}
      selectedRunId={selectedRunId}
      onSelectRun={(id) => {
        selectRun(id);
        setRailOpen(false);
      }}
      onNewRun={newRun}
      statusFilter={statusFilter}
      onStatusFilter={setStatusFilter}
      schedules={schedules}
      schedulesError={schedulesError}
      scheduleBusy={scheduleBusy}
      onAddSchedule={(t) => {
        recurringTrigger.current = t;
        setRecurringOpen(true);
      }}
      onDeleteSchedule={(id) => void removeSchedule(id)}
      onClose={onClose}
    />
  );

  const context = (drawer: boolean) =>
    selectedWorkspaceId ? (
      <WorkspaceContext
        workspaceId={selectedWorkspaceId}
        live={workspaceLive}
        drawer={drawer}
        onClose={drawer ? () => setContextOpen(false) : undefined}
        onStartRun={(id) => {
          setComposeWorkspaceId(id);
          setContextOpen(false);
          composerRef.current?.focus();
        }}
        onOpenRun={(id) => {
          selectRun(id);
          setContextOpen(false);
        }}
      />
    ) : null;

  return (
    <div className="droplet-shell chat-app workshop-app h-[calc(100dvh_-_56px_-_env(safe-area-inset-bottom))] lg:h-dvh overflow-x-hidden" data-screen-label="Droplet — Workshop">
      <aside className="conv-rail hidden lg:flex" aria-label="Workshop rail">
        {rail()}
      </aside>

      <div className="chat-main">
        <header className="chat-head">
          <button ref={railTrigger} type="button" className="chat-iconbtn ws-rail-toggle" aria-label="Open the workshop rail" onClick={() => setRailOpen(true)}>
            <PanelLeft size={16} aria-hidden />
          </button>
          <div className="chat-head-title" title={detail?.goal ?? "Workshop"}>
            {detail ? detail.goal : "Workshop"}
          </div>
          <div className="ws-head-chips">
            {detail && <RunStatusChip status={detail.status} small />}
            {selectedWorkspace && (
              <button
                type="button"
                className="chat-new ws-head-ws"
                onClick={() => setContextOpen(true)}
                title="Open the workspace pane"
                data-testid="head-workspace"
              >
                <Hammer size={13} aria-hidden />
                <span className="truncate" style={{ maxWidth: 160 }}>
                  {selectedWorkspace.name}
                </span>
                <WorkspaceStatusChip status={selectedWorkspace.status} small />
              </button>
            )}
          </div>
          <span className="pt-spring" style={{ flex: 1 }} />
          {selectedWorkspaceId && (
            <button
              ref={contextTrigger}
              type="button"
              className="chat-iconbtn ws-ctx-toggle"
              aria-label="Open the workspace pane"
              onClick={() => setContextOpen(true)}
            >
              <PanelRight size={16} aria-hidden />
            </button>
          )}
        </header>

        <div className="chat-scroll" aria-live="polite">
          <div className="chat-wrap">
            {!selectedRunId && (
              <div className="chat-empty">
                <span className="ico" aria-hidden>
                  <Hammer size={28} />
                </span>
                {selectedWorkspace && composeWorkspaceId === selectedWorkspace.id ? (
                  <>
                    <div className="h">Tell {selectedWorkspace.name} what to build</div>
                    <div>
                      The run reads, edits and tests inside its own workspace, commits as you, and ends by proposing the tool for your review.
                      Nothing it builds runs on the box until you accept it.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="h">Give your Droplet a goal</div>
                    <div>
                      It works in the background on the box. Reads happen on their own; anything that changes something waits for your OK.
                      {workspaces && workspaces.length === 0 ? " Or create a custom tool and have it built for you." : ""}
                    </div>
                  </>
                )}
              </div>
            )}
            {selectedRunId && detailError && (
              <p role="status" className="ws-note" title={detailError}>
                {CALM_ERROR}
              </p>
            )}
            {selectedRunId && !detail && !detailError && (
              <p className="ws-note" aria-busy="true">
                Loading…
              </p>
            )}
            {detail && (
              <RunTranscript
                detail={detail}
                busy={busyId === detail.id}
                workspaceName={workspaces?.find((w) => w.id === detail.workspaceId)?.name ?? null}
                onApprove={() => void act(detail.id, () => decideAgentRun(detail.id, "approved"))}
                onDecline={() => void act(detail.id, () => decideAgentRun(detail.id, "denied"))}
                onCancel={() => void act(detail.id, () => cancelAgentRun(detail.id))}
                onOpenWorkspace={(id) => {
                  setSelectedWorkspaceId(id);
                  setContextOpen(true);
                }}
              />
            )}
          </div>
        </div>

        <Composer
          ref={composerRef}
          workspaces={workspaces ?? []}
          workspaceId={composeWorkspaceId}
          onWorkspaceId={(id) => {
            setComposeWorkspaceId(id);
            if (id) setSelectedWorkspaceId(id);
          }}
          busy={composerBusy}
          onSubmit={start}
          status={composerStatus}
        />
      </div>

      <aside className="hidden xl:flex" style={{ height: "100%" }} aria-label="Workspace">
        {context(false)}
      </aside>

      <Dialog open={railOpen} onClose={() => setRailOpen(false)} triggerRef={railTrigger} labelledBy="workshop-rail-heading" placement="right" flush>
        <div className="flex flex-col h-full w-full">
          <h2 id="workshop-rail-heading" className="sr-only">
            Workshop rail
          </h2>
          {rail(() => setRailOpen(false))}
        </div>
      </Dialog>

      <Dialog open={contextOpen && !!selectedWorkspaceId} onClose={() => setContextOpen(false)} triggerRef={contextTrigger} labelledBy="workspace-pane-heading" placement="right" flush>
        <div className="flex flex-col h-full w-full">
          <h2 id="workspace-pane-heading" className="sr-only">
            Workspace
          </h2>
          {context(true)}
        </div>
      </Dialog>

      <NewToolDialog
        open={newToolOpen}
        onClose={() => setNewToolOpen(false)}
        triggerRef={newToolTrigger}
        onCreated={(w) => {
          void loadWorkspaces();
          openWorkspace(w.id);
          setComposerStatus({ text: `"${w.name}" is ready. Tell it what to build.` });
          composerRef.current?.focus();
        }}
      />
      <RecurringDialog open={recurringOpen} onClose={() => setRecurringOpen(false)} triggerRef={recurringTrigger} onAdded={() => void loadSchedules()} />
    </div>
  );
}
