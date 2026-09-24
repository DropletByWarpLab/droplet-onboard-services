"use client";

/**
 * WARP-2896 (ADR-056 §6.2) — one workspace (`/workshop/<id>`).
 *
 * What a run left behind, read straight from the box's git store through
 * `/api/workspace/:id/{log,diff,output}`: the commits, the uncommitted
 * changes, the last command's output — and the runs that worked here. A
 * person starts the next run from this page (the workshop form with the
 * workspace preselected), clones the repository from their own machine
 * (`/git/<id>.git`, session credentials), and, once a run has PROPOSED,
 * sees the tag the review surface (WARP-2900, slice I) will pick up.
 *
 * Read-only by design: the write path (edit, commit, run, propose) belongs
 * to the run, and a person who wants to edit by hand clones and pushes.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FolderGit2, GitCommitHorizontal, Hammer, Play, Terminal } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import {
  getWorkspace,
  getWorkspaceDiff,
  getWorkspaceLog,
  getWorkspaceOutput,
  WORKSPACE_STATUS_LABELS,
  WorkspaceApiError,
  workspaceCloneUrl,
  type WorkspaceDetail,
  type WorkspaceLastRun,
  type WorkspaceLogEntry,
} from "@/components/workshop/workspaces/api";
import { useAuth } from "@/lib/auth";
import { isAdminRole } from "@/lib/access";

const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export default function WorkspacePage() {
  const params = useParams<{ workspaceId: string }>();
  const raw = typeof params?.workspaceId === "string" ? params.workspaceId : "";
  const id = ID.test(raw) ? raw : null;
  const { user, isLoading: authLoading } = useAuth();
  const allowed = !authLoading && isAdminRole(user?.role);

  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [log, setLog] = useState<WorkspaceLogEntry[] | null>(null);
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [output, setOutput] = useState<WorkspaceLastRun | null | undefined>(undefined);
  const [error, setError] = useState<{ message: string; status: number | null } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await getWorkspace(id);
      setDetail(d);
      setError(null);
      // The three reads are independent; one failing must not blank the others.
      const [l, df, o] = await Promise.allSettled([getWorkspaceLog(id, 30), getWorkspaceDiff(id), getWorkspaceOutput(id)]);
      setLog(l.status === "fulfilled" ? l.value : []);
      setDiff(df.status === "fulfilled" ? df.value : { diff: "", truncated: false });
      setOutput(o.status === "fulfilled" ? o.value : null);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof WorkspaceApiError ? err.status : null,
      });
    }
  }, [id]);

  useEffect(() => {
    if (!allowed || !id) return;
    void load();
  }, [allowed, id, load]);

  const title = detail?.name ?? (id ?? "Workspace");
  const shell = (children: React.ReactNode) => (
    <ShellPage icon={<Hammer size={15} />} label="Workshop" title={title} sub="One extension, kept as a git repository on the box.">
      <p className="text-[13px] mb-3">
        <Link href="/workshop" className="inline-flex items-center gap-1">
          <ArrowLeft size={13} aria-hidden /> Back to the Workshop
        </Link>
      </p>
      {children}
    </ShellPage>
  );

  if (authLoading) {
    return shell(
      <div className="card" aria-busy="true" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
        Loading…
      </div>,
    );
  }
  if (!allowed) {
    return shell(
      <div className="card" role="status">
        <p className="m-0 text-[13px]">Workshop is for the box&apos;s owner and admins.</p>
      </div>,
    );
  }
  if (!id) {
    return shell(
      <div className="card" role="status">
        <p className="m-0 text-[13px]">That is not a workspace id.</p>
      </div>,
    );
  }
  if (error) {
    return shell(
      <div className="card" role="status" title={error.message}>
        <p className="m-0 text-[13px]">{error.status === 404 ? "No workspace with that id." : CALM_ERROR}</p>
      </div>,
    );
  }
  if (!detail) {
    return shell(
      <div className="card" aria-busy="true" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
        Loading…
      </div>,
    );
  }

  const git = "error" in detail.git ? null : detail.git;
  const activeRun = detail.runs.find((r) => r.status === "queued" || r.status === "running" || r.status === "awaiting_confirmation");

  return shell(
    <>
      <section className="card" aria-labelledby="ws-summary" style={{ marginBottom: 16 }}>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <FolderGit2 size={15} aria-hidden />
          <h2 id="ws-summary" className="text-[14px] font-semibold m-0">
            {detail.name}
          </h2>
          <code className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            {detail.id}
          </code>
          <span className={`badge ${detail.status === "proposed" ? "warn" : detail.status === "active" ? "ok" : ""}`} data-testid="workspace-status">
            {WORKSPACE_STATUS_LABELS[detail.status]}
          </span>
          {detail.template && (
            <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              from {detail.template}
            </span>
          )}
        </div>
        <dl className="grid gap-x-4 gap-y-1 text-[13px] m-0" style={{ gridTemplateColumns: "max-content 1fr" }}>
          <dt style={{ color: "var(--text-muted)" }}>Branch</dt>
          <dd className="m-0">
            {git ? (
              <>
                <code>{git.branch}</code> at <code>{git.head.slice(0, 12)}</code>
                {git.dirty ? " · uncommitted changes" : " · clean"}
              </>
            ) : (
              <span title={"error" in detail.git ? detail.git.error : undefined}>The store is not answering.</span>
            )}
          </dd>
          {detail.proposedTag && (
            <>
              <dt style={{ color: "var(--text-muted)" }}>Proposed</dt>
              <dd className="m-0">
                <code>{detail.proposedTag}</code>
                {detail.proposedAt ? ` · ${new Date(detail.proposedAt).toLocaleString()}` : ""} — waiting for your review.
              </dd>
            </>
          )}
          <dt style={{ color: "var(--text-muted)" }}>Clone</dt>
          <dd className="m-0">
            <code data-testid="clone-url">{workspaceCloneUrl(detail.id)}</code>
            <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {" "}
              — sign in with any name and your session token as the password.
            </span>
          </dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {detail.status === "active" && !activeRun && (
            <Link href={`/workshop?workspace=${encodeURIComponent(detail.id)}`} className="btn primary">
              <Play size={14} aria-hidden /> Start a run here
            </Link>
          )}
          {activeRun && (
            <Link href={`/workshop?run=${encodeURIComponent(activeRun.id)}`} className="btn">
              <Play size={14} aria-hidden /> A run is working here — open it
            </Link>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="ws-runs" style={{ marginBottom: 16 }}>
        <h2 id="ws-runs" className="text-[14px] font-semibold m-0 mb-2">
          Runs
        </h2>
        {detail.runs.length === 0 ? (
          <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
            No run has worked here yet.
          </p>
        ) : (
          <ul aria-label="Runs in this workspace" className="m-0 p-0 flex flex-col gap-1" style={{ listStyle: "none" }}>
            {detail.runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                <Link href={`/workshop?run=${encodeURIComponent(r.id)}`}>{r.goal.length > 90 ? `${r.goal.slice(0, 87)}…` : r.goal}</Link>
                <span className="badge">{r.stopReason === "proposed" ? "proposed" : r.status.replace("_", " ")}</span>
                <span className="text-[12px] ml-auto" style={{ color: "var(--text-muted)" }}>
                  {new Date(r.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="ws-history" style={{ marginBottom: 16 }}>
        <div className="flex items-center gap-2 mb-2">
          <GitCommitHorizontal size={15} aria-hidden />
          <h2 id="ws-history" className="text-[14px] font-semibold m-0">
            History
          </h2>
        </div>
        {log === null ? (
          <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
            Loading…
          </p>
        ) : log.length === 0 ? (
          <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
            No commits yet.
          </p>
        ) : (
          <ul aria-label="Commits" className="m-0 p-0 flex flex-col gap-1" style={{ listStyle: "none" }}>
            {log.map((e) => (
              <li key={e.commit} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                <code className="text-[12px]">{e.commit.slice(0, 8)}</code>
                <span>{e.subject}</span>
                {e.refs.some((r) => r.startsWith("tag: proposal/")) && <span className="badge warn">proposal</span>}
                <span className="text-[12px] ml-auto" style={{ color: "var(--text-muted)" }}>
                  {e.author} · {new Date(e.date).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="ws-changes" style={{ marginBottom: 16 }}>
        <h2 id="ws-changes" className="text-[14px] font-semibold m-0 mb-2">
          Uncommitted changes
        </h2>
        {diff === null ? (
          <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
            Loading…
          </p>
        ) : diff.diff.trim() === "" ? (
          <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
            Nothing uncommitted — the working tree matches the last commit.
          </p>
        ) : (
          <pre data-testid="workspace-diff" className="text-[12px] m-0 overflow-auto" style={{ maxHeight: 480 }}>
            {diff.diff}
            {diff.truncated ? "\n… (truncated)" : ""}
          </pre>
        )}
      </section>

      <section className="card" aria-labelledby="ws-output">
        <div className="flex items-center gap-2 mb-2">
          <Terminal size={15} aria-hidden />
          <h2 id="ws-output" className="text-[14px] font-semibold m-0">
            Last command
          </h2>
        </div>
        {output === undefined ? (
          <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
            Loading…
          </p>
        ) : output === null ? (
          <p className="text-[13px] m-0" style={{ color: "var(--text-muted)" }}>
            No command has run here yet.
          </p>
        ) : (
          <>
            <p className="text-[13px] m-0 mb-2">
              <code>{output.argv.join(" ")}</code>{" "}
              <span className={`badge ${output.timedOut ? "warn" : output.exitCode === 0 ? "ok" : "warn"}`} data-testid="last-run-verdict">
                {output.timedOut ? "timed out" : output.exitCode === 0 ? "passed" : `exit ${output.exitCode}`}
              </span>{" "}
              <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                {Math.round(output.durationMs / 100) / 10}s · {new Date(output.finishedAt).toLocaleString()}
              </span>
            </p>
            <pre data-testid="last-run-output" className="text-[12px] m-0 overflow-auto" style={{ maxHeight: 480 }}>
              {output.stdout}
              {output.stderr ? `\n--- stderr ---\n${output.stderr}` : ""}
              {output.truncated ? "\n… (truncated)" : ""}
            </pre>
          </>
        )}
      </section>
    </>,
  );
}
