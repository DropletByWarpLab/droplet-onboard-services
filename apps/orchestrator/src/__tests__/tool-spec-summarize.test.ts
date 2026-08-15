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

import {
  DEFAULT_SUMMARY_PROMPT,
  SUMMARIZE_PSEUDO_TOOL,
  plannedToolNames,
  runToolSpec,
  type RunStepTrace,
  type StepDispatcher,
  type Summarizer,
} from "../services/tool-spec-runner.service.js";

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
