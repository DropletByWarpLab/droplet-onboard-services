/**
 * WARP-3283 — no-progress early-stop. A model that keeps REPHRASING a search
 * that finds nothing makes distinct calls, so the repetition guard never
 * fires and the loop used to run to the iteration cap and emit the canned
 * "couldn't finish within my step limit" text. After three zero-hit search
 * results in one turn the loop now runs the same finalization pass the
 * repetition / context-budget guards use (no tools, tool_choice "none").
 */
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

let n = 0;
const call = (name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: null,
  tool_calls: [
    { id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ],
});
const search = (query: string) => call("search_content", { query });

function makeDeps(turns: unknown[], results: (name: string) => string) {
  const chat = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: turns[Math.min(chat.mock.calls.length - 1, turns.length - 1)] }],
    }),
  }));
  const callTool = vi.fn().mockImplementation(async (name: string) => ({
    isError: false,
    content: [{ type: "text", text: results(name) }],
  }));
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue(
        ["search_content", "search_files", "email_search", "list_files"].map((name) => ({
          name,
          description: "d",
          inputSchema: {},
        })),
      ),
      callTool,
    } as never,
    aiGateway: { chat } as never,
  };
  return { deps, chat, callTool };
}

const empty = (name: string) =>
  name === "search_files"
    ? '{"items":[]}'
    : name === "email_search"
      ? '{"type":"email_search","filter":{},"threadCount":0,"threads":[]}'
      : '{"query":"q","results":[]}';

type Req = { tools: unknown[]; tool_choice: string; messages: { role: string; content: unknown }[] };

describe("runAgent — no-progress early-stop (WARP-3283)", () => {
  it("finalizes after three zero-hit searches from a model that rephrases forever", async () => {
    const { deps, chat, callTool } = makeDeps([], empty);
    // Rephrases forever across three search tools; only a request that
    // advertises NO tools (the finalize pass) gets a text answer out of it.
    const rephrasings = [
      () => search("data-deletion policy"),
      () => call("search_files", { query: "deletion" }),
      () => call("email_search", { query: "deletion policy" }),
    ];
    chat.mockImplementation(async (req: Req) => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message:
              req.tools.length === 0
                ? { role: "assistant", content: "I couldn't find a data-deletion policy." }
                : rephrasings[chat.mock.calls.length % 3]!(),
          },
        ],
      }),
    }));

    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "quote our data-deletion policy" }],
      max_iter: 10,
    });

    expect(callTool).toHaveBeenCalledTimes(3);
    expect(chat).toHaveBeenCalledTimes(4);
    const finalReq = chat.mock.calls[3]![0] as Req;
    expect(finalReq.tools).toEqual([]);
    expect(finalReq.tool_choice).toBe("none");
    expect(
      finalReq.messages.some(
        (m) => m.role === "system" && String(m.content).includes("found nothing"),
      ),
    ).toBe(true);
    expect(result.stop_reason).toBe("no_progress");
    expect(result.iterations).toBe(4);
    expect(result.message.content).toBe("I couldn't find a data-deletion policy.");
  });

  it("counts empty searches across the turn: an irrelevant hit in between does not reset it", async () => {
    // adv-010's real trace: rephrasings interleave low-relevance partial hits.
    const hit = '{"query":"q","results":[{"path":"/a.md","text":"x"}]}';
    let i = 0;
    const { deps, chat, callTool } = makeDeps(
      [search("a"), search("b"), search("c"), search("d"), { role: "assistant", content: "not found" }],
      // empty, HIT, empty, empty
      () => (++i === 2 ? hit : '{"query":"q","results":[]}'),
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(4);
    expect((chat.mock.calls[4]![0] as Req).tools).toEqual([]);
    expect(result.stop_reason).toBe("no_progress");
  });

  it("two empty searches are not enough", async () => {
    const { deps, callTool } = makeDeps(
      [search("a"), search("b"), { role: "assistant", content: "not found" }],
      () => '{"query":"q","results":[]}',
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(result.stop_reason).toBe("model_done");
  });

  it("a failed search is not a zero-hit search", async () => {
    const { deps, callTool } = makeDeps(
      [search("a"), search("b"), search("c"), { role: "assistant", content: "done" }],
      () => '{"status":"error","error":{"code":"TIMEOUT","message":"t"}}',
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(result.stop_reason).toBe("model_done");
  });

  it("non-search tools neither count nor reset", async () => {
    const { deps, chat, callTool } = makeDeps(
      [
        search("a"),
        call("list_files", { path: "/" }),
        search("b"),
        search("c"),
        { role: "assistant", content: "not found" },
      ],
      (name) => (name === "list_files" ? '[{"path":"/x.md"}]' : '{"query":"q","results":[]}'),
    );
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "find it" }],
      max_iter: 10,
    });
    expect(callTool).toHaveBeenCalledTimes(4);
    expect((chat.mock.calls[4]![0] as Req).tools).toEqual([]);
    expect(result.stop_reason).toBe("no_progress");
  });
});
