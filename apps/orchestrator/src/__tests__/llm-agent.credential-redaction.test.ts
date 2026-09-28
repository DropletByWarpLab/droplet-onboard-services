/**
 * WARP-3282 — a credential inside a retrieved document must never reach the
 * model, the persisted trace or the SSE stream. The eval (adv-019) showed the
 * model repeating an AWS secret from a search_content snippet verbatim.
 *
 * Assertions are on the exact string the loop pushed onto the model-facing
 * `messages` (observed through the second `aiGateway.chat()` call), on the
 * returned trace, and on the emitted `tool_result` event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface LoggedLine {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}

const logged = vi.hoisted(() => [] as LoggedLine[]);

vi.mock("../lib/logger.js", () => {
  const noop = () => {};
  const rec = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  const stub = {
    warn: rec("warn"),
    info: rec("info"),
    trace: noop,
    debug: noop,
    error: noop,
    fatal: noop,
    silent: noop,
    child: () => stub,
  };
  return { createLogger: () => stub };
});

import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";
import { CREDENTIAL_PLACEHOLDER } from "../lib/log-redaction.js";

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const WIRE = JSON.stringify({
  results: [
    {
      path: "/Shared/IT/security-notes.md",
      snippet: `Legacy integration credential (do not share): AWS_SECRET_ACCESS_KEY=${SECRET}`,
    },
  ],
});

async function runOneSearch(wireText: string) {
  const chat = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "search_content", arguments: '{"query":"security"}' },
                },
              ],
            },
          },
        ],
      }),
    })
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      }),
    });
  const events: SSEEvent[] = [];
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue([
        { name: "search_content", description: "d", inputSchema: {} },
      ]),
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: wireText }],
      }),
    } as never,
    aiGateway: { chat } as never,
    onEvent: (e) => events.push(e),
  };
  const result = await runAgent(deps, {
    model: "gpt-oss:20b",
    messages: [{ role: "user", content: "Search our documents for 'security'" }],
  });
  const followUp = chat.mock.calls[1][0] as { messages: { role: string; content: string }[] };
  const toolMsg = followUp.messages.find((m) => m.role === "tool")!;
  return { result, events, toolMsg };
}

beforeEach(() => {
  logged.length = 0;
});

describe("WARP-3282 — tool results are scrubbed of credentials", () => {
  it("the model never sees the secret; it sees the placeholder and the key name", async () => {
    const { toolMsg } = await runOneSearch(WIRE);
    expect(toolMsg.content).not.toContain(SECRET);
    expect(toolMsg.content).toContain(`AWS_SECRET_ACCESS_KEY=${CREDENTIAL_PLACEHOLDER}`);
    // The citation path survives — only the value is gone.
    expect(toolMsg.content).toContain("/Shared/IT/security-notes.md");
  });

  it("the persisted trace and the SSE tool_result carry no secret either", async () => {
    const { result, events } = await runOneSearch(WIRE);
    expect(JSON.stringify(result.trace)).not.toContain(SECRET);
    const toolEvents = events.filter((e) => e.type === "tool_result");
    expect(toolEvents).toHaveLength(1);
    expect(JSON.stringify(toolEvents[0])).not.toContain(SECRET);
    expect(JSON.stringify(toolEvents[0])).toContain(CREDENTIAL_PLACEHOLDER);
  });

  it("logs a count, never the secret", async () => {
    await runOneSearch(WIRE);
    const line = logged.find((l) => l.msg === "agent_tool_result_credentials_redacted");
    expect(line).toBeDefined();
    expect(line!.obj).toMatchObject({ tool: "search_content", redacted: 1 });
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it("a QUOTED env assignment — escaped on the wire — is scrubbed too, and the result still parses (review #2469)", async () => {
    const wire = JSON.stringify({
      results: [
        { path: "/Shared/IT/.env", snippet: `export AWS_SECRET_ACCESS_KEY="${SECRET}"` },
        { path: "/Shared/IT/app.json", snippet: '{"user": "svc", "password": "correct horse battery"}' },
      ],
    });
    // The escaped form is what the loop receives.
    expect(wire).toContain('AWS_SECRET_ACCESS_KEY=\\"');
    const { toolMsg, result } = await runOneSearch(wire);
    expect(toolMsg.content).not.toContain(SECRET);
    expect(toolMsg.content).not.toContain("correct horse battery");
    const parsed = JSON.parse(toolMsg.content) as { results: Array<{ path: string; snippet: string }> };
    expect(parsed.results.map((r) => r.path)).toEqual(["/Shared/IT/.env", "/Shared/IT/app.json"]);
    expect(parsed.results[0]!.snippet).toBe(`export AWS_SECRET_ACCESS_KEY="${CREDENTIAL_PLACEHOLDER}"`);
    expect(JSON.stringify(result.trace)).not.toContain(SECRET);
  });

  it("a clean result passes through byte-identical and logs nothing", async () => {
    const clean = JSON.stringify({ results: [{ path: "/a.md", snippet: "Q3 revenue grew 12%." }] });
    const { toolMsg } = await runOneSearch(clean);
    expect(toolMsg.content).toBe(clean);
    expect(logged.find((l) => l.msg === "agent_tool_result_credentials_redacted")).toBeUndefined();
  });
});
