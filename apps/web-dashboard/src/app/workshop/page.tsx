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
 * approve or decline what it parks on, cancel it. The sandbox, the store and
 * the Extensions list arrive with WARP-2895 / 2896 / 2900 and are not
 * sketched here — an empty section that promises them would be a fixture.
 *
 * `?run=<id>` opens that run (the deep link `/admin/audit` used to own and
 * now forwards here).
 */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Eye, Hammer, Pencil, Play } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { AgentRunsPanel } from "@/components/workshop/AgentRunsPanel";
import { startAgentRun } from "@/components/workshop/agent-runs/api";
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

  const [goal, setGoal] = useState("");
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { id } = await startAgentRun(trimmed);
      setGoal("");
      setOpenRunId(id);
      setNotice("Run queued. It starts on the box in a moment and shows up below.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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
          <p className="text-[12px] m-0" style={{ color: "var(--text-muted)" }}>
            The run uses the box&apos;s own model and stays on your network. It reads what it needs on its own;
            the moment it wants to change something it parks and asks you first. It stops when it is done or
            out of steps, and you can cancel it at any time.
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

      <AgentRunsPanel initialRunId={openRunId} />
    </ShellPage>
  );
}
