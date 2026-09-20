"use client";

/**
 * WARP-2925 (ADR-056) — Workshop (`/workshop`)
 *
 * Where a person gives the box a goal and follows the background run that
 * pursues it. The run panel (WARP-2180) had lived at the bottom of
 * `/admin/audit`, behind the audit filters, and nothing in the product could
 * START a run — `POST /api/agent-runs` had no dashboard caller; the only
 * starter was the `start_agent_run` tool from chat. ADR-056 made the run the
 * unit of every agentic slice that follows (workshop runs, extensions,
 * toolset drafts all begin as one), so the run got a surface with a door.
 *
 * Deliberately only what has a backend today: start a run, follow it,
 * approve or decline what it parks on, cancel it — and, since WARP-2896,
 * WORKSPACES: one extension being built, as a git repository on the box.
 * A run started "in" a workspace is a workshop run: it carries the
 * workspace tools, edits and tests there, and ends by proposing the result
 * for review. The Workspaces section below lists them and creates new ones
 * from the box's templates; each has its own page at /workshop/<id>.
 *
 * `?run=<id>` opens that run (the deep link `/admin/audit` used to own and
 * now forwards here). `?workspace=<id>` preselects a workspace in the form.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Eye, FolderGit2, Hammer, Pencil, Play, Plus } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { AgentRunsPanel } from "@/components/workshop/AgentRunsPanel";
import { startAgentRun } from "@/components/workshop/agent-runs/api";
import {
  createWorkspace,
  listWorkspaceTemplates,
  listWorkspaces,
  WORKSPACE_STATUS_LABELS,
  type WorkspaceSummary,
} from "@/components/workshop/workspaces/api";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";

const SUB =
  "Give your Droplet a goal and let it work in the background. Reads happen on their own; anything that changes something waits for your approval.";

/** Homeowner-calm failure copy; the raw cause rides in a title attribute. */
const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";

const GOAL_MAX = 4000;

// useSearchParams must be read under a Suspense boundary (Next.js
// app-router) — the /admin/audit pattern: a thin outer component holds the
// boundary, the inner component owns the page logic.
export default function WorkshopPage() {
  return (
    <Suspense fallback={<WorkshopSkeleton />}>
      <WorkshopInner />
    </Suspense>
  );
}

function WorkshopSkeleton() {
  return (
    <ShellPage icon={<Hammer size={15} />} label="Workshop" title="Workshop" sub={SUB}>
      <div className="card" aria-busy="true" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
        Loading…
      </div>
    </ShellPage>
  );
}

function WorkshopInner() {
  const { user, isLoading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const deepLinkRunId = searchParams?.get("run") ?? null;
  const deepLinkWorkspace = searchParams?.get("workspace") ?? "";

  const [goal, setGoal] = useState("");
  // WARP-2896 — "" is an ordinary run; an id makes it a workshop run.
  const [workspaceId, setWorkspaceId] = useState(deepLinkWorkspace);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The run to open in the panel: the deep link on arrival, then whatever the
  // person just started. The panel mirrors this prop after mount (WARP-2925).
  const [openRunId, setOpenRunId] = useState<string | null>(deepLinkRunId);
  useEffect(() => {
    if (deepLinkRunId) setOpenRunId(deepLinkRunId);
  }, [deepLinkRunId]);

  const allowed = !authLoading && isAdminRole(user?.role);

  const reloadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await listWorkspaces());
      setWorkspacesError(null);
    } catch (err) {
      setWorkspacesError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    if (!allowed) return;
    void reloadWorkspaces();
  }, [allowed, reloadWorkspaces]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { id } = await startAgentRun(trimmed, workspaceId ? { workspaceId } : {});
      setGoal("");
      setOpenRunId(id);
      setNotice(
        workspaceId
          ? "Workshop run queued. It works in the workspace and ends by proposing the result to you."
          : "Run queued. It starts on the box in a moment and shows up below.",
      );
      if (workspaceId) void reloadWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Nothing renders before the role is known — the /admin/audit pattern. The
  // form and AgentRunsPanel below are gated on `allowed`, which is false while
  // auth loads; without this return they would mount for any role in that
  // window and the panel's mount effects would hit GET /api/agent-runs and
  // /api/agent-runs/schedules before anyone knows who is asking.
  if (authLoading) return <WorkshopSkeleton />;

  if (!authLoading && !allowed) {
    return (
      <ShellPage icon={<Hammer size={15} />} label="Workshop" title="Workshop" sub={SUB}>
        <div className="card" role="status">
          <p style={{ margin: 0, fontSize: 13 }}>
            Workshop is for the box&apos;s owner and admins. Ask them if you need a run started.
          </p>
        </div>
      </ShellPage>
    );
  }

  return (
    <ShellPage icon={<Hammer size={15} />} label="Workshop" title="Workshop" sub={SUB}>
      <section className="card" aria-labelledby="start-run-heading" style={{ marginBottom: 16 }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Play size={15} aria-hidden />
          <h2 id="start-run-heading" className="text-[14px] font-semibold m-0">
            Start a run
          </h2>
          <span className="ml-auto flex flex-wrap gap-1.5">
            <span className="badge ok">
              <Eye size={10} aria-hidden />
              Read · stays on LAN
            </span>
            <span className="badge warn">
              <Pencil size={10} aria-hidden />
              Write · confirm to apply
            </span>
          </span>
        </div>
        <form onSubmit={(e) => void submit(e)} aria-label="Start a run" className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[12px]">
            What should your Droplet do?
            <textarea
              required
              rows={3}
              maxLength={GOAL_MAX}
              value={goal}
              disabled={busy || authLoading}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. go through last week's scans and draft a booking for each one that has no appointment"
              className="rounded px-2 py-1 text-[13px]"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            Work in
            <select
              value={workspaceId}
              disabled={busy || authLoading}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="rounded px-2 py-1 text-[13px]"
              data-testid="workspace-select"
            >
              <option value="">No workspace — an ordinary run</option>
              {(workspaces ?? [])
                .filter((w) => w.status === "active")
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.id})
                  </option>
                ))}
            </select>
          </label>
          <p className="text-[12px] m-0" style={{ color: "var(--text-muted)" }}>
            {workspaceId
              ? "A workshop run: it reads, edits and tests inside that workspace only, commits as you, and ends by proposing the extension for your review. Nothing it builds runs on the box until you accept it."
              : "The run uses the box's own model and stays on your network. It reads what it needs on its own; the moment it wants to change something it parks and asks you first. It stops when it is done or out of steps, and you can cancel it at any time."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn primary" disabled={busy || authLoading || !goal.trim()}>
              <Play size={14} aria-hidden /> Start run
            </button>
            {notice && (
              <span role="status" className="text-[13px]">
                {notice}
              </span>
            )}
            {error && (
              <span role="status" className="text-[13px]" title={error}>
                {CALM_ERROR}
              </span>
            )}
          </div>
        </form>
      </section>

      <WorkspacesSection
        workspaces={workspaces}
        error={workspacesError}
        onCreated={(id) => {
          setWorkspaceId(id);
          void reloadWorkspaces();
        }}
      />

      <AgentRunsPanel initialRunId={openRunId} />
    </ShellPage>
  );
}

// ── Workspaces (WARP-2896) ─────────────────────────────────────────────────

function WorkspacesSection({
  workspaces,
  error,
  onCreated,
}: {
  workspaces: WorkspaceSummary[] | null;
  error: string | null;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [templates, setTemplates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    listWorkspaceTemplates()
      .then((t) => {
        setTemplates(t);
        setTemplate((cur) => cur || t[0] || "");
      })
      .catch(() => setTemplates([]));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setCreateError(null);
    setNotice(null);
    try {
      const created = await createWorkspace({ name: trimmed, ...(template ? { template } : {}) });
      setName("");
      setNotice(`Workspace "${created.name}" is ready. Pick it under "Work in" and start a run.`);
      onCreated(created.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="workspaces-heading" style={{ marginBottom: 16 }}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <FolderGit2 size={15} aria-hidden />
        <h2 id="workspaces-heading" className="text-[14px] font-semibold m-0">
          Workspaces
        </h2>
        <span className="text-[12px] ml-auto" style={{ color: "var(--text-muted)" }}>
          One extension each, kept as a git repository on the box.
        </span>
      </div>

      <form onSubmit={(e) => void create(e)} aria-label="New workspace" className="flex flex-wrap items-end gap-2 mb-3">
        <label className="flex flex-col gap-1 text-[12px]">
          Name
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Word counter"
            className="rounded px-2 py-1 text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          Start from
          <select
            value={template}
            disabled={busy}
            onChange={(e) => setTemplate(e.target.value)}
            className="rounded px-2 py-1 text-[13px]"
            data-testid="template-select"
          >
            <option value="">An empty workspace</option>
            {templates.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn" disabled={busy || !name.trim()}>
          <Plus size={14} aria-hidden /> New workspace
        </button>
        {notice && (
          <span role="status" className="text-[13px]">
            {notice}
          </span>
        )}
        {createError && (
          <span role="status" className="text-[13px]" title={createError}>
            {CALM_ERROR}
          </span>
        )}
      </form>

      {error ? (
        <p className="text-[13px] m-0" role="status" title={error}>
          {CALM_ERROR}
        </p>
      ) : workspaces === null ? (
        <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
          Loading…
        </p>
      ) : workspaces.length === 0 ? (
        <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
          No workspaces yet. Create one above, then start a run in it.
        </p>
      ) : (
        <ul aria-label="Workspaces" className="m-0 p-0 flex flex-col gap-1" style={{ listStyle: "none" }}>
          {workspaces.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-2 text-[13px]">
              <Link href={`/workshop/${encodeURIComponent(w.id)}`} className="font-medium">
                {w.name}
              </Link>
              <code className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                {w.id}
              </code>
              <span className={`badge ${w.status === "proposed" ? "warn" : w.status === "active" ? "ok" : ""}`}>
                {WORKSPACE_STATUS_LABELS[w.status]}
              </span>
              {w.template && (
                <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  from {w.template}
                </span>
              )}
              {w.lastRun && (
                <span className="text-[12px] ml-auto" style={{ color: "var(--text-muted)" }}>
                  last run {w.lastRun.status.replace("_", " ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
