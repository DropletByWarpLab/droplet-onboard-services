/**
 * WARP-1996 — the on-box summarizer that backs a `summarize` step.
 *
 * The subject here is the PROMPT, because the prompt is the only thing
 * standing between "a report" and "a plausible-sounding fiction". Two rules
 * carry the weight: a step that failed must reach the model as a failure, and
 * an empty completion must be an error rather than an empty report.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const completeOnceMock = vi.hoisted(() => vi.fn());
vi.mock("../services/llm-complete.service.js", () => ({
  completeOnce: completeOnceMock,
}));

import {
  createToolSpecSummarizer,
  renderFacts,
} from "../services/tool-spec-summarizer.service.js";
import type { RunStepTrace } from "../services/tool-spec-runner.service.js";

const ok = (tool: string, result: unknown): RunStepTrace => ({
  idx: 0,
  tool,
  args: {},
  ok: true,
  result,
});

const failed = (tool: string, error: string): RunStepTrace => ({
  idx: 0,
  tool,
  args: {},
  ok: false,
  error,
});

/** WARP-3047 — the injected active-model resolver. */
const activeModel = vi.fn(async (): Promise<string | null> => "m");

beforeEach(() => {
  vi.clearAllMocks();
  activeModel.mockResolvedValue("m");
  completeOnceMock.mockResolvedValue({
    content: "A quiet morning.",
    model: "m",
    reasoning: "",
    finishReason: "stop",
  });
});

describe("renderFacts", () => {
  it("renders a successful step's result as JSON", () => {
    expect(renderFacts([ok("get_system_health", { status: "ok" })])).toBe(
      '- get_system_health: {"status":"ok"}',
    );
  });

  it("renders a FAILED step as an explicit could-not-read, not an omission", () => {
    // A narrative that silently drops the step that failed is the exact
    // dishonesty this surface exists to prevent — so the failure has to
    // reach the model as a fact it can report.
    const out = renderFacts([failed("get_system_health", "socket hang up")]);
    expect(out).toBe("- get_system_health: COULD NOT BE READ (socket hang up)");
  });

  /** The dispatcher throws the MCP error envelope verbatim (app.ts). */
  const toolError = (code: string, message: string) =>
    JSON.stringify({ status: "error", error: { code, message } });

  it("maps a not-connected error CODE to NOT CONNECTED mechanically — never left to the model", () => {
    // ERP_NOT_CONNECTED means the owner never set the source up: not news.
    // AUTH_REQUIRED is a per-user source with nobody to read it for (a
    // scheduled run). Both leave the report; the prompt says so in the
    // same words.
    expect(renderFacts([failed("erp_get_ar_summary", toolError("ERP_NOT_CONNECTED", "ERP not connected yet"))])).toBe(
      "- erp_get_ar_summary: NOT CONNECTED",
    );
    expect(renderFacts([failed("list_events", toolError("AUTH_REQUIRED", "auth_required"))])).toBe(
      "- list_events: NOT CONNECTED",
    );
  });

  it("renders any other error CODE as could-not-read with its message — Nextcloud down is news", () => {
    expect(
      renderFacts([failed("list_recent_files", toolError("RECENT_FAILED", "nextcloud returned 503"))]),
    ).toBe("- list_recent_files: COULD NOT BE READ (nextcloud returned 503)");
  });

  it("keeps failures alongside successes rather than filtering them out", () => {
    const out = renderFacts([
      ok("get_system_health", { status: "ok" }),
      failed("erp_get_ar_summary", "ERP_NOT_CONNECTED"),
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });

  it("truncates a huge result and SAYS it truncated", () => {
    // Unmarked truncation would let the model describe a partial list as if
    // it were the whole thing.
    const big = { files: Array.from({ length: 5000 }, (_, i) => `file-${i}.pdf`) };
    const out = renderFacts([ok("list_recent_files", big)]);
    expect(out.length).toBeLessThan(2_200);
    expect(out).toMatch(/truncated/);
  });

  it("says so when nothing was gathered rather than handing over a blank", () => {
    // A blank facts block leaves the model free to invent a day.
    expect(renderFacts([])).toBe("(no results were gathered)");
  });

  it("survives an unserialisable result instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = renderFacts([ok("weird_tool", circular)]);
    expect(out).toMatch(/could not be serialised/);
  });
});

describe("createToolSpecSummarizer", () => {
  it("returns the model's prose, trimmed", async () => {
    completeOnceMock.mockResolvedValue({
      content: "  Nine files landed.  ",
      model: "m",
      reasoning: "",
      finishReason: "stop",
    });
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).resolves.toBe("Nine files landed.");
  });

  it("budgets the FIRST call for a reasoning model's analysis channel", async () => {
    // WARP-2964 — gpt-oss burns the whole budget in the harmony analysis
    // channel before it writes a word of prose. 700 tokens never reached
    // `content`; the replay needed ~1150 completion tokens to finish.
    const s = createToolSpecSummarizer(activeModel);
    await s.summarize("Write it up.", [ok("t", 1)]);
    expect(completeOnceMock.mock.calls[0][0].maxTokens).toBe(2100);
  });

  it("makes exactly ONE call when the first answer is not blank", async () => {
    const s = createToolSpecSummarizer(activeModel);
    await s.summarize("Write it up.", [ok("t", 1)]);
    expect(completeOnceMock).toHaveBeenCalledTimes(1);
  });

  it("RETRIES once on a blank answer with a doubled budget and low effort", async () => {
    // WARP-2964 — a blank answer with finish_reason=length is a budget
    // failure, not a quiet day. Give it room once before giving up.
    completeOnceMock
      .mockResolvedValueOnce({ content: "   ", model: "m", reasoning: "…", finishReason: "length" })
      .mockResolvedValueOnce({ content: "Nine files landed.", model: "m", reasoning: "", finishReason: "stop" });
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).resolves.toBe("Nine files landed.");
    expect(completeOnceMock).toHaveBeenCalledTimes(2);
    expect(completeOnceMock.mock.calls[1][0].maxTokens).toBe(4200);
    expect(completeOnceMock.mock.calls[1][0].reasoningEffort).toBe("low");
  });

  it("THROWS on an empty completion rather than returning an empty report", async () => {
    // completeOnce treats empty content as a non-error. Here it is one: an
    // empty narrative is indistinguishable from a quiet day.
    completeOnceMock.mockResolvedValue({ content: "   ", model: "m", reasoning: "", finishReason: "stop" });
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).rejects.toThrow(/empty summary/);
  });

  it("ATTRIBUTES a twice-blank answer — the provider's verdict, not just 'empty'", async () => {
    // WARP-2964 — "the model returned an empty summary" told the owner
    // nothing and told whoever debugged it less. finish_reason=length plus
    // a fat reasoning channel names the budget as the cause on sight.
    completeOnceMock.mockResolvedValue({
      content: "",
      model: "m",
      reasoning: "x".repeat(2518),
      finishReason: "length",
    });
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).rejects.toThrow(
      /empty summary \(model=.* finish_reason=length reasoning_chars=2518\)/,
    );
    expect(completeOnceMock).toHaveBeenCalledTimes(2);
  });

  it("sends the facts and the spec's prompt to the model", async () => {
    const s = createToolSpecSummarizer(activeModel);
    await s.summarize("Focus on the money.", [ok("erp_get_ar_summary", { totalBalance: 10 })]);
    const arg = completeOnceMock.mock.calls[0][0];
    expect(arg.text).toMatch(/Focus on the money\./);
    expect(arg.text).toMatch(/erp_get_ar_summary/);
    expect(arg.text).toMatch(/totalBalance/);
  });

  it("instructs the model not to invent figures", async () => {
    const s = createToolSpecSummarizer(activeModel);
    await s.summarize("Write it up.", [ok("t", 1)]);
    const arg = completeOnceMock.mock.calls[0][0];
    expect(arg.system).toMatch(/Never estimate, infer/i);
    expect(arg.system).toMatch(/could not be read/i);
  });

  it("never advertises a tool — the call path is non-agentic by contract", async () => {
    const s = createToolSpecSummarizer(activeModel);
    await s.summarize("Write it up.", [ok("t", 1)]);
    const arg = completeOnceMock.mock.calls[0][0];
    expect(arg).not.toHaveProperty("tools");
    expect(arg).not.toHaveProperty("tool_choice");
  });

  it("propagates a gateway failure so the step records it", async () => {
    completeOnceMock.mockRejectedValue(new Error("llm_unavailable"));
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("x", [])).rejects.toThrow(/llm_unavailable/);
  });
});

describe("createToolSpecSummarizer — follows the active model (WARP-3047)", () => {
  it("summarises on the model the resolver names, asked per summary", async () => {
    activeModel
      .mockResolvedValueOnce("docker.io/ai/gpt-oss:20B-F16")
      .mockResolvedValueOnce("docker.io/ai/qwen3:8B-Q4_K_M");
    const s = createToolSpecSummarizer(activeModel);
    await s.summarize("Write it up.", [ok("t", 1)]);
    await s.summarize("Write it up.", [ok("t", 1)]);
    expect(completeOnceMock.mock.calls.map((c) => c[0].model)).toEqual([
      "docker.io/ai/gpt-oss:20B-F16",
      "docker.io/ai/qwen3:8B-Q4_K_M",
    ]);
  });

  it("no resolvable model fails the step plainly and never calls inference", async () => {
    activeModel.mockResolvedValue(null);
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).rejects.toThrow(
      /no local model is available/,
    );
    expect(completeOnceMock).not.toHaveBeenCalled();
  });
});
