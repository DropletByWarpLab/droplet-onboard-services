/**
 * WARP-2896 (ADR-056 §6.2) — the eight `workspace_*` tools.
 *
 *   - every one REFUSES outside a workshop run (no `agentRunId` or no
 *     `workspaceId` on the context) before any HTTP call — a chat turn or
 *     an HTTP MCP client never reaches the route;
 *   - every call goes to `/api/workspace/<ctx.workspaceId>/<op>` with the
 *     run id in `X-Droplet-Agent-Run` and `onBehalfOf = ctx.userId`: the
 *     address is the context's, never an argument the model supplies;
 *   - `workspace_run` splits the command line into argv and lets the ROUTE
 *     refuse it (a 400 is relayed with the route's code);
 *   - `workspace_propose` checks the version grammar itself and relays a 409
 *     (same version twice) as CONFLICT;
 *   - the tiers are what the run worker's pool exemption relies on.
 */
import { describe, it, expect, vi } from "vitest";
import workspaceRead from "../../../src/handlers/workspace/workspace-read.js";
import workspaceSearch from "../../../src/handlers/workspace/workspace-search.js";
import workspaceDiff from "../../../src/handlers/workspace/workspace-diff.js";
import workspaceLog from "../../../src/handlers/workspace/workspace-log.js";
import workspaceWrite from "../../../src/handlers/workspace/workspace-write.js";
import workspaceCommit from "../../../src/handlers/workspace/workspace-commit.js";
import workspaceRun from "../../../src/handlers/workspace/workspace-run.js";
import workspacePropose from "../../../src/handlers/workspace/workspace-propose.js";
import type { HttpClient, Tool, ToolContext } from "../../../src/types.js";

const ALL: Array<[Tool, Record<string, unknown>]> = [
  [workspaceRead, { path: "src/index.ts" }],
  [workspaceSearch, { pattern: "run" }],
  [workspaceDiff, {}],
  [workspaceLog, {}],
  [workspaceWrite, { path: "a.txt", content: "x" }],
  [workspaceCommit, { message: "m" }],
  [workspaceRun, { command: "pytest -q" }],
  [workspacePropose, { name: "N", version: "0.1.0", summary: "s" }],
];

function makeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function ctxWith(http: Partial<HttpClient>, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    http: { orchestrator: http as HttpClient },
    userId: "alice",
    agentRunId: "run-1",
    workspaceId: "ws-a",
    ...extra,
  } as unknown as ToolContext;
}

describe("workspace_* tiers (WARP-2896)", () => {
  it("four reads, three ungated writes, one Tier-2 propose", () => {
    for (const t of [workspaceRead, workspaceSearch, workspaceDiff, workspaceLog]) {
      expect(t.requiresWrite, t.name).toBe(false);
      expect(t.requiresConfirmation, t.name).toBe(false);
    }
    for (const t of [workspaceWrite, workspaceCommit, workspaceRun]) {
      expect(t.requiresWrite, t.name).toBe(true);
      expect(t.requiresConfirmation, t.name).toBe(false);
    }
    expect(workspacePropose.requiresWrite).toBe(true);
    expect(workspacePropose.requiresConfirmation).toBe(true);
  });
});

describe("workspace_* refuse outside a workshop run, before any HTTP call", () => {
  // MUTATION: drop the `!ctx.agentRunId || !ctx.workspaceId` check in
  // _shared.ts bind() and every case below dials the orchestrator.
  it.each(ALL)("%s", async (tool, args) => {
    const post = vi.fn();
    const noRun = await tool.handler(args, ctxWith({ post }, { agentRunId: undefined }));
    expect(noRun).toMatchObject({ ok: false, error: { code: "NOT_A_WORKSHOP_RUN" } });
    const noWorkspace = await tool.handler(args, ctxWith({ post }, { workspaceId: undefined }));
    expect(noWorkspace).toMatchObject({ ok: false, error: { code: "NOT_A_WORKSHOP_RUN" } });
    const nobody = await tool.handler(args, ctxWith({ post }, { userId: undefined }));
    expect(nobody).toMatchObject({ ok: false, error: { code: "NO_PRINCIPAL" } });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("workspace_* address the context's workspace and carry the run id", () => {
  it.each(ALL)("%s", async (tool, args) => {
    const post = vi.fn(async (_path: string, _body: unknown, _init?: unknown) =>
      makeResponse(200, {
        // A superset every handler can read its own fields from.
        kind: "file", path: "p", content: "c", bytes: 1, truncated: false,
        hits: [], entries: [], diff: "", base: "HEAD",
        changed: true, commit: "abcdef0123456789", tag: "proposal/0.1.0", manifest: {},
        argv: ["pytest", "-q"], exitCode: 0, timedOut: false, durationMs: 1, stdout: "", stderr: "",
      }),
    );
    // The model's own `workspace`/`workspaceId` argument, if it ever sent
    // one, is not an address: additionalProperties is false, and the path
    // comes from ctx.workspaceId alone.
    const res = await tool.handler({ ...args, workspaceId: "ws-other" }, ctxWith({ post }));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body, init] = post.mock.calls[0] as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(path.startsWith("/api/workspace/ws-a/")).toBe(true);
    expect(path.includes("ws-other")).toBe(false);
    expect(body.onBehalfOf).toBe("alice");
    expect(init.headers["X-Droplet-Agent-Run"]).toBe("run-1");
  });
});

describe("workspace_run", () => {
  it("splits the command line into argv and forwards the timeout in ms", async () => {
    const post = vi.fn(async (_path: string, _body: unknown, _init?: unknown) =>
      makeResponse(200, { argv: ["ruff", "check", "."], exitCode: 1, timedOut: false, durationMs: 5, stdout: "E501", stderr: "", truncated: false }),
    );
    const res = await workspaceRun.handler({ command: "  ruff   check . ", timeout_seconds: 30 }, ctxWith({ post }));
    expect(post.mock.calls[0][0]).toBe("/api/workspace/ws-a/run");
    expect(post.mock.calls[0][1]).toEqual({ argv: ["ruff", "check", "."], timeoutMs: 30_000, onBehalfOf: "alice" });
    expect(res).toMatchObject({ ok: true, data: { passed: false, exitCode: 1, stdout: "E501" } });
  });

  it("relays the route's allow-list refusal with its code — the route decides, not the tool", async () => {
    const post = vi.fn(async () => makeResponse(400, { error: "command not allowed; the workspace can run: npm test, …", code: "COMMAND_NOT_ALLOWED" }));
    const res = await workspaceRun.handler({ command: "bash -c id" }, ctxWith({ post }));
    expect(res).toMatchObject({ ok: false, error: { code: "COMMAND_NOT_ALLOWED" } });
  });

  it("says when the command timed out", async () => {
    const post = vi.fn(async () =>
      makeResponse(200, { argv: ["pytest"], exitCode: null, timedOut: true, durationMs: 1000, stdout: "", stderr: "", truncated: true }),
    );
    const res = await workspaceRun.handler({ command: "pytest" }, ctxWith({ post }));
    expect(res).toMatchObject({ ok: true, data: { timedOut: true, exitCode: null, truncated: true } });
  });
});

describe("workspace_propose", () => {
  it("refuses a non-semver version before dialling", async () => {
    const post = vi.fn();
    for (const version of ["1", "v1.0.0", "latest", ""]) {
      const res = await workspacePropose.handler({ name: "N", version, summary: "s" }, ctxWith({ post }));
      expect(res).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("relays a repeated version as CONFLICT and a park-mismatch 403 as FORBIDDEN", async () => {
    const conflict = vi.fn(async () => makeResponse(409, { error: "proposal/0.1.0 already exists; bump the version" }));
    expect(await workspacePropose.handler({ name: "N", version: "0.1.0", summary: "s" }, ctxWith({ post: conflict })))
      .toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const forbidden = vi.fn(async () => makeResponse(403, { error: "Forbidden: that run does not own this workspace" }));
    expect(await workspacePropose.handler({ name: "N", version: "0.1.0", summary: "s" }, ctxWith({ post: forbidden })))
      .toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("returns the tag and tells the model the run is over", async () => {
    const post = vi.fn(async () => makeResponse(200, { commit: "0123456789abcdef", tag: "proposal/0.2.0", manifest: { egress: "none" } }));
    const res = await workspacePropose.handler({ name: "Word counter", version: "0.2.0", summary: "Counts." }, ctxWith({ post }));
    expect(res).toMatchObject({ ok: true, data: { tag: "proposal/0.2.0", workspace: "ws-a", manifest: { egress: "none" } } });
    expect((res as { data: { message: string } }).data.message).toMatch(/finished/);
  });
});

describe("workspace_write / workspace_commit", () => {
  it("write reports whether anything changed (the idempotency the worker relies on)", async () => {
    const post = vi.fn(async () => makeResponse(200, { path: "a.txt", bytes: 1, changed: false }));
    const res = await workspaceWrite.handler({ path: "a.txt", content: "x" }, ctxWith({ post }));
    expect(res).toMatchObject({ ok: true, data: { changed: false } });
  });

  it("commit with nothing to commit is not an error", async () => {
    const post = vi.fn(async () => makeResponse(200, { commit: "0123456789abcdef", changed: false }));
    const res = await workspaceCommit.handler({ message: "m" }, ctxWith({ post }));
    expect(res).toMatchObject({ ok: true, data: { changed: false, commit: "0123456789ab" } });
  });

  it("an unreachable sandbox is SANDBOX_UNAVAILABLE, not a generic failure", async () => {
    const post = vi.fn(async () => makeResponse(502, { error: "the sandbox could not be reached", code: "UNREACHABLE" }));
    const res = await workspaceCommit.handler({ message: "m" }, ctxWith({ post }));
    expect(res).toMatchObject({ ok: false, error: { code: "SANDBOX_UNAVAILABLE" } });
  });
});
