/**
 * WARP-1996 — the `summarize` step kind.
 *
 * Before this, a ToolSpec could only CALL tools. There was no way to turn
 * what a spec gathered into prose, which is the whole shape of a daily
 * report — so "the report is a tool-spec run" was a plan the runner could
 * not actually execute. This suite pins the second kind.
 *
 * The two properties that matter:
 *
 *   1. A summarize step reads ONLY the trace the run already produced. It
 *      dispatches no tool, so it cannot widen the run's §3 reach — the facts
 *      it sees were all gathered under the existing scope check.
 *   2. It FAILS rather than skips when it can't run. A report that quietly
 *      dropped its narrative renders as a report with nothing to say, which
 *      is indistinguishable from a quiet day.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

// WARP-3409 — the incident replay drives the real summarizer; only the
// gateway round-trip is scripted.
const completeOnceMock = vi.hoisted(() => vi.fn());
vi.mock("../services/llm-complete.service.js", () => ({
  completeOnce: completeOnceMock,
}));

import {
  DEFAULT_SUMMARY_PROMPT,
  SUMMARIZE_PSEUDO_TOOL,
  plannedToolNames,
  runToolSpec,
  type RunStepTrace,
  type StepDispatcher,
  type Summarizer,
} from "../services/tool-spec-runner.service.js";
import { createToolSpecSummarizer } from "../services/tool-spec-summarizer.service.js";

/** Minimal prisma double — the runner only creates a ToolRun row. */
function fakePrisma() {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    client: {
      toolRun: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "run-1", ...data };
        }),
      },
    } as never,
  };
}

const callStep = (idx: number, tool: string) => ({
  id: `s${idx}`,
  idx,
  kind: "call",
  args: { tool, args: {} },
});

const summarizeStep = (idx: number, prompt?: string) => ({
  id: `s${idx}`,
  idx,
  kind: "summarize",
  args: prompt ? { prompt } : {},
});

function dispatcherReturning(result: unknown): StepDispatcher {
  return { call: vi.fn(async () => result) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("summarize step (WARP-1996)", () => {
  it("turns the gathered facts into prose and stores it as the step's result", async () => {
    const summarizer: Summarizer = {
      summarize: vi.fn(async () => "Nine files landed in Operations this morning."),
    };
    const p = fakePrisma();

    const { outcome } = await runToolSpec(p.client, dispatcherReturning({ count: 9 }), {
      specId: "spec-1",
      specName: "daily-report",
      steps: [callStep(0, "list_recent_files"), summarizeStep(1)],
      triggeredBy: "u1",
      summarizer,
    });

    expect(outcome.status).toBe("ok");
    const last = outcome.trace[outcome.trace.length - 1];
    expect(last.tool).toBe(SUMMARIZE_PSEUDO_TOOL);
    expect(last.ok).toBe(true);
    // The narrative IS the last step's result — no new column, and the run
    // history therefore carries the prose for free.
    expect(last.result).toBe("Nine files landed in Operations this morning.");
  });

  it("passes the EARLIER steps' results as the facts, and nothing else", async () => {
    const seen: RunStepTrace[][] = [];
    const summarizer: Summarizer = {
      summarize: vi.fn(async (_p, facts) => {
        seen.push(facts);
        return "prose";
      }),
    };
    const p = fakePrisma();

    await runToolSpec(p.client, dispatcherReturning({ n: 1 }), {
      specId: "spec-1",
      specName: "daily-report",
      steps: [callStep(0, "get_system_health"), callStep(1, "network_summary"), summarizeStep(2)],
      triggeredBy: null,
      summarizer,
    });

    expect(seen).toHaveLength(1);
    // Exactly the two tool steps that ran before it — the summarizer cannot
    // see anything the run did not already gather under the scope check.
    expect(seen[0].map((t) => t.tool)).toEqual(["get_system_health", "network_summary"]);
  });

  it("hands the summarizer a COPY — it cannot rewrite the run's own record", async () => {
    const summarizer: Summarizer = {
      summarize: vi.fn(async (_p, facts) => {
        facts.length = 0;
        facts.push({ idx: 99, tool: "forged", args: {}, ok: true, result: "fake" });
        return "prose";
      }),
    };
    const p = fakePrisma();

    const { outcome } = await runToolSpec(p.client, dispatcherReturning({ n: 1 }), {
      specId: "spec-1",
      specName: "daily-report",
      steps: [callStep(0, "get_system_health"), summarizeStep(1)],
      triggeredBy: null,
      summarizer,
    });

    expect(outcome.trace.map((t) => t.tool)).toEqual([
      "get_system_health",
      SUMMARIZE_PSEUDO_TOOL,
    ]);
    expect(outcome.trace.some((t) => t.tool === "forged")).toBe(false);
  });

  it("uses the spec's prompt when given one, and the default otherwise", async () => {
    const summarizer: Summarizer = { summarize: vi.fn(async () => "prose") };
    const p = fakePrisma();

    await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [summarizeStep(0, "Focus on the money.")],
      triggeredBy: null,
      summarizer,
    });
    expect(summarizer.summarize).toHaveBeenCalledWith("Focus on the money.", []);

    await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [summarizeStep(1)],
      triggeredBy: null,
      summarizer,
    });
    expect(summarizer.summarize).toHaveBeenLastCalledWith(DEFAULT_SUMMARY_PROMPT, []);
  });

  it("FAILS the run when no summarizer is configured — never silently skips", async () => {
    // A skipped narrative renders as a report with nothing to say, which
    // looks exactly like a quiet day. Failing is the honest outcome.
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [summarizeStep(0)],
      triggeredBy: null,
      // summarizer deliberately omitted
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/no summarizer configured/);
    expect(outcome.trace[0].ok).toBe(false);
  });

  it("records a summarizer failure as a failed step and halts", async () => {
    const summarizer: Summarizer = {
      summarize: vi.fn(async () => {
        throw new Error("model unreachable");
      }),
    };
    const p = fakePrisma();

    const { outcome } = await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [summarizeStep(0), callStep(1, "get_system_health")],
      triggeredBy: null,
      summarizer,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/model unreachable/);
    // Halted — the step after it never ran.
    expect(outcome.trace).toHaveLength(1);
  });

  it("carries the summarizer's attributed message verbatim into the trace and the row", async () => {
    // WARP-2964 — the summarizer now names WHY the answer was empty
    // (finish_reason, reasoning size). That string is the whole diagnostic,
    // and it reaches the owner through these two fields with no schema
    // change, so nothing along the way may reword or truncate it.
    const attributed =
      "the model returned an empty summary (model=gpt-oss:20b finish_reason=length reasoning_chars=2518)";
    const summarizer: Summarizer = {
      summarize: vi.fn(async () => {
        throw new Error(attributed);
      }),
    };
    const p = fakePrisma();

    const { outcome } = await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [summarizeStep(7)],
      triggeredBy: null,
      summarizer,
    });

    expect(outcome.trace[0].error).toBe(attributed);
    // WARP-3409 — the message counts steps from 1, as every client lists them:
    // idx 7 is the eighth step ("Write a summary" in the Mac app).
    expect(p.created[0].error).toBe(`step 8 (summarize): ${attributed}`);
    expect(outcome.trace[0].idx).toBe(7);
  });

  it("contributes NO tool name to the pre-flight — there is nothing to authorize", () => {
    // If a summarize step leaked a name into this list, the §3 pre-flight
    // would try to authorize a tool that does not exist and refuse the spec.
    const names = plannedToolNames([
      callStep(0, "get_system_health"),
      summarizeStep(1),
      callStep(2, "network_summary"),
    ]);
    expect(names).toEqual(["get_system_health", "network_summary"]);
  });

  it("still treats a genuinely unknown kind as malformed", async () => {
    // The new branch must not turn the malformed guard into a no-op.
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [{ id: "x", idx: 0, kind: "teleport", args: {} }],
      triggeredBy: null,
      summarizer: { summarize: vi.fn(async () => "prose") },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/malformed \(kind=teleport\)/);
  });

  it("leaves a call-only spec behaving exactly as before", async () => {
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcherReturning({ ok: 1 }), {
      specId: "s",
      specName: "n",
      steps: [callStep(0, "get_system_health")],
      triggeredBy: null,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.trace).toHaveLength(1);
    expect(outcome.trace[0].tool).toBe("get_system_health");
  });
});

describe("optional steps — one unreadable source does not kill the narrative", () => {
  const optionalStep = (idx: number, tool: string) => ({
    id: `s${idx}`,
    idx,
    kind: "call",
    args: { tool, args: {}, optional: true },
  });

  it("records a failed OPTIONAL step and keeps walking to the summarize step", async () => {
    // The daily report reads sources a box may not have (no cameras, no
    // ERP). Before this, the first such failure halted the run and the tile
    // showed "Couldn't write the report" with no prose at all.
    const summarizer: Summarizer = { summarize: vi.fn(async () => "prose") };
    const dispatcher: StepDispatcher = {
      call: vi.fn(async (tool: string) => {
        if (tool === "get_camera_health") throw new Error("no cameras configured");
        return { ok: true };
      }),
    };
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcher, {
      specId: "s",
      specName: "n",
      steps: [
        optionalStep(0, "get_system_health"),
        optionalStep(1, "get_camera_health"),
        optionalStep(2, "list_recent_files"),
        summarizeStep(3),
      ],
      triggeredBy: null,
      summarizer,
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.trace.map((t) => [t.tool, t.ok])).toEqual([
      ["get_system_health", true],
      ["get_camera_health", false],
      ["list_recent_files", true],
      [SUMMARIZE_PSEUDO_TOOL, true],
    ]);
    // The failure is a FACT the summarizer sees, not something dropped.
    const facts = (summarizer.summarize as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(facts.find((f: { tool: string }) => f.tool === "get_camera_health")).toMatchObject({
      ok: false,
      error: "no cameras configured",
    });
  });

  it("leaves a deterministic signal when an optional read failed: activity `warn` + refs.failedSteps", async () => {
    // Run `ok`, HTTP 200, chip dropped — without this the only trace of a
    // Nextcloud outage was the model's choice of words.
    const summarizer: Summarizer = { summarize: vi.fn(async () => "prose") };
    const dispatcher: StepDispatcher = {
      call: vi.fn(async (tool: string) => {
        if (tool === "list_recent_files") throw new Error("the File Store returned 503");
        return { ok: true };
      }),
    };
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcher, {
      specId: "s",
      specName: "n",
      steps: [optionalStep(0, "get_system_health"), optionalStep(1, "list_recent_files"), summarizeStep(2)],
      triggeredBy: null,
      summarizer,
    });
    expect(outcome.status).toBe("ok");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        refs: expect.objectContaining({ status: "ok", failedSteps: ["list_recent_files"] }),
      }),
    );
  });

  it("emits no failedSteps and stays `ok` severity when every step succeeded", async () => {
    const p = fakePrisma();
    await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [optionalStep(0, "get_system_health")],
      triggeredBy: null,
    });
    const call = recordActivityMock.mock.calls[0][0];
    expect(call.severity).toBe("ok");
    expect(call.refs).not.toHaveProperty("failedSteps");
  });

  it("still HALTS on a failed step that is not marked optional", async () => {
    const summarizer: Summarizer = { summarize: vi.fn(async () => "prose") };
    const dispatcher: StepDispatcher = {
      call: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcher, {
      specId: "s",
      specName: "n",
      steps: [callStep(0, "get_system_health"), summarizeStep(1)],
      triggeredBy: null,
      summarizer,
    });
    expect(outcome.status).toBe("failed");
    expect(summarizer.summarize).not.toHaveBeenCalled();
    // WARP-3409 — counted from 1, like every other runner message.
    expect(outcome.error).toBe("step 1 (get_system_health): boom");
  });

  it("forwards the caller's identity to every tool call when given one", async () => {
    // Per-user tools (calendar, email) are `ctx.userId`-gated; without this
    // a spec run could never read anything the person had connected.
    const dispatcher: StepDispatcher = { call: vi.fn(async () => ({})) };
    const p = fakePrisma();
    await runToolSpec(p.client, dispatcher, {
      specId: "s",
      specName: "n",
      steps: [callStep(0, "list_events")],
      triggeredBy: "romain",
      callContext: { userId: "romain", userRole: "owner" },
    });
    expect(dispatcher.call).toHaveBeenCalledWith("list_events", {}, { userId: "romain", userRole: "owner" });
  });
});

describe("WARP-3409 — the report never fails because only its write-up did", () => {
  const optionalStep = (idx: number, tool: string) => ({
    id: `s${idx}`,
    idx,
    kind: "call",
    args: { tool, args: {}, optional: true },
  });

  it("a summarizer with a fallback: the step finishes with it, marked, and the run goes on", async () => {
    const seen: RunStepTrace[][] = [];
    const summarizer: Summarizer = {
      summarize: vi.fn(async () => {
        throw new Error("AI Gateway error 422: max_tokens");
      }),
      fallback: vi.fn((facts: RunStepTrace[]) => {
        seen.push(facts);
        return "System health: 9 of 9 services ok.";
      }),
    };
    const dispatcher: StepDispatcher = { call: vi.fn(async () => ({ status: "ok" })) };
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcher, {
      specId: "s",
      specName: "Daily report",
      steps: [
        optionalStep(0, "get_system_health"),
        { id: "s1", idx: 1, kind: "summarize", args: { as: "brief" } },
        { id: "s2", idx: 2, kind: "call", args: { tool: "send_notification", args: { body: "${steps.brief}" } } },
      ],
      triggeredBy: "u1",
      summarizer,
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.error).toBeNull();
    expect(outcome.trace[1]).toEqual({
      idx: 1,
      tool: SUMMARIZE_PSEUDO_TOOL,
      args: { prompt: DEFAULT_SUMMARY_PROMPT },
      ok: true,
      result: "System health: 9 of 9 services ok.",
      fallback: true,
      fallbackReason: "AI Gateway error 422: max_tokens",
      as: "brief",
    });
    // The fallback sees the same facts the model would have.
    expect(seen[0].map((t) => t.tool)).toEqual(["get_system_health"]);
    // A later step reads the fallback exactly as it would have read the prose.
    expect(dispatcher.call).toHaveBeenLastCalledWith("send_notification", {
      body: "System health: 9 of 9 services ok.",
    });
    expect(p.created[0]).toMatchObject({ status: "ok", error: null });
    // The feed still says something was missing.
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        what: "Spec run completed with gaps",
        refs: expect.objectContaining({ status: "ok", failedSteps: [SUMMARIZE_PSEUDO_TOOL] }),
      }),
    );
  });

  it("a write-up ended early (cut off twice) is stored as the prose, marked `truncated`, and counted as a gap", async () => {
    const summarizer: Summarizer = {
      summarize: vi.fn(async () => ({ text: "Your system is healthy.", truncated: true as const })),
    };
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcherReturning({ status: "ok" }), {
      specId: "s",
      specName: "Daily report",
      steps: [optionalStep(0, "get_system_health"), { id: "s1", idx: 1, kind: "summarize", args: { as: "brief" } }],
      triggeredBy: null,
      summarizer,
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.trace[1]).toMatchObject({
      tool: SUMMARIZE_PSEUDO_TOOL,
      ok: true,
      result: "Your system is healthy.",
      truncated: true,
      as: "brief",
    });
    expect(outcome.trace[1]).not.toHaveProperty("fallback");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warn", refs: expect.objectContaining({ failedSteps: [SUMMARIZE_PSEUDO_TOOL] }) }),
    );
  });

  it("a finished write-up carries no `truncated` key", async () => {
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [summarizeStep(0)],
      triggeredBy: null,
      summarizer: { summarize: vi.fn(async () => "prose") },
    });
    expect(Object.keys(outcome.trace[0])).not.toContain("truncated");
  });

  it("replays run a405c8a7: GLM thinks through the budget, the retry errors — the run is now ok with a readout", async () => {
    const glm = async () => "docker.io/ai/glm-4.7-flash:reap-q4_K_M";
    completeOnceMock
      .mockResolvedValueOnce({ content: "", model: "glm", reasoning: "x".repeat(6_940), finishReason: "length" })
      .mockRejectedValueOnce(
        new Error('AI Gateway error 422: {"detail":[{"loc":["body","max_tokens"],"msg":"Input should be less than or equal to 4096"}]}'),
      );
    const results: Record<string, unknown> = {
      get_system_health: { status: "ok", uptime: 16_831, components: [{ name: "redis", status: "ok" }] },
      list_recent_files: { items: [{ name: "a" }, { name: "b" }] },
      network_summary: { kpis: { clientCount: 7, dnsBlockedToday: 0 } },
      get_camera_health: { system: { cameraCount: 0, camerasLive: 0 } },
      list_events: { count: 0, events: [] },
    };
    const dispatcher: StepDispatcher = {
      call: vi.fn(async (tool: string) => {
        if (tool.startsWith("erp_")) {
          throw new Error(JSON.stringify({ status: "error", error: { code: "ERP_NOT_CONNECTED", message: "no" } }));
        }
        return results[tool];
      }),
    };
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcher, {
      specId: "s",
      specName: "Daily report",
      steps: [
        ...Object.keys(results).map((tool, i) => optionalStep(i, tool)),
        optionalStep(5, "erp_get_ar_summary"),
        optionalStep(6, "erp_get_schedule_today"),
        summarizeStep(7),
      ],
      triggeredBy: "romain",
      // Active and local resolvers both name GLM, as on the box (the file
      // listing makes this a local-only summary).
      summarizer: createToolSpecSummarizer(glm, glm),
    });

    expect(outcome.status).toBe("ok");
    const last = outcome.trace[7];
    expect(last).toMatchObject({ tool: SUMMARIZE_PSEUDO_TOOL, ok: true, fallback: true });
    expect(last.fallbackReason).toMatch(/^AI Gateway error 422/);
    expect(last.result).toBe(
      [
        "System health: 1 of 1 services ok.",
        "Recent files: 2 recently changed items.",
        "Network: 7 devices connected, 0 DNS lookups blocked today.",
        "Cameras: none set up.",
        "Calendar: no upcoming events.",
        "The written summary couldn't be produced because the AI service returned an error.",
      ].join("\n"),
    );
    // Both calls asked for low thinking; the retry for no more than the gateway takes.
    expect(completeOnceMock.mock.calls.map(([a]) => [a.model, a.provider, a.reasoningEffort, a.maxTokens])).toEqual([
      ["docker.io/ai/glm-4.7-flash:reap-q4_K_M", "local", "low", 2100],
      ["docker.io/ai/glm-4.7-flash:reap-q4_K_M", "local", "low", 4096],
    ]);
  });
});

describe("WARP-3409 — every runner message counts steps from 1 (the failing step is idx 2 → \"step 3\")", () => {
  const ok = (idx: number) => ({ id: `s${idx}`, idx, kind: "call", args: { tool: "list_files", args: {} } });
  const lockScope = { domains: new Set(["files", "smart-home"]), writeDomains: new Set(["smart-home"]), locks: false };
  const filesOnlyScope = { domains: new Set(["files"]), writeDomains: new Set(["files"]), locks: false };

  it.each([
    [
      "the whole-spec access pre-flight",
      { id: "s2", idx: 2, kind: "call", args: { tool: "control_device", args: { node_id: "n1" } } },
      { scope: filesOnlyScope },
      /^step 3 \(control_device\): not permitted by this run's access role$/,
    ],
    [
      "a summarize step with no summarizer",
      { id: "s2", idx: 2, kind: "summarize", args: {} },
      {},
      /^step 3: summarize step but no summarizer configured$/,
    ],
    [
      "a bad reference in a transform's inputs",
      { id: "s2", idx: 2, kind: "transform", args: { code: "output = 1", inputs: { a: "${steps.nope}" } } },
      { transformer: { transform: vi.fn() } },
      /^step 3 \(transform\): no earlier step is named "nope"/,
    ],
    [
      "a malformed step",
      { id: "s2", idx: 2, kind: "teleport", args: {} },
      {},
      /^step 3: malformed \(kind=teleport\)$/,
    ],
    [
      "a bad reference in a call step's args",
      { id: "s2", idx: 2, kind: "call", args: { tool: "list_files", args: { path: "${steps.nope}" } } },
      {},
      /^step 3 \(list_files\): no earlier step is named "nope"/,
    ],
    [
      "a dispatch-time denial (a lock the role may not operate)",
      { id: "s2", idx: 2, kind: "call", args: { tool: "control_device", args: { node_id: "n1", command: "unlock" } } },
      { scope: lockScope },
      /^step 3 \(control_device\): This person's access role does not permit operating locks/,
    ],
  ])("%s", async (_name, failing, extra, expected) => {
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcherReturning({ ok: true }), {
      specId: "s",
      specName: "n",
      steps: [ok(0), ok(1), failing],
      triggeredBy: null,
      ...(extra as Record<string, unknown>),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(expected);
  });
});

describe("WARP-3409 — a fallback readout that throws still leaves a recorded run", () => {
  it("fails the step with both reasons instead of escaping as a 500", async () => {
    const summarizer: Summarizer = {
      summarize: vi.fn(async () => {
        throw new Error("AI Gateway error 503");
      }),
      fallback: vi.fn(() => {
        throw new Error("readout bug");
      }),
    };
    const p = fakePrisma();
    const { outcome } = await runToolSpec(p.client, dispatcherReturning({}), {
      specId: "s",
      specName: "n",
      steps: [summarizeStep(0)],
      triggeredBy: null,
      summarizer,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe(
      "step 1 (summarize): AI Gateway error 503 (the fallback write-up failed too: readout bug)",
    );
    expect(p.created).toHaveLength(1);
    expect(p.created[0]).toMatchObject({ status: "failed" });
  });
});

describe("WARP-3282 — a step's result is scrubbed of credentials before the summary model and the run record see it", () => {
  const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  it("the facts, the returned trace and the persisted ToolRun hold the placeholder; the next step still gets the real value", async () => {
    const seen: RunStepTrace[][] = [];
    const summarizer: Summarizer = {
      summarize: vi.fn(async (_p, facts) => {
        seen.push(facts);
        return "prose";
      }),
    };
    const page = `export AWS_SECRET_ACCESS_KEY="${SECRET}"`;
    const call = vi.fn(async (tool: string, _args?: Record<string, unknown>) => (tool === "read_file" ? { page } : { ok: true }));
    const p = fakePrisma();

    const { outcome } = await runToolSpec(p.client, { call }, {
      specId: "spec-1",
      specName: "copy-config",
      steps: [
        callStep(0, "read_file"),
        { id: "s1", idx: 1, kind: "call", args: { tool: "write_file", args: { content: "${prev}" } } },
        summarizeStep(2),
      ],
      triggeredBy: "u1",
      summarizer,
    });

    expect(outcome.status).toBe("ok");
    // What the model is handed.
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect((seen[0]![0]!.result as { page: string }).page).toBe(
      'export AWS_SECRET_ACCESS_KEY="[credential redacted]"',
    );
    // What the run record keeps.
    expect(JSON.stringify(outcome.trace)).not.toContain(SECRET);
    expect(JSON.stringify(p.created)).not.toContain(SECRET);
    // Data flow between steps is not a model path: the write gets the file as read.
    expect(call.mock.calls[1]![1]).toEqual({ content: { page } });
  });
});
