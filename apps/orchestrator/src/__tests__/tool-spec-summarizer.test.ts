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
  fallbackSummary,
  renderFacts,
  toLastSentence,
  TRUNCATED_NOTE,
} from "../services/tool-spec-summarizer.service.js";
import type { RunStepTrace } from "../services/tool-spec-runner.service.js";
import { GATEWAY_MAX_TOKENS } from "../types/index.js";

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

  it("DROPS a not-connected source from the facts, in code — never left to the model", () => {
    // ERP_NOT_CONNECTED means the owner never set the source up: not news.
    // AUTH_REQUIRED is a per-user source with nobody to read it for (a
    // scheduled run). WARP-3409: marked and left to the prompt, a model with
    // thinking off wrote the ERP up as "could not be read" anyway.
    const out = renderFacts([
      ok("get_system_health", { status: "ok" }),
      failed("erp_get_ar_summary", toolError("ERP_NOT_CONNECTED", "ERP not connected yet")),
      failed("list_events", toolError("AUTH_REQUIRED", "auth_required")),
    ]);
    expect(out).toBe('- get_system_health: {"status":"ok"}');
    expect(out).not.toMatch(/erp_get_ar_summary|list_events|NOT CONNECTED/);
  });

  it("says nothing was gathered when every source was not connected", () => {
    expect(renderFacts([failed("erp_get_ar_summary", toolError("ERP_NOT_CONNECTED", "no"))])).toBe(
      "(no results were gathered)",
    );
  });

  it("renders any other error CODE as could-not-read with its message — Nextcloud down is news", () => {
    expect(
      renderFacts([failed("list_recent_files", toolError("RECENT_FAILED", "the File Store returned 503"))]),
    ).toBe("- list_recent_files: COULD NOT BE READ (the File Store returned 503)");
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

  it("puts known raw figures in a person's units — seconds, bytes, bits per second", () => {
    // WARP-3409 — given `"uptime":16831`, every model opened the report with
    // "running for 16,831 seconds".
    const out = renderFacts([
      ok("get_system_health", { status: "ok", uptime: 16_831 }),
      ok("get_camera_health", { system: { uptimeSec: 172_735, storage: [{ freeBytes: 712_596_835_533, usedBytes: 0 }] } }),
      ok("list_recent_files", { items: [{ name: "a.png", size: 328_693 }, { name: "b", size: 512 }] }),
      ok("network_summary", { kpis: { wanUpBps: 0, wanDownBps: 2_500_000, clientCount: 7, offLanBytesThisMonth: 1_073_741_824 } }),
      ok("lan_summary", { kpis: { wanUpBps: 2_500_000_000 } }),
    ]);
    expect(out).toContain('"uptime":"4 h 40 min"');
    expect(out).toContain('"uptimeSec":"1 d 23 h"');
    expect(out).toContain('"freeBytes":"663.7 GB"');
    expect(out).toContain('"usedBytes":"0 B"');
    expect(out).toContain('"size":"321.0 KB"');
    expect(out).toContain('"size":"512 B"');
    expect(out).toContain('"wanUpBps":"0 bps"');
    expect(out).toContain('"wanDownBps":"2.5 Mbps"');
    expect(out).toContain('"wanUpBps":"2.5 Gbps"');
    expect(out).toContain('"offLanBytesThisMonth":"1.0 GB"');
    // Everything else is left exactly as the tool returned it.
    expect(out).toContain('"clientCount":7');
    expect(out).toContain('"status":"ok"');
  });

  it("leaves a known field alone when it is not a non-negative number", () => {
    const out = renderFacts([ok("t", { size: "large", uptime: -1, totalBytesPerHour: 5_000, constructor: 5 })]);
    expect(out).toBe('- t: {"size":"large","uptime":-1,"totalBytesPerHour":5000,"constructor":5}');
  });
});

/** The dispatcher throws the MCP error envelope verbatim (app.ts). */
const envelope = (code: string, message: string) => JSON.stringify({ status: "error", error: { code, message } });

/** The facts of run a405c8a7 (2026-09-30), trimmed to the fields the readouts use. */
const dailyFacts = (): RunStepTrace[] => [
  ok("get_system_health", {
    status: "ok",
    uptime: 16_831,
    components: ["ai-gateway", "display", "file-indexer", "mqtt", "nextcloud", "postgres", "redis", "routing", "storage"].map(
      (name) => ({ name, status: "ok" }),
    ),
  }),
  ok("list_recent_files", { items: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}` })) }),
  ok("network_summary", { kpis: { clientCount: 7, dnsBlockedToday: 0 } }),
  ok("get_camera_health", { system: { cameraCount: 0, camerasLive: 0 }, cameras: [] }),
  ok("list_events", { count: 0, events: [] }),
  failed("erp_get_ar_summary", envelope("ERP_NOT_CONNECTED", "ERP not connected yet")),
  failed("erp_get_schedule_today", envelope("ERP_NOT_CONNECTED", "ERP not connected yet")),
];

describe("fallbackSummary (WARP-3409) — the write-up when the model could not write one", () => {
  it("reads out each source in plain lines, leaves NOT CONNECTED out, and says why there is no prose", () => {
    expect(fallbackSummary(dailyFacts(), new Error("AI Gateway error 422: …"))).toBe(
      [
        "System health: 9 of 9 services ok.",
        "Recent files: the 30 most recently changed items.",
        "Network: 7 devices connected, 0 DNS lookups blocked today.",
        "Cameras: none set up.",
        "Calendar: no upcoming events.",
        "The written summary couldn't be produced because the AI service returned an error.",
      ].join("\n"),
    );
  });

  it("says a failed read plainly, names services that are not ok, and counts live cameras", () => {
    const out = fallbackSummary(
      [
        ok("get_system_health", { components: [{ name: "redis", status: "ok" }, { name: "nextcloud", status: "down" }] }),
        failed("list_recent_files", envelope("RECENT_FAILED", "the File Store returned 503")),
        ok("get_camera_health", { system: { cameraCount: 3, camerasLive: 2 } }),
        ok("list_events", { count: 1 }),
      ],
      new Error("x"),
    ).split("\n");
    expect(out.slice(0, 4)).toEqual([
      "System health: 1 of 2 services ok (not ok: nextcloud).",
      "Recent files: couldn't be read.",
      "Cameras: 2 of 3 live.",
      "Calendar: 1 upcoming event.",
    ]);
  });

  it("a full page of recent files is 'the 30 most recent', never a count of everything that changed", () => {
    // list_recent_files asks /recents?limit=30 with no time window: 30 back
    // means "at least 30", so printing 30 as a total would be a guessed figure.
    const line = (n: number) =>
      fallbackSummary([ok("list_recent_files", { items: Array.from({ length: n }, (_, i) => ({ name: `f${i}` })) })], new Error("x")).split(
        "\n",
      )[0];
    expect(line(30)).toBe("Recent files: the 30 most recently changed items.");
    expect(line(29)).toBe("Recent files: 29 recently changed items.");
    expect(line(1)).toBe("Recent files: 1 recently changed item.");
  });

  it("never guesses: an unrecognised shape or an unknown tool is just 'checked'; pseudo-steps are not sources", () => {
    const out = fallbackSummary(
      [
        ok("network_summary", { kpis: { clientCount: "seven" } }),
        ok("search_files", { hits: 4 }),
        ok("toString", {}),
        { idx: 2, tool: "(transform)", args: {}, ok: true, result: 1 },
      ],
      new Error("x"),
    ).split("\n");
    expect(out.slice(0, -1)).toEqual(["Network: checked.", "search_files: checked.", "toString: checked."]);
  });

  it("says so when nothing was gathered", () => {
    expect(fallbackSummary([failed("erp_get_ar_summary", envelope("ERP_NOT_CONNECTED", "no"))], new Error("x"))).toBe(
      "Nothing was gathered to report on.\nThe written summary couldn't be produced because the AI service returned an error.",
    );
  });

  it("names the cause in plain words: out of room, no text, no model, too slow", async () => {
    const why = async (): Promise<string> => {
      const s = createToolSpecSummarizer(activeModel);
      const err = await s.summarize("Write it up.", [ok("t", 1)]).then(
        () => null,
        (e: unknown) => e,
      );
      return s.fallback!([], err).split("\n").pop()!;
    };

    completeOnceMock.mockResolvedValue({ content: "", model: "m", reasoning: "x".repeat(6940), finishReason: "length" });
    expect(await why()).toBe("The written summary couldn't be produced because the AI model ran out of room before it wrote anything.");

    completeOnceMock.mockResolvedValue({ content: "", model: "m", reasoning: "", finishReason: "stop" });
    expect(await why()).toBe("The written summary couldn't be produced because the AI model returned no text.");

    completeOnceMock.mockRejectedValue(new Error("AI Gateway timeout after 120000ms during completeOnce"));
    expect(await why()).toBe("The written summary couldn't be produced because the AI model took too long to answer.");

    activeModel.mockResolvedValue(null);
    expect(await why()).toBe("The written summary couldn't be produced because no AI model was available to write it.");
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

  it("asks for LOW thinking on the first call — the gateway's family table decides what that means", async () => {
    // WARP-3409 — replaying the failed run: gpt-oss:20B at default effort
    // took 8–22 s and was cut off once in three; at low, 3–4 s, 3/3 done.
    // GLM at its default spent all 2,100 tokens thinking; "low" = thinking off.
    const s = createToolSpecSummarizer(activeModel);
    await s.summarize("Write it up.", [ok("t", 1)]);
    expect(completeOnceMock.mock.calls[0][0].reasoningEffort).toBe("low");
  });

  it("RETRIES once on a blank answer with a doubled budget CAPPED at the gateway's ceiling, still low", async () => {
    // WARP-2964 — a blank answer with finish_reason=length is a budget
    // failure, not a quiet day. Give it room once before giving up.
    // WARP-3409 — but never past the gateway's le=4096: 2 × 2,100 = 4,200
    // was a 422 that failed the whole run.
    completeOnceMock
      .mockResolvedValueOnce({ content: "   ", model: "m", reasoning: "…", finishReason: "length" })
      .mockResolvedValueOnce({ content: "Nine files landed.", model: "m", reasoning: "", finishReason: "stop" });
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).resolves.toBe("Nine files landed.");
    expect(completeOnceMock).toHaveBeenCalledTimes(2);
    expect(completeOnceMock.mock.calls[1][0].maxTokens).toBe(GATEWAY_MAX_TOKENS);
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

  // WARP-3409 — a write-up cut off mid-sentence (finish_reason=length with
  // text) is not finished; replaying the failed run, gpt-oss at default effort
  // returned 658 chars ending "…display " once in three.
  const cut = (content: string) => ({ content, model: "m", reasoning: "", finishReason: "length" });
  const done = (content: string) => ({ content, model: "m", reasoning: "", finishReason: "stop" });

  it("RETRIES a cut-off answer like a blank one, and takes the retry when it finishes", async () => {
    completeOnceMock.mockResolvedValueOnce(cut("All is well. The latency for each component is low: display ")).mockResolvedValueOnce(done("All is well."));
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).resolves.toBe("All is well.");
    expect(completeOnceMock.mock.calls.map(([a]) => [a.maxTokens, a.reasoningEffort])).toEqual([
      [2100, "low"],
      [GATEWAY_MAX_TOKENS, "low"],
    ]);
  });

  it("cut off twice: keeps the LONGER text up to its last complete sentence and marks it truncated", async () => {
    completeOnceMock
      .mockResolvedValueOnce(cut("Your system is healthy. Uptime is 4 h 40 min. CPU is at 8.8 %. Stor"))
      .mockResolvedValueOnce(cut("Your system is healthy. Uptime is 4 h 40 min. CPU is at 8."));
    const s = createToolSpecSummarizer(activeModel);
    // The first is longer, so it is kept; its dangling "Stor" goes, and the
    // "8.8" inside it is not mistaken for a sentence end.
    await expect(s.summarize("Write it up.", [ok("t", 1)])).resolves.toEqual({
      text: `Your system is healthy. Uptime is 4 h 40 min. CPU is at 8.8 %.\n\n${TRUNCATED_NOTE}`,
      truncated: true,
    });
  });

  it("cut off, then a blank retry: the cut-off text is kept, ended cleanly", async () => {
    completeOnceMock.mockResolvedValueOnce(cut("Nine files landed. Two more are")).mockResolvedValueOnce(done(""));
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).resolves.toEqual({
      text: `Nine files landed.\n\n${TRUNCATED_NOTE}`,
      truncated: true,
    });
  });

  it("cut off with no complete sentence at all: throws, and the fallback says why in plain words", async () => {
    completeOnceMock.mockResolvedValueOnce(cut("Your system has been running for")).mockResolvedValueOnce(cut("Your system"));
    const s = createToolSpecSummarizer(activeModel);
    const err = await s.summarize("Write it up.", [ok("t", 1)]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/no complete sentence \(model=m finish_reason=length/);
    expect(s.fallback!([], err).split("\n").pop()).toBe(
      "The written summary couldn't be produced because the AI model ran out of room before it finished a sentence.",
    );
  });

  it("a retry that ERRORS does not throw away the first answer's prose", async () => {
    completeOnceMock
      .mockResolvedValueOnce(cut("Your system is healthy. Nine files landed. Two"))
      .mockRejectedValueOnce(new Error("AI Gateway timeout after 120000ms during completeOnce"));
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).resolves.toEqual({
      text: `Your system is healthy. Nine files landed.\n\n${TRUNCATED_NOTE}`,
      truncated: true,
    });
  });

  it("a retry that errors after a BLANK first answer still throws (nothing to keep)", async () => {
    completeOnceMock.mockResolvedValueOnce(cut("")).mockRejectedValueOnce(new Error("AI Gateway error 503"));
    const s = createToolSpecSummarizer(activeModel);
    await expect(s.summarize("Write it up.", [ok("t", 1)])).rejects.toThrow(/AI Gateway error 503/);
  });

  it("a trimmed summary says so in the prose itself — no client reads `truncated`", () => {
    expect(TRUNCATED_NOTE).toBe("This summary was cut short; some details may be missing.");
  });

  it("toLastSentence: a terminator counts only with whitespace after it", () => {
    expect(toLastSentence("One. Two! Three? Fou")).toBe("One. Two! Three?");
    expect(toLastSentence("He said “fine.” Then")).toBe("He said “fine.”");
    expect(toLastSentence("Storage is 663.7 GB and CPU 8.")).toBe("");
    expect(toLastSentence("No sentence ends here")).toBe("");
  });

  it("sends the facts and the spec's prompt to the model", async () => {
    const s = createToolSpecSummarizer(activeModel);
    await s.summarize("Focus on the money.", [ok("get_system_health", { totalBalance: 10 })]);
    const arg = completeOnceMock.mock.calls[0][0];
    expect(arg.text).toMatch(/Focus on the money\./);
    expect(arg.text).toMatch(/get_system_health/);
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

// A routine's `summarize` step writes up the results of the steps before it. When any of those came from a
// domain that never goes to a cloud model (OFF_LAN_WITHHELD_DOMAINS), the prose is
// written on the box's LOCAL model — never the active model, which may be a cloud one — or not at all.
describe("summarize after a withheld domain's step: the local model only", () => {
  const localModel = vi.fn(async (): Promise<string | null> => "gpt-oss:20b");

  beforeEach(() => {
    localModel.mockReset().mockResolvedValue("gpt-oss:20b");
    activeModel.mockResolvedValue("claude-sonnet-4");
  });

  it.each([
    ["files", "search_files"],
    ["memory", "memory_recall"],
    ["business", "business_find"],
    ["email", "email_search"],
    ["calendar", "list_events"],
    ["team_chat", "team_chat_send_message"],
    ["cameras", "list_camera_events"],
    ["cloud", "cloud_query_dataset"],
    ["money", "money_list_open_documents"],
    ["erp", "erp_get_schedule_today"],
  ])("a %s step before it → the LOCAL model writes the summary, whatever the active model", async (_d, tool) => {
    const summarizer = createToolSpecSummarizer(activeModel, localModel);
    await summarizer.summarize("Write it up.", [ok(tool, { results: [] }), ok("get_system_health", { status: "ok" })]);
    expect(localModel).toHaveBeenCalled();
    expect(completeOnceMock).toHaveBeenCalled();
    for (const [args] of completeOnceMock.mock.calls) expect(args.model).toBe("gpt-oss:20b");
  });

  it("a FAILED withheld-domain step counts too: its error text still reaches the prompt", async () => {
    const summarizer = createToolSpecSummarizer(activeModel, localModel);
    await summarizer.summarize("Write it up.", [failed("read_file", "FILE_NOT_FOUND")]);
    expect(completeOnceMock.mock.calls[0]![0].model).toBe("gpt-oss:20b");
  });

  // The model id alone is not the pin: the gateway routes by name prefix when no provider is named, so a locally
  // served model called gpt-* or claude-* would still reach a cloud provider. Every call names the local provider.
  it("every call names provider `local` — the first, and the blank-answer retry", async () => {
    completeOnceMock
      .mockResolvedValueOnce({ content: "  ", model: "m", reasoning: "…", finishReason: "length" })
      .mockResolvedValueOnce({ content: "Done.", model: "m", reasoning: "", finishReason: "stop" });
    const summarizer = createToolSpecSummarizer(activeModel, localModel);
    await summarizer.summarize("Write it up.", [ok("search_files", { results: [] })]);
    expect(completeOnceMock).toHaveBeenCalledTimes(2);
    for (const [args] of completeOnceMock.mock.calls) expect(args.provider).toBe("local");
  });

  it("no local model → the step fails plainly; nothing is sent to any model", async () => {
    localModel.mockResolvedValue(null);
    const summarizer = createToolSpecSummarizer(activeModel, localModel);
    await expect(summarizer.summarize("Write it up.", [ok("business_find", { results: [] })])).rejects.toThrow(/on this Droplet/);
    expect(completeOnceMock).not.toHaveBeenCalled();
  });

  it("no withheld domain → the active model, as before; the local resolver is not even asked", async () => {
    const summarizer = createToolSpecSummarizer(activeModel, localModel);
    await summarizer.summarize("Write it up.", [ok("get_system_health", { status: "ok" }), ok("list_network_devices", { devices: [] })]);
    expect(completeOnceMock.mock.calls[0]![0].model).toBe("claude-sonnet-4");
    expect(Object.keys(completeOnceMock.mock.calls[0]![0])).not.toContain("provider");
    expect(localModel).not.toHaveBeenCalled();
  });
});
