/**
 * WARP-3047 — email analysis (the email_summarize_thread tool's back-end)
 * runs on the box's ACTIVE model, resolved PER CALL. It used to capture
 * `DEFAULT_MODEL ?? LLM_MODEL` once, when app.ts wired it at boot, so a
 * switch on the Models page never reached it — and on DMR every analysis
 * inside a chat turn on B loaded A next to B.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const runAgent = vi.hoisted(() => vi.fn());
vi.mock("./llm-agent.service.js", () => ({ runAgent }));

import { createEmailAnalysisFn } from "./email-analysis.service.js";
import type { McpClientPort } from "./mcp-client.port.js";

const mcp = {} as McpClientPort;
const input = {
  accountId: "acct-1",
  threadId: "t-1",
  subject: "Invoice",
  messages: [{ from: "a@b.c", receivedAt: "2026-09-23", bodyText: "Please pay." }],
};

beforeEach(() => {
  runAgent.mockReset();
  runAgent.mockResolvedValue({
    message: { role: "assistant", content: '{"summary":"An invoice."}' },
  });
});

describe("createEmailAnalysisFn — follows the active model (WARP-3047)", () => {
  it("resolves the model on EVERY call, so a switch reaches the next analysis", async () => {
    const resolveModel = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("docker.io/ai/gpt-oss:20B-F16")
      .mockResolvedValueOnce("docker.io/ai/qwen3:8B-Q4_K_M");
    const analyse = createEmailAnalysisFn(mcp, resolveModel);
    // Wiring (boot) resolves nothing.
    expect(resolveModel).not.toHaveBeenCalled();

    const first = await analyse(input);
    await analyse(input);

    expect(runAgent.mock.calls.map((c) => c[1].model)).toEqual([
      "docker.io/ai/gpt-oss:20B-F16",
      "docker.io/ai/qwen3:8B-Q4_K_M",
    ]);
    expect(first.summary).toBe("An invoice.");
  });

  it("no resolvable model → the placeholder analysis, no inference, no hardcoded tag", async () => {
    const analyse = createEmailAnalysisFn(mcp, async () => null);
    const out = await analyse(input);
    expect(out.summary).toBe("No analysis available.");
    expect(runAgent).not.toHaveBeenCalled();
  });
});
