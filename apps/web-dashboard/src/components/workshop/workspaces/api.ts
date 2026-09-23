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

/**
 * WARP-2974 — what the box's templates are called to a person (the Workshop
 * design brief §3.5). Keyed by the directory name under
 * `extensions/templates/`; an unknown template shows its raw id.
 */
export const TEMPLATE_LABELS: Record<string, { label: string; blurb: string }> = {
  "typescript-tool": {
    label: "TypeScript MCP server (Node 20)",
    blurb: "Composes tools this box already has and shapes their data.",
  },
  "python-tool": {
    label: "Python MCP server (3.12)",
    blurb: "Composes tools this box already has and shapes their data.",
  },
  // WARP-2899 (ADR-056 slice L) — a connector draft is not an extension: it
  // renders an ADR-046 REST profile, its guide, its egress entry and its
  // ADR-042 rows into the store, and an owner exports it for a Warp Lab PR.
  "rest-profile": {
    label: "Connector draft (REST profile)",
    blurb: "Drafts a vendor profile, its guide and its egress entry for Warp Lab to review. Nothing on this box dials the vendor.",
  },
};

export function templateLabel(id: string | null | undefined): string {
  if (!id) return "an empty workspace";
  return TEMPLATE_LABELS[id]?.label ?? id;
}

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

/**
 * WARP-2899 — what GET /api/workspace/:id says about a connector draft (the
 * orchestrator's `ConnectorDraftSummary`). `readback` is the server's one
 * sentence — "drafts a connector for <vendor>; nothing on this box will dial
 * <host> until Warp Lab ships it" — carried verbatim, never rebuilt here.
 * `problems` is what keeps the draft from being proposed.
 */
export interface WorkspaceConnectorDraft {
  provider: string;
  displayName: string;
  readback: string;
  problems: string[];
}

/** The draft, when the answer is one — not `null`, not the sandbox's refusal. */
export function connectorDraftOf(detail: Pick<WorkspaceDetail, "connectorDraft">): WorkspaceConnectorDraft | null {
  const d = detail.connectorDraft;
  if (!d || "error" in d || typeof d.readback !== "string" || d.readback.trim() === "") return null;
  return { ...d, problems: Array.isArray(d.problems) ? d.problems : [] };
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
  /**
   * WARP-2899 — the connector draft read at the proposal (or `work`): `null`
   * for a workspace that is not one, the sandbox's refusal when it did not
   * answer, and absent from an orchestrator that predates WARP-2899.
   */
  connectorDraft?: WorkspaceConnectorDraft | { error: string; code: string } | null;
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

const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * WARP-2899 — the name a bundle is saved under. The server names it
 * `<id>-<head7>.bundle`; anything else in the header (a path, another
 * workspace's id, a second extension) is ignored for `<id>.bundle`.
 */
export function bundleFilename(disposition: string | null | undefined, id: string): string {
  const safeId = WORKSPACE_ID.test(id) ? id : "workspace";
  const named = /filename="([^"]*)"/.exec(disposition ?? "")?.[1];
  if (named && named.startsWith(`${safeId}-`) && /^-[0-9a-f]{7,40}\.bundle$/.test(named.slice(safeId.length))) return named;
  return `${safeId}.bundle`;
}

/**
 * WARP-2899 — download the workspace as a `git bundle` (the `work` branch and
 * its proposal tags). Owner/admin people only; the route refuses anyone else
 * and writes one audit row per download. The session token rides in a header,
 * so this is an authFetch blob download rather than a plain link. Returns the
 * name the file was saved under.
 */
export async function exportWorkspace(id: string): Promise<string> {
  const res = await authFetch(`/api/workspace/${encodeURIComponent(id)}/export`);
  if (!res?.ok) throw await readError(res, "Couldn't export this workspace");
  const blob = await res.blob();
  const filename = bundleFilename(res.headers.get("Content-Disposition"), id);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return filename;
}

/** The clone URL a person uses from their own machine, through the gateway. */
export function workspaceCloneUrl(id: string): string {
  if (typeof window === "undefined") return `/git/${id}.git`;
  return `${window.location.origin}/git/${id}.git`;
}
