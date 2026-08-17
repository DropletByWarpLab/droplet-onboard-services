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

beforeEach(() => {
  vi.clearAllMocks();
  completeOnceMock.mockResolvedValue({ content: "A quiet morning.", model: "m" });
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
    const out = renderFacts([failed("erp_get_ar_summary", "ERP_NOT_CONNECTED")]);
    expect(out).toMatch(/COULD NOT BE READ/);
    expect(out).toMatch(/ERP_NOT_CONNECTED/);
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
    completeOnceMock.mockResolvedValue({ content: "  Nine files landed.  ", model: "m" });
    const s = createToolSpecSummarizer();
    await expect(s.summarize("Write it up.", [ok("t", 1)])).resolves.toBe("Nine files landed.");
  });

  it("THROWS on an empty completion rather than returning an empty report", async () => {
    // completeOnce treats empty content as a non-error. Here it is one: an
    // empty narrative is indistinguishable from a quiet day.
    completeOnceMock.mockResolvedValue({ content: "   ", model: "m" });
    const s = createToolSpecSummarizer();
    await expect(s.summarize("Write it up.", [ok("t", 1)])).rejects.toThrow(/empty summary/);
  });

  it("sends the facts and the spec's prompt to the model", async () => {
    const s = createToolSpecSummarizer();
    await s.summarize("Focus on the money.", [ok("erp_get_ar_summary", { totalBalance: 10 })]);
    const arg = completeOnceMock.mock.calls[0][0];
    expect(arg.text).toMatch(/Focus on the money\./);
    expect(arg.text).toMatch(/erp_get_ar_summary/);
    expect(arg.text).toMatch(/totalBalance/);
  });

  it("instructs the model not to invent figures", async () => {
    const s = createToolSpecSummarizer();
    await s.summarize("Write it up.", [ok("t", 1)]);
    const arg = completeOnceMock.mock.calls[0][0];
    expect(arg.system).toMatch(/Never estimate, infer/i);
    expect(arg.system).toMatch(/could not be read/i);
  });

  it("never advertises a tool — the call path is non-agentic by contract", async () => {
    const s = createToolSpecSummarizer();
    await s.summarize("Write it up.", [ok("t", 1)]);
    const arg = completeOnceMock.mock.calls[0][0];
    expect(arg).not.toHaveProperty("tools");
    expect(arg).not.toHaveProperty("tool_choice");
  });

  it("propagates a gateway failure so the step records it", async () => {
    completeOnceMock.mockRejectedValue(new Error("llm_unavailable"));
    const s = createToolSpecSummarizer();
    await expect(s.summarize("x", [])).rejects.toThrow(/llm_unavailable/);
  });
});
