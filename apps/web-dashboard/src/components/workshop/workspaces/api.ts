/**
 * WARP-2896 (ADR-056 §6.2) — the workshop's workspaces, as the dashboard
 * reads them. Mirrors `apps/orchestrator/src/routes/workspace.ts`.
 *
 * A workspace is one extension being built: a git repository on the box
 * (the sandbox's store) that a workshop run reads, edits, tests and finally
 * PROPOSES. The dashboard creates workspaces, starts runs in them, and reads
 * what the run left behind — history, changes, the last command's output.
 * The write path (write / commit / run / propose) is the run's alone.
 */
import { authFetch } from "@/lib/auth";

export type WorkspaceStatus = "active" | "proposed" | "archived";

export const WORKSPACE_STATUS_LABELS: Record<WorkspaceStatus, string> = {
  active: "In progress",
  proposed: "Proposed",
  archived: "Archived",
};

export interface WorkspaceRunRef {
  id: string;
  status: string;
  createdAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  template: string | null;
  status: WorkspaceStatus;
  proposedTag: string | null;
  proposedAt: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string;
  lastRun: WorkspaceRunRef | null;
}

export interface WorkspaceGit {
  id: string;
  branch: string;
  head: string;
  dirty: boolean;
  tags: string[];
}

export interface WorkspaceDetail {
  id: string;
  name: string;
  template: string | null;
  status: WorkspaceStatus;
  proposedTag: string | null;
  proposedAt: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string;
  /** The sandbox's answer, or its refusal when the store is unreachable. */
  git: WorkspaceGit | { error: string; code: string };
  runs: Array<{
    id: string;
    status: string;
    goal: string;
    stopReason: string | null;
    createdAt: string;
    endedAt: string | null;
  }>;
}

export interface WorkspaceLogEntry {
  commit: string;
  author: string;
  date: string;
  subject: string;
  refs: string[];
}

export interface WorkspaceLastRun {
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  finishedAt: string;
}

/** The route's own message when it sent one, with the HTTP status attached. */
export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkspaceApiError";
  }
}

async function readError(res: Response, fallback: string): Promise<WorkspaceApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new WorkspaceApiError(body?.error ? `${fallback} (${body.error})` : `${fallback} (HTTP ${res.status})`, res.status);
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await authFetch("/api/workspace");
  if (!res?.ok) throw await readError(res, "Couldn't load workspaces");
  const body = (await res.json()) as { workspaces?: WorkspaceSummary[] };
  return body.workspaces ?? [];
}

export async function listWorkspaceTemplates(): Promise<string[]> {
  const res = await authFetch("/api/workspace/templates");
  if (!res?.ok) throw await readError(res, "Couldn't load the templates");
  const body = (await res.json()) as { templates?: string[] };
  return body.templates ?? [];
}

export async function createWorkspace(input: { name: string; template?: string }): Promise<{ id: string; name: string }> {
  const res = await authFetch("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res?.ok) throw await readError(res, "Couldn't create this workspace");
  return (await res.json()) as { id: string; name: string };
}

export async function getWorkspace(id: string): Promise<WorkspaceDetail> {
  const res = await authFetch(`/api/workspace/${encodeURIComponent(id)}`);
  if (!res?.ok) throw await readError(res, "Couldn't load this workspace");
  return (await res.json()) as WorkspaceDetail;
}

export async function getWorkspaceLog(id: string, limit = 20): Promise<WorkspaceLogEntry[]> {
  const res = await authFetch(`/api/workspace/${encodeURIComponent(id)}/log?limit=${limit}`);
  if (!res?.ok) throw await readError(res, "Couldn't load the history");
  const body = (await res.json()) as { entries?: WorkspaceLogEntry[] };
  return body.entries ?? [];
}

export async function getWorkspaceDiff(id: string, base?: string): Promise<{ base: string; diff: string; truncated: boolean }> {
  const qs = base ? `?base=${encodeURIComponent(base)}` : "";
  const res = await authFetch(`/api/workspace/${encodeURIComponent(id)}/diff${qs}`);
  if (!res?.ok) throw await readError(res, "Couldn't load the changes");
  return (await res.json()) as { base: string; diff: string; truncated: boolean };
}

export async function getWorkspaceOutput(id: string): Promise<WorkspaceLastRun | null> {
  const res = await authFetch(`/api/workspace/${encodeURIComponent(id)}/output`);
  if (!res?.ok) throw await readError(res, "Couldn't load the last output");
  const body = (await res.json()) as { lastRun?: WorkspaceLastRun | null };
  return body.lastRun ?? null;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await authFetch(`/api/workspace/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res?.ok) throw await readError(res, "Couldn't delete this workspace");
}

/** The clone URL a person uses from their own machine, through the gateway. */
export function workspaceCloneUrl(id: string): string {
  if (typeof window === "undefined") return `/git/${id}.git`;
  return `${window.location.origin}/git/${id}.git`;
}
