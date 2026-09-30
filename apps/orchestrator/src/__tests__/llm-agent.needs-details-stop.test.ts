/**
 * WARP-3347 — "If there is no success searching after half the turn, prompt
 * the user for more details." (Romain, 2026-09-29)
 *
 * Eval evidence (gpt-oss:20b): ambiguous requests ("Send a message to the
 * manager saying hello.") rephrased search_content up to 16 times. The hits
 * were IRRELEVANT, not empty (the same escalation-policy document every
 * time), so the WARP-3283 three-empties trigger never fired. Once half the
 * turn's steps are spent on looking calls whose hits the turn never used, the
 * loop runs the WARP-3285 finalize pass with an ask-for-details instruction
 * and ends with stop_reason "needs_details".
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";

type Req = { tools: unknown[]; tool_choice: string; messages: { role: string; content: unknown }[] };

let n = 0;
const call = (name: string, args: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ],
});
const search = (query: string) => call("search_content", { query });
const ANSWER = "I checked your files and contacts. Which manager do you mean?";

/** adv-007's shape: every lookup returns something, none of it what was asked. */
const HITS: Record<string, string> = {
  search_content: JSON.stringify({
    query: "q",
    results: [{ path: "/Docs/Support/escalation-policy.md", text: "Escalation policy: Sev-1 …" }],
  }),
  search_contacts: JSON.stringify({ contacts: [{ name: "Bob Chen", email: "bob@example.com" }] }),
  list_files: JSON.stringify([{ path: "/Records/rec-1.pdf", type: "file" }]),
  memory_recall: JSON.stringify({ facts: [{ text: "Prefers email." }], matched: false }),
  business_find: JSON.stringify({ items: [{ id: "SUP-9", title: "Printer offline" }], total: 1 }),
  read_file: JSON.stringify({ path: "/Docs/Support/escalation-policy.md", content: "Escalation policy" }),
  delete_file: JSON.stringify({ status: "confirmation_required", error: { message: "Approve?" } }),
  business_update: JSON.stringify({ id: "SUP-9", status: "done" }),
  search_files: JSON.stringify({ items: [{ path: "/Finance/Q3-report.pdf" }] }),
  email_send: JSON.stringify({ status: "sent" }),
};
const TOOLS = Object.keys(HITS);

/**
 * `script` is what the model does on every pass that advertises tools; the
 * last entry repeats. A pass with NO tools (the finalize) answers ANSWER.
 */
function scripted(
  script: unknown[],
  fail: (name: string) => boolean = () => false,
  answer: unknown = { role: "assistant", content: ANSWER },
) {
  const requests: Req[] = [];
  const events: SSEEvent[] = [];
  let step = 0;
  const chat = vi.fn().mockImplementation(async (req: Req) => {
    requests.push({ ...req, messages: [...req.messages] });
    const message =
      req.tools.length === 0
        ? answer
        : script[Math.min(step++, script.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message, finish_reason: "stop" }] }) };
  });
  const callTool = vi.fn().mockImplementation(async (name: string) =>
    fail(name)
      ? {
          isError: true,
          content: [{ type: "text", text: '{"status":"error","error":{"code":"NOT_FOUND","message":"No file"}}' }],
        }
      : { isError: false, content: [{ type: "text", text: HITS[name] ?? "{}" }] },
  );
  const deps: AgentDeps = {
    mcp: {
      listTools: vi
        .fn()
        .mockResolvedValue(TOOLS.map((name) => ({ name, description: "d", inputSchema: {} }))),
      callTool,
    } as never,
    aiGateway: { chat } as never,
    onEvent: (e) => events.push(e),
  };
  return { deps, chat, callTool, requests, events };
}

const ask = (deps: AgentDeps, max_iter?: number) =>
  runAgent(deps, {
    model: "m",
    messages: [{ role: "user", content: "Send a message to the manager saying hello." }],
    ...(max_iter !== undefined ? { max_iter } : {}),
  });

/** Ten looking calls of every kind, then searching forever. */
const LOOKING = [
  search("manager email"),
  call("search_contacts", { query: "manager" }),
  call("list_files", { path: "/Contacts" }),
  call("memory_recall", { query: "manager" }),
  call("business_find", { entity: "contact", query: "manager" }),
  call("business_find", { entity: "work_item", limit: 20 }),
  search("manager"),
  search("engineering manager"),
  search("manager contact"),
  search("contact manager"),
  search("John manager email"),
];

describe("runAgent — ask for details after half the turn's steps found nothing (WARP-3347)", () => {
  it("stops searching at half of max_iter and asks for the missing detail", async () => {
    const { deps, chat, callTool, requests, events } = scripted(LOOKING);
    const result = await ask(deps, 20);

    // Iterations 0–9 each dispatched one looking call; iteration 10 finalizes.
    expect(callTool).toHaveBeenCalledTimes(10);
    expect(chat).toHaveBeenCalledTimes(11);
    const finalize = requests[10]!;
    expect(finalize.tools).toEqual([]);
    expect(finalize.tool_choice).toBe("none");
    const nudge = finalize.messages[finalize.messages.length - 1]!;
    // WARP-3285: a user message, since gpt-oss drops later system messages.
    expect(nudge.role).toBe("user");
    expect(String(nudge.content)).toContain("ask me for the specific detail");
    for (const req of requests.slice(0, 10)) expect(req.tools.length).toBeGreaterThan(0);

    expect(result.stop_reason).toBe("needs_details");
    expect(result.iterations).toBe(11);
    expect(result.message.content).toBe(ANSWER);
    expect(events.at(-1)).toMatchObject({ type: "done", stop_reason: "needs_details" });
  });

  it("a blank answer to the ask gets #2538's retry, then a fallback that still asks", async () => {
    // Eval (adv-007): the finalize pass and its retry both ended in the
    // reasoning channel. The search hits were judged unusable, so the
    // fallback must not say "I found some information".
    const blank = { role: "assistant", content: "", reasoning_content: "Maybe search contacts." };
    const { deps, chat } = scripted(LOOKING, () => false, blank);
    const result = await ask(deps, 20);
    expect(chat).toHaveBeenCalledTimes(12); // 10 searches + finalize + ONE retry
    expect(result.stop_reason).toBe("needs_details");
    expect(result.message.content).toBe(
      "I looked but didn't find anything matching. Could you tell me a bit more about what you're looking for?",
    );
  });

  it("uses the turn's own max_iter, rounding half up", async () => {
    const { callTool, deps } = scripted(LOOKING);
    const result = await ask(deps, 11);
    expect(callTool).toHaveBeenCalledTimes(6);
    expect(result.stop_reason).toBe("needs_details");
  });

  it("a durable run is never cut: nobody can answer its question", async () => {
    const searches = Array.from({ length: 14 }, (_, i) => search(`q${i}`));
    const { callTool, requests, deps } = scripted([...searches, { role: "assistant", content: "Report." }]);
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "Find the manager's email and say hello." }],
      max_iter: 20,
      toolCallContext: { userId: "u1", userRole: "owner", agentRunId: "run-1" },
    });
    expect(callTool).toHaveBeenCalledTimes(14);
    expect(requests.every((r) => r.tools.length > 0)).toBe(true);
    expect(result.stop_reason).toBe("model_done");
  });

  it("a 4-step voice turn keeps its action step after two lookups", async () => {
    // voice-io's DEFAULT_LLM_MAX_ITER is 4. "Email the Q3 report to the
    // accountant": find the person, find the file, then send.
    const { callTool, deps } = scripted([
      call("search_contacts", { query: "accountant" }),
      call("search_files", { query: "Q3 report" }),
      call("email_send", { to: "bob@example.com", subject: "Q3 report" }),
      { role: "assistant", content: "Sent." },
    ]);
    const result = await ask(deps, 4);
    expect(callTool.mock.calls.map((c) => c[0])).toEqual(["search_contacts", "search_files", "email_send"]);
    expect(result.stop_reason).toBe("model_done");
  });

  it("steps that were not searches do not make half the turn 'searching'", async () => {
    // Two searches that ran, then failing reads: not progress, not searching.
    const reads = Array.from({ length: 10 }, (_, i) => call("read_file", { path: `/guess-${i}.md` }));
    const { callTool, deps } = scripted(
      [search("a"), search("b"), ...reads, { role: "assistant", content: "Done." }],
      (name) => name === "read_file",
    );
    const result = await ask(deps, 20);
    expect(callTool).toHaveBeenCalledTimes(12);
    expect(result.stop_reason).toBe("model_done");
  });

  it("the chat default budget (20) cuts at step 10", async () => {
    const { callTool, deps } = scripted(LOOKING);
    expect((await ask(deps)).stop_reason).toBe("needs_details");
    expect(callTool).toHaveBeenCalledTimes(10);
  });

  // Turns that got somewhere keep all their steps. Each script: a few looking
  // calls, ONE call that is progress, then more looking calls past the half
  // mark, then the model answers on its own.
  const answer = { role: "assistant", content: "Done." };
  const withProgress = (progress: unknown) => [
    search("a"),
    search("b"),
    progress,
    ...Array.from({ length: 10 }, (_, i) => search(`c${i}`)),
    answer,
  ];

  it.each([
    ["opening a returned file", call("read_file", { path: "/Docs/Support/escalation-policy.md" })],
    ["reading a record by id", call("business_find", { entity: "work_item", id: "SUP-17" })],
    ["listing a known record's children", call("business_find", { entity: "work_item", parent_id: "prj-support" })],
    ["a write parked on a confirmation", call("delete_file", { path: "/Records/rec-1.pdf" })],
  ])("%s is progress: the turn is not cut", async (_label, progress) => {
    const { callTool, requests, deps } = scripted(withProgress(progress));
    const result = await ask(deps, 20);
    expect(callTool).toHaveBeenCalledTimes(13);
    expect(requests.every((r) => r.tools.length > 0)).toBe(true);
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("Done.");
  });

  it("a failed read is not progress", async () => {
    const { callTool, deps } = scripted(
      withProgress(call("read_file", { path: "/guess.md" })),
      (name) => name === "read_file",
    );
    const result = await ask(deps, 20);
    expect(callTool).toHaveBeenCalledTimes(10);
    expect(result.stop_reason).toBe("needs_details");
  });

  it("an approved call replayed at the start of the turn is progress", async () => {
    const grant = { challengeId: "ch1", tool: "business_update", args: { entity: "work_item", id: "SUP-9", status: "done" }, token: "t" };
    const takeNextApproved = vi.fn().mockReturnValueOnce(grant).mockReturnValue(null);
    const { callTool, deps } = scripted([...Array.from({ length: 12 }, (_, i) => search(`q${i}`)), answer]);
    deps.approvals = { register: vi.fn(), claimGrant: vi.fn().mockReturnValue(null), takeNextApproved } as never;
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "I approved that — go ahead." }],
      max_iter: 20,
      toolCallContext: { userId: "u1", userRole: "owner" },
    });
    expect(callTool).toHaveBeenCalledTimes(13); // the replay + 12 searches
    expect(result.stop_reason).toBe("model_done");
  });

  it("a search tool that keeps failing is an outage, not a failed search: WARP-1012's reply stands", async () => {
    const searches = Array.from({ length: 6 }, (_, i) => search(`q${i}`));
    const { callTool, deps } = scripted(searches, () => true);
    const result = await ask(deps, 6);
    expect(callTool).toHaveBeenCalledTimes(6);
    expect(result.stop_reason).toBe("iteration_limit");
    expect(result.message.content).toContain("kept failing");
  });

  it("never cuts before step 4: a budget of 4 or fewer steps is left alone", async () => {
    const four = scripted(LOOKING);
    expect((await ask(four.deps, 4)).stop_reason).toBe("iteration_limit");
    expect(four.callTool).toHaveBeenCalledTimes(4);
    const five = scripted(LOOKING);
    expect((await ask(five.deps, 5)).stop_reason).toBe("needs_details");
    expect(five.callTool).toHaveBeenCalledTimes(4);
  });
});
