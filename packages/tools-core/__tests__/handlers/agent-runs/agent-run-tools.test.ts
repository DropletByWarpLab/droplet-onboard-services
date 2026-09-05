/**
 * WARP-2180 — `start_agent_run` (Tier-2) and `list_agent_runs` (Tier-1).
 *
 *   - start posts the goal to POST /api/agent-runs attributed to the acting
 *     user (`onBehalfOf = ctx.userId`), and relays the orchestrator's 403 as
 *     a FORBIDDEN tool error — the route, not the tool, decides who may
 *     start a run, so a family member's chat turn cannot launder privilege;
 *   - start REFUSES inside a run (`ctx.agentRunId`): a run may not start a
 *     run, and it never reaches the orchestrator;
 *   - both refuse with no principal;
 *   - list scopes to the acting user, forwards status/limit, and maps a
 *     parked run to what it is waiting on.
 */
import { describe, it, expect, vi } from "vitest";
import startAgentRun from "../../../src/handlers/agent-runs/start-agent-run.js";
import listAgentRuns from "../../../src/handlers/agent-runs/list-agent-runs.js";
import type { HttpClient, ToolContext } from "../../../src/types.js";

function makeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function ctxWith(http: Partial<HttpClient>, extra: Partial<ToolContext> = {}): ToolContext {
  return { http: { orchestrator: http as HttpClient }, userId: "romain", ...extra } as unknown as ToolContext;
}

describe("start_agent_run (WARP-2180)", () => {
  it("is Tier-2", () => {
    expect(startAgentRun.requiresWrite).toBe(true);
    expect(startAgentRun.requiresConfirmation).toBe(true);
  });

  it("posts the goal attributed to the acting user and returns the run id", async () => {
    const post = vi.fn(async (_path: string, _body: unknown, _init?: unknown) =>
      makeResponse(201, { id: "run-1", status: "queued" }),
    );
    const res = await startAgentRun.handler({ goal: "tidy old files", max_iter: 6 }, ctxWith({ post }));
    expect(res.ok).toBe(true);
    expect((res as { data: { runId: string } }).data.runId).toBe("run-1");
    expect(post).toHaveBeenCalledWith(
      "/api/agent-runs",
      { goal: "tidy old files", onBehalfOf: "romain", maxIter: 6 },
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
  });

  it("relays the route's 403 as FORBIDDEN — the route decides who may start a run", async () => {
    const post = vi.fn(async () => makeResponse(403, { error: "Forbidden" }));
    const res = await startAgentRun.handler({ goal: "g" }, ctxWith({ post }, { userId: "kid" }));
    expect(res).toMatchObject({ ok: false, status: "error", error: { code: "FORBIDDEN" } });
  });

  it("refuses inside a run, before any HTTP call — a run may not start a run", async () => {
    const post = vi.fn();
    const res = await startAgentRun.handler({ goal: "spawn more" }, ctxWith({ post }, { agentRunId: "run-9" }));
    expect(res).toMatchObject({ ok: false, error: { code: "AGENT_RUN_RECURSION_REFUSED" } });
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses with no principal and with an empty goal", async () => {
    const post = vi.fn();
    expect(await startAgentRun.handler({ goal: "g" }, ctxWith({ post }, { userId: undefined }))).toMatchObject({
      ok: false,
      error: { code: "NO_PRINCIPAL" },
    });
    expect(await startAgentRun.handler({ goal: "  " }, ctxWith({ post }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS" },
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("list_agent_runs (WARP-2180)", () => {
  it("is Tier-1", () => {
    expect(listAgentRuns.requiresWrite).toBe(false);
    expect(listAgentRuns.requiresConfirmation).toBe(false);
  });

  it("lists the acting user's runs with status and limit, mapping a parked run to what it waits on", async () => {
    // Typed parameters so `mock.calls[0][0]` is a string for tsc, not `[]`.
    const get = vi.fn(async (_path: string, _init?: unknown) =>
      makeResponse(200, {
        items: [
          {
            id: "run-2",
            goal: "sweep clips",
            status: "awaiting_confirmation",
            createdAt: "2026-09-04T03:00:00.000Z",
            endedAt: null,
            iteration: 2,
            maxIter: 10,
            error: null,
            result: null,
            pending: { tool: "delete_clip", parkedAt: "2026-09-04T03:05:00.000Z" },
          },
          {
            id: "run-1",
            goal: "tidy",
            status: "succeeded",
            createdAt: "2026-09-04T02:00:00.000Z",
            endedAt: "2026-09-04T02:10:00.000Z",
            iteration: 3,
            maxIter: 10,
            error: null,
            result: "Done: moved 4 files.",
            pending: null,
          },
        ],
        nextCursor: null,
      }),
    );
    const res = await listAgentRuns.handler({ status: "awaiting_confirmation", limit: 5 }, ctxWith({ get }));
    expect(res.ok).toBe(true);
    const path = get.mock.calls[0]![0] as string;
    expect(path.startsWith("/api/agent-runs?")).toBe(true);
    const qs = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(qs.get("onBehalfOf")).toBe("romain");
    expect(qs.get("status")).toBe("awaiting_confirmation");
    expect(qs.get("limit")).toBe("5");
    const data = (res as { data: { runs: Array<Record<string, unknown>>; count: number } }).data;
    expect(data.count).toBe(2);
    expect(data.runs[0]).toMatchObject({ id: "run-2", steps: "2/10", needsApproval: { tool: "delete_clip" } });
    expect(data.runs[1]).toMatchObject({ id: "run-1", resultPreview: "Done: moved 4 files." });
  });

  it("refuses with no principal", async () => {
    const get = vi.fn();
    expect(await listAgentRuns.handler({}, ctxWith({ get }, { userId: undefined }))).toMatchObject({
      ok: false,
      error: { code: "NO_PRINCIPAL" },
    });
    expect(get).not.toHaveBeenCalled();
  });
});
