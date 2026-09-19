/**
 * WARP-2894 (ADR-056 §5.1) — `routine_draft` (Write, no confirm),
 * `routine_list` (Tier-1), `routine_run` (Tier-2).
 *
 *   - draft POSTs the spec to /api/tools attributed to the acting user and
 *     never sends a `status` — the route has no such field and the row is
 *     born `draft`; the route's 400s (unknown tools, invalid spec) and 409
 *     (slug taken) come back as tool errors the model can act on;
 *   - list forwards `status` and maps the route's `{ specs }` envelope;
 *   - run POSTs to /api/tools/:slug/runs as the acting user, relays the
 *     route's "not live" 400, the "confirm on the page" 409 and the
 *     per-step 403, and reports per-step outcome from the trace;
 *   - all three refuse with no principal.
 */
import { describe, it, expect, vi } from "vitest";
import routineDraft from "../../../src/handlers/routines/routine-draft.js";
import routineList from "../../../src/handlers/routines/routine-list.js";
import routineRun from "../../../src/handlers/routines/routine-run.js";
import type { HttpClient, ToolContext } from "../../../src/types.js";

function makeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function ctxWith(http: Partial<HttpClient>, extra: Partial<ToolContext> = {}): ToolContext {
  return { http: { orchestrator: http as HttpClient }, userId: "romain", ...extra } as unknown as ToolContext;
}

const steps = [
  { tool: "list_recent_files", args: { limit: 5 }, as: "recent" },
  { kind: "summarize", prompt: "What changed today?" },
];

describe("routine_draft (WARP-2894)", () => {
  it("is Write-tier with NO confirmation — a draft is inert", () => {
    expect(routineDraft.requiresWrite).toBe(true);
    expect(routineDraft.requiresConfirmation).toBe(false);
  });

  it("posts the spec attributed to the acting user, without a status, and reports the draft", async () => {
    const post = vi.fn(async () =>
      makeResponse(201, { slug: "daily-files", status: "draft", writes: false, steps: [{}, {}] }),
    );
    const res = await routineDraft.handler(
      { slug: "daily-files", name: "Daily files", description: "  what changed  ", steps },
      ctxWith({ post }),
    );
    expect(res.ok).toBe(true);
    expect((res as { data: { slug: string; status: string; steps: number } }).data).toMatchObject({
      slug: "daily-files",
      status: "draft",
      steps: 2,
    });
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/api/tools");
    expect(body).toEqual({
      onBehalfOf: "romain",
      slug: "daily-files",
      name: "Daily files",
      description: "what changed",
      steps,
    });
    // MUTATION: add `status: "live"` to the body and this goes red. The
    // route would ignore it (no such field) — this pins that the tool does
    // not even try.
    expect(Object.keys(body)).not.toContain("status");
  });

  it("relays the route's unknown-tools 400 with the names, so the model can fix the draft", async () => {
    const post = vi.fn(async () =>
      makeResponse(400, { error: "unknown_tools", detail: "these steps name tools this box does not have", tools: ["list_reciept"] }),
    );
    const res = await routineDraft.handler({ slug: "x", name: "X", steps: [{ tool: "list_reciept" }] }, ctxWith({ post }));
    expect(res).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOLS", details: { tools: ["list_reciept"] } } });
    expect((res as { error: { message: string } }).error.message).toContain("list_reciept");
  });

  it("relays a slug collision as SLUG_TAKEN and any other 400 as INVALID_ROUTINE", async () => {
    const taken = await routineDraft.handler(
      { slug: "x", name: "X", steps },
      ctxWith({ post: vi.fn(async () => makeResponse(409, { error: "Slug already in use", slug: "x" })) }),
    );
    expect(taken).toMatchObject({ ok: false, error: { code: "SLUG_TAKEN" } });

    const invalid = await routineDraft.handler(
      { slug: "x", name: "X", steps },
      ctxWith({ post: vi.fn(async () => makeResponse(400, { error: "Invalid spec", details: { fieldErrors: {} } })) }),
    );
    expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_ROUTINE", message: "Invalid spec" } });
  });

  it("relays the route's 403 as FORBIDDEN — the route decides who may draft", async () => {
    const res = await routineDraft.handler(
      { slug: "x", name: "X", steps },
      ctxWith({ post: vi.fn(async () => makeResponse(403, { error: "Forbidden" })) }, { userId: "guest" }),
    );
    expect(res).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("refuses with no principal, a missing slug/name, or no steps — before any HTTP call", async () => {
    const post = vi.fn();
    expect(await routineDraft.handler({ slug: "x", name: "X", steps }, ctxWith({ post }, { userId: undefined }))).toMatchObject({
      ok: false,
      error: { code: "NO_PRINCIPAL" },
    });
    expect(await routineDraft.handler({ slug: " ", name: "X", steps }, ctxWith({ post }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS" },
    });
    expect(await routineDraft.handler({ slug: "x", name: "X", steps: [] }, ctxWith({ post }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS" },
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("routine_list (WARP-2894)", () => {
  it("is Tier-1", () => {
    expect(routineList.requiresWrite).toBe(false);
    expect(routineList.requiresConfirmation).toBe(false);
  });

  it("reads the route's { specs } envelope, scoped to the acting user, forwarding status", async () => {
    const get = vi.fn(async () =>
      makeResponse(200, {
        specs: [
          {
            id: "s1",
            slug: "daily-files",
            name: "Daily files",
            category: null,
            description: "What changed today",
            version: 2,
            status: "live",
            writes: false,
            reversible: true,
            updatedAt: "2026-09-19T10:00:00.000Z",
            stepCount: 2,
            runCount: 7,
          },
        ],
      }),
    );
    const res = await routineList.handler({ status: "live" }, ctxWith({ get }));
    expect(res.ok).toBe(true);
    expect((res as { data: { routines: unknown[]; count: number } }).data).toMatchObject({
      count: 1,
      routines: [{ slug: "daily-files", status: "live", writes: false, steps: 2, runs: 7 }],
    });
    const [path] = get.mock.calls[0] as unknown as [string];
    expect(path).toMatch(/^\/api\/tools\?/);
    expect(path).toContain("onBehalfOf=romain");
    expect(path).toContain("status=live");
  });

  it("drops an unknown status filter rather than forwarding it (the route would 400)", async () => {
    const get = vi.fn(async () => makeResponse(200, { specs: [] }));
    await routineList.handler({ status: "archived" }, ctxWith({ get }));
    const [path] = get.mock.calls[0] as unknown as [string];
    expect(path).not.toContain("status=");
  });

  it("relays 403 as FORBIDDEN and refuses with no principal", async () => {
    const forbidden = await routineList.handler({}, ctxWith({ get: vi.fn(async () => makeResponse(403, {})) }));
    expect(forbidden).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const get = vi.fn();
    expect(await routineList.handler({}, ctxWith({ get }, { userId: undefined }))).toMatchObject({
      ok: false,
      error: { code: "NO_PRINCIPAL" },
    });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("routine_run (WARP-2894)", () => {
  it("is Tier-2 — real tool calls, confirmed like any write", () => {
    expect(routineRun.requiresWrite).toBe(true);
    expect(routineRun.requiresConfirmation).toBe(true);
  });

  it("posts to the slug's run route as the acting user and reports per-step outcome", async () => {
    const post = vi.fn(async () =>
      makeResponse(200, {
        runId: "run-1",
        specId: "s1",
        slug: "daily-files",
        status: "ok",
        error: null,
        trace: [
          { idx: 0, tool: "list_recent_files", args: {}, ok: true, result: [] },
          { idx: 1, ok: true, result: "nothing changed" },
        ],
      }),
    );
    const res = await routineRun.handler({ slug: "daily-files" }, ctxWith({ post }));
    expect(res.ok).toBe(true);
    expect((res as { data: Record<string, unknown> }).data).toMatchObject({ runId: "run-1", status: "ok", steps: 2 });
    expect(post).toHaveBeenCalledWith(
      "/api/tools/daily-files/runs",
      { onBehalfOf: "romain" },
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
    // MUTATION: append `?confirm=true` to the path and this goes red. The
    // 409 gate for a destructive, non-reversible routine belongs to the
    // person on the page, never to the tool.
    const [path] = post.mock.calls[0] as unknown as [string];
    expect(path).not.toContain("confirm");
  });

  it("reports a failed run (the route's 207) with the failed steps named", async () => {
    const post = vi.fn(async () =>
      makeResponse(207, {
        runId: "run-2",
        slug: "daily-files",
        status: "failed",
        error: "step 1: send_notification: boom",
        trace: [
          { idx: 0, tool: "list_recent_files", args: {}, ok: true, result: [] },
          { idx: 1, tool: "send_notification", args: {}, ok: false, error: "boom" },
        ],
      }),
    );
    const res = await routineRun.handler({ slug: "daily-files" }, ctxWith({ post }));
    expect(res.ok).toBe(true);
    expect((res as { data: Record<string, unknown> }).data).toMatchObject({
      status: "failed",
      failedSteps: [{ step: 2, tool: "send_notification", error: "boom" }],
    });
  });

  it("relays: not live (400), confirm-on-page (409), forbidden step (403), not found (404)", async () => {
    const notLive = await routineRun.handler(
      { slug: "x" },
      ctxWith({ post: vi.fn(async () => makeResponse(400, { error: "Only live specs can run", status: "draft" })) }),
    );
    expect(notLive).toMatchObject({ ok: false, error: { code: "NOT_LIVE" } });

    const confirm = await routineRun.handler(
      { slug: "x" },
      ctxWith({ post: vi.fn(async () => makeResponse(409, { error: "confirmation_required" })) }),
    );
    expect(confirm).toMatchObject({ ok: false, error: { code: "CONFIRM_ON_PAGE" } });

    const step = await routineRun.handler(
      { slug: "x" },
      ctxWith({
        post: vi.fn(async () =>
          makeResponse(403, { error: "forbidden_tool_for_role", tool: "control_device", axis: "write_tier" }),
        ),
      }),
    );
    expect(step).toMatchObject({ ok: false, error: { code: "FORBIDDEN_STEP" } });
    expect((step as { error: { message: string } }).error.message).toContain("control_device");

    const missing = await routineRun.handler(
      { slug: "x" },
      ctxWith({ post: vi.fn(async () => makeResponse(404, { error: "Spec not found" })) }),
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("refuses with no principal or no slug — before any HTTP call", async () => {
    const post = vi.fn();
    expect(await routineRun.handler({ slug: "x" }, ctxWith({ post }, { userId: undefined }))).toMatchObject({
      ok: false,
      error: { code: "NO_PRINCIPAL" },
    });
    expect(await routineRun.handler({}, ctxWith({ post }))).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(post).not.toHaveBeenCalled();
  });
});
