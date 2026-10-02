/**
 * WARP-2896 (ADR-056 §6.2, slice G) — what the eight `workspace_*` handlers
 * share: the run-binding check and the error shapes.
 *
 * A workspace tool runs INSIDE A WORKSHOP RUN and nowhere else. The worker
 * forwards the run's id and its workspace over `_meta` (stdio-trusted); a
 * handler dispatched without both — a chat turn, an HTTP MCP client —
 * refuses before dialling. The orchestrator route then re-derives the
 * binding from the run id (`X-Droplet-Agent-Run`) and refuses a run that
 * does not own the workspace, so the address here is never the authority.
 *
 * The http call itself lives in EACH handler file, not here: the tool-routes
 * gate (tool-routes.test.ts) reads a tool's hops off the source that
 * registers its name.
 */
import type { ToolContext, ToolResult } from "../../types.js";

export const RUN_HEADER = "X-Droplet-Agent-Run";

export function fail(code: string, message: string, details?: unknown): ToolResult {
  return { ok: false, status: "error", error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export interface Bound {
  workspace: string;
  headers: Record<string, string>;
}

/** The workspace and the headers every call carries, or the refusal. */
export function bind(ctx: ToolContext): Bound | ToolResult {
  if (!ctx.userId) {
    return fail("NO_PRINCIPAL", "This tool needs to know who it acts for, and does not.");
  }
  if (!ctx.agentRunId || !ctx.workspaceId) {
    return fail(
      "NOT_A_WORKSHOP_RUN",
      "Workspace tools work inside a Workshop run only. Start one with a workspace to use them.",
    );
  }
  return {
    workspace: ctx.workspaceId,
    headers: { Accept: "application/json", [RUN_HEADER]: ctx.agentRunId },
  };
}

export function isRefusal(b: Bound | ToolResult): b is ToolResult {
  return "ok" in b;
}

/** The orchestrator's refusals, as the model should read them. */
export async function relayError(res: { status: number; json(): Promise<unknown> }, what: string): Promise<ToolResult> {
  const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
  const detail = body?.error ?? `orchestrator returned ${res.status}`;
  if (res.status === 403) return fail("FORBIDDEN", `This run may not ${what}: ${detail}`);
  if (res.status === 404) return fail("NOT_FOUND", detail);
  if (res.status === 409) return fail("CONFLICT", detail);
  if (res.status === 400) return fail(body?.code ?? "INVALID_ARGS", detail);
  if (res.status === 413) return fail("TOO_LARGE", detail);
  if (res.status === 503 || res.status === 502 || res.status === 504) {
    return fail("SANDBOX_UNAVAILABLE", `The workshop's sandbox is not answering: ${detail}`);
  }
  return fail("WORKSPACE_FAILED", detail);
}
