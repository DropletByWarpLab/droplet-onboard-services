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
 * What one of the box's templates is, to a person choosing where a custom
 * tool starts. A `language` template is a tool extension in that language —
 * the main choice, shown side by side with the file the code lives in and
 * the command that tests it (the template's own README). Anything else is a
 * different kind of start and is listed under it.
 */
export interface TemplateInfo {
  label: string;
  /** The runtime the sandbox bakes in for it (`extensions/templates/README.md`). */
  runtime?: string;
  kind: "language" | "other" | "app";
  /** One line on what it is and when to pick it — `other` templates. */
  blurb?: string;
  /** Where the tool's `run(input)` lives, and how its test runs — `language` templates. */
  entry?: string;
  test?: string;
}

/**
 * WARP-2974 — the box's templates as a person meets them. Keyed by the
 * directory name under `extensions/templates/`; an unknown template shows
 * its raw id under the `other` group. The two tool templates are not MCP
 * servers themselves (the sandbox's host shim serves them), so they are
 * named by the language a person would code in.
 */
export const TEMPLATE_INFO: Record<string, TemplateInfo> = {
  "static-site": { label: "Static site", kind: "app", runtime: "Static", blurb: "A built UI or plain HTML. No app process needed." },
  "node-app": { label: "Node app", kind: "app", runtime: "Node 20", blurb: "A web server and UI using Node's built-in libraries." },
  "python-app": { label: "Python app", kind: "app", runtime: "Python 3.12", blurb: "A web server and UI using Python's built-in libraries." },
  "python-tool": {
    label: "Python",
    runtime: "3.12",
    kind: "language",
    entry: "tool.py",
    test: "pytest",
  },
  "typescript-tool": {
    label: "TypeScript",
    runtime: "Node 20",
    kind: "language",
    entry: "src/index.ts",
    test: "npm test",
  },
  // WARP-2899 (ADR-056 slice L) — a connector draft is not an extension: it
  // renders an ADR-046 REST profile, its guide, its egress entry and its
  // ADR-042 rows into the store, and an owner exports it for a Warp Lab PR.
  "rest-profile": {
    label: "Connector draft",
    kind: "other",
    blurb: "For a service with a REST API. Drafts a profile for Warp Lab to review and ship — nothing on this box contacts the service.",
  },
};

export function templateLabel(id: string | null | undefined): string {
  if (!id) return "Blank (no starter files)";
  const info = TEMPLATE_INFO[id];
  if (!info) return id;
  return info.runtime ? `${info.label} (${info.runtime})` : info.label;
}

export interface WorkspaceRunRef {
  id: string;
  status: string;
  createdAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind?: "extension" | "app";
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
  kind?: "extension" | "app";
  template: string | null;
  status: WorkspaceStatus;
  proposedTag: string | null;
  proposedAt: string | null;
  createdAt: string;
  updatedAt: string;
  userId: string;
  app?: { kind: "app"; runtime: "node20" | "python312" | "static";
    http: { health: string; dir?: string; spa?: boolean }; memoryMb: number; egress: string; lines: string[] } | { error: string; code: string } | null;
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

/**
 * The route's own message when it sent one, with the HTTP status attached.
 * `reason` is that message alone, for a refusal a person can act on (a 409).
 */
export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "WorkspaceApiError";
  }
}

async function readError(res: Response, fallback: string): Promise<WorkspaceApiError> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  const reason = typeof body?.error === "string" && body.error.trim() !== "" ? body.error : null;
  return new WorkspaceApiError(reason ? `${fallback} (${reason})` : `${fallback} (HTTP ${res.status})`, res.status, reason);
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

export async function createWorkspace(input: { name: string; template?: string; kind?: "app" }): Promise<{ id: string; name: string }> {
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

export async function importWorkspaceArchive(input: { name: string; archive: File; id?: string }): Promise<{ id: string; name: string }> {
  const body = new FormData();
  body.set("name", input.name);
  body.set("archive", input.archive);
  if (input.id) body.set("id", input.id);
  const res = await authFetch("/api/workspace/import", { method: "POST", body });
  if (!res.ok) throw await readError(res, "Couldn't import this archive");
  return res.json() as Promise<{ id: string; name: string }>;
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

/**
 * The workspace-id grammar. A copy, because the dashboard cannot import
 * orchestrator code: the source of truth is `WORKSPACE_ID` in
 * apps/orchestrator/src/services/workspace.service.ts (the sandbox's
 * services/sandbox/gitstore.py carries the same pattern).
 * `workshop.connector-draft.test.tsx` pins this copy to the orchestrator's,
 * character for character.
 */
export const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * How long an exported bundle's object URL stays alive after the click.
 * `a.click()` returns before the browser has necessarily read the blob URL;
 * Safari (iOS asks before it saves) and Firefox have been known to drop a
 * download whose URL was revoked in that same tick. 40 s is the delay
 * FileSaver.js uses.
 */
export const EXPORT_URL_LIFETIME_MS = 40_000;

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
 * and writes one audit row per download. It is an authFetch blob download
 * rather than a plain link (the session cookie would ride either way) so that
 * an expired access token is refreshed and the call retried, a refusal is
 * reported in place instead of navigating to a JSON error page, and the saved
 * name is checked (`bundleFilename`). Returns the name the file was saved under.
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
    // Later, not now (see EXPORT_URL_LIFETIME_MS); on the throw path too, so the blob never leaks.
    setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_LIFETIME_MS);
  }
  return filename;
}

/** The clone URL a person uses from their own machine, through the gateway. */
export function workspaceCloneUrl(id: string): string {
  if (typeof window === "undefined") return `/git/${id}.git`;
  return `${window.location.origin}/git/${id}.git`;
}
