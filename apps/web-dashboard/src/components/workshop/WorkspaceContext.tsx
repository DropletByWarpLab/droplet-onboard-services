"use client";
/**
 * WARP-2974 (ADR-056 §6.2) — the context pane: what one custom tool's
 * workspace holds right now, read straight from the box's git store through
 * `/api/workspace/:id/{log,diff,output}`. The branch and head, whether the
 * tree is clean, the proposal tag once a run proposed, the uncommitted
 * changes, the last command's verdict and output, the commits, and the
 * clone URL for a person who wants the files on their own machine.
 *
 * Read-only by design (WARP-2896): the write path — edit, commit, run,
 * propose — belongs to the run; a person who wants to edit by hand clones
 * and pushes. No editor, no branch picker, no push button (brief §8).
 */
import { useCallback, useEffect, useState } from "react";
import { Copy, FileDiff, FlaskConical, FolderGit2, GitCommitHorizontal, History, Play, Tag, X } from "lucide-react";
import {
  getWorkspace,
  getWorkspaceDiff,
  getWorkspaceLog,
  getWorkspaceOutput,
  templateLabel,
  WORKSPACE_STATUS_LABELS,
  WorkspaceApiError,
  workspaceCloneUrl,
  type WorkspaceDetail,
  type WorkspaceLastRun,
  type WorkspaceLogEntry,
  type WorkspaceStatus,
} from "./workspaces/api";
import { when } from "./RunTranscript";

const CALM_ERROR = "Something went wrong on the box. Try again in a moment.";
const POLL_MS = 5_000;

export function WorkspaceStatusChip({ status, small }: { status: WorkspaceStatus; small?: boolean }) {
  const kind = status === "proposed" ? "warn" : status === "active" ? "ok" : "muted";
  return (
    <span className={`badge ${kind}${small ? " ws-chip" : ""}`} data-testid="workspace-status">
      <span className="dot" style={{ background: "currentColor" }} aria-hidden />
      {WORKSPACE_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export interface WorkspaceContextProps {
  workspaceId: string;
  /** Re-read while a run is working in this workspace, so the pane follows it. */
  live: boolean;
  /** Rendered inside a drawer (no rail chrome, a close control). */
  drawer?: boolean;
  onClose?: () => void;
  onStartRun?: (workspaceId: string) => void;
  onOpenRun?: (runId: string) => void;
}

export function WorkspaceContext({ workspaceId, live, drawer, onClose, onStartRun, onOpenRun }: WorkspaceContextProps) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [log, setLog] = useState<WorkspaceLogEntry[] | null>(null);
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [output, setOutput] = useState<WorkspaceLastRun | null | undefined>(undefined);
  const [error, setError] = useState<{ message: string; status: number | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await getWorkspace(workspaceId);
      setDetail(d);
      setError(null);
      // The three reads are independent; one failing must not blank the others.
      const [l, df, o] = await Promise.allSettled([
        getWorkspaceLog(workspaceId, 30),
        getWorkspaceDiff(workspaceId),
        getWorkspaceOutput(workspaceId),
      ]);
      setLog(l.status === "fulfilled" ? l.value : []);
      setDiff(df.status === "fulfilled" ? df.value : { diff: "", truncated: false });
      setOutput(o.status === "fulfilled" ? o.value : null);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : String(err),
        status: err instanceof WorkspaceApiError ? err.status : null,
      });
    }
  }, [workspaceId]);

  useEffect(() => {
    setDetail(null);
    setLog(null);
    setDiff(null);
    setOutput(undefined);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [live, load]);

  const copyClone = async () => {
    try {
      await navigator.clipboard.writeText(workspaceCloneUrl(workspaceId));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const git = detail && !("error" in detail.git) ? detail.git : null;
  const activeRun = detail?.runs.find((r) => r.status === "queued" || r.status === "running" || r.status === "awaiting_confirmation");

  return (
    <div className={`ws-ctx${drawer ? " is-drawer" : ""}`} data-testid="workspace-context">
      <div className="ws-ctx-head">
        <FolderGit2 size={15} aria-hidden style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span className="t" title={detail?.name ?? workspaceId}>
          {detail?.name ?? workspaceId}
        </span>
        {detail && <WorkspaceStatusChip status={detail.status} small />}
        {onClose && (
          <button type="button" className="chat-iconbtn" aria-label="Close the workspace pane" onClick={onClose}>
            <X size={15} aria-hidden />
          </button>
        )}
      </div>
      <div className="ws-ctx-body">
        {error ? (
          <p className="ws-note" role="status" title={error.message}>
            {error.status === 404 ? "No workspace with that id." : CALM_ERROR}
          </p>
        ) : !detail ? (
          <p className="ws-note" aria-busy="true">
            Loading…
          </p>
        ) : (
          <>
            <section className="ws-sect" aria-label="Workspace">
              <dl className="ws-facts">
                <dt>Id</dt>
                <dd>
                  <code>{detail.id}</code>
                </dd>
                <dt>From</dt>
                <dd>{templateLabel(detail.template)}</dd>
                <dt>Branch</dt>
                <dd>
                  {git ? (
                    <>
                      <code>{git.branch}</code> at <code>{git.head.slice(0, 12)}</code>
                      {git.dirty ? " · uncommitted changes" : " · clean"}
                    </>
                  ) : (
                    <span title={detail && "error" in detail.git ? detail.git.error : undefined}>The store is not answering.</span>
                  )}
                </dd>
                {detail.proposedTag && (
                  <>
                    <dt>
                      <Tag size={11} aria-hidden style={{ verticalAlign: "-1px" }} /> Proposed
                    </dt>
                    <dd>
                      <code>{detail.proposedTag}</code>
                      {detail.proposedAt ? ` · ${when(detail.proposedAt)}` : ""} — waiting for your review.
                    </dd>
                  </>
                )}
              </dl>
              <div className="flex flex-wrap gap-2 mt-3">
                {detail.status === "active" && !activeRun && onStartRun && (
                  <button type="button" className="btn sm primary" onClick={() => onStartRun(detail.id)}>
                    <Play size={13} aria-hidden /> Start a run here
                  </button>
                )}
                {activeRun && onOpenRun && (
                  <button type="button" className="btn sm" onClick={() => onOpenRun(activeRun.id)}>
                    <Play size={13} aria-hidden /> A run is working here
                  </button>
                )}
              </div>
            </section>

            <section className="ws-sect" aria-labelledby="ws-changes">
              <h3 className="ws-sect-h" id="ws-changes">
                <FileDiff size={12} aria-hidden /> Changes
                {diff?.truncated ? <span className="sx">truncated</span> : null}
              </h3>
              {diff === null ? (
                <p className="ws-note">Loading…</p>
              ) : diff.diff.trim() === "" ? (
                <p className="ws-note">Nothing uncommitted — the tree matches the last commit.</p>
              ) : (
                <pre className="ws-pre" data-testid="workspace-diff">
                  {diff.diff}
                  {diff.truncated ? "\n… (truncated)" : ""}
                </pre>
              )}
            </section>

            <section className="ws-sect" aria-labelledby="ws-output">
              <h3 className="ws-sect-h" id="ws-output">
                <FlaskConical size={12} aria-hidden /> Last command
                {output ? (
                  <span className="sx">{Math.round(output.durationMs / 100) / 10}s</span>
                ) : null}
              </h3>
              {output === undefined ? (
                <p className="ws-note">Loading…</p>
              ) : output === null ? (
                <p className="ws-note">No command has run here yet.</p>
              ) : (
                <>
                  <p className="ws-note" style={{ marginBottom: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <code className="ws-mono" style={{ color: "var(--text)" }}>
                      {output.argv.join(" ")}
                    </code>
                    <span
                      className={`badge ws-chip ${output.timedOut ? "warn" : output.exitCode === 0 ? "ok" : "danger"}`}
                      data-testid="last-run-verdict"
                    >
                      {output.timedOut ? "timed out" : output.exitCode === 0 ? "passed" : `exit ${output.exitCode}`}
                    </span>
                  </p>
                  <pre className="ws-pre" data-testid="last-run-output">
                    {output.stdout}
                    {output.stderr ? `\n--- stderr ---\n${output.stderr}` : ""}
                    {output.truncated ? "\n… (truncated)" : ""}
                  </pre>
                </>
              )}
            </section>

            <section className="ws-sect" aria-labelledby="ws-history">
              <h3 className="ws-sect-h" id="ws-history">
                <History size={12} aria-hidden /> History
              </h3>
              {log === null ? (
                <p className="ws-note">Loading…</p>
              ) : log.length === 0 ? (
                <p className="ws-note">No commits yet.</p>
              ) : (
                <ul className="ws-commits" aria-label="Commits">
                  {log.map((e) => (
                    <li key={e.commit} className="ws-commit">
                      <span className="s" title={e.subject}>
                        {e.subject}
                      </span>
                      <span className="m">
                        <GitCommitHorizontal size={11} aria-hidden />
                        <code className="ws-mono">{e.commit.slice(0, 8)}</code>
                        {e.refs.some((r) => r.startsWith("tag: proposal/")) && <span className="badge warn ws-chip">proposal</span>}
                        <span style={{ marginLeft: "auto" }}>{when(e.date)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="ws-sect" aria-labelledby="ws-clone">
              <h3 className="ws-sect-h" id="ws-clone">
                <FolderGit2 size={12} aria-hidden /> Clone
              </h3>
              <div className="ws-clone">
                <code data-testid="clone-url" title={workspaceCloneUrl(detail.id)}>
                  {workspaceCloneUrl(detail.id)}
                </code>
                <button type="button" className="chat-iconbtn" aria-label="Copy the clone URL" onClick={() => void copyClone()}>
                  <Copy size={13} aria-hidden />
                </button>
              </div>
              <p className="ws-note" style={{ marginTop: 4 }} role="status">
                {copied ? "Copied." : "Sign in with any name and your session token as the password."}
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
