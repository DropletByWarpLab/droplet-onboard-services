/**
 * WARP-1480 — the `agent_tool_error` line must actually FIRE.
 *
 * `read_file` transiently errors inside agent loops until the iteration budget
 * burns, and the failure is UNATTRIBUTED. The envelope was never the problem —
 * mcp-server preserves `code`/`message`/`details` end to end and the loop
 * parses them. The problem is that NOTHING EVER LOGGED A TOOL FAILURE:
 * `result.isError` is read to shape the SSE event and to gate citation
 * extraction, and never recorded.
 *
 * So a test that merely exercises the error path and asserts nothing about the
 * log would be worthless — the absence of the log IS the bug. Every case below
 * asserts on the emitted line.
 *
 * ## Why the logger is `vi.mock`ed
 *
 * `createLogger` has a documented `dest` seam for tests (a writable sink), but
 * it is unreachable from here: `llm-agent.service.ts` calls
 * `createLogger("llm-agent")` at MODULE SCOPE, so the logger is constructed at
 * import time with no sink and there is no consumer-facing hook to pass one.
 * Mocking the factory module is the only way to observe the line without
 * rewriting production code purely for testability.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface LoggedLine {
  obj: Record<string, unknown>;
  msg: string;
}

const logged = vi.hoisted(() => [] as LoggedLine[]);

vi.mock("../lib/logger.js", () => {
  const noop = () => {};
  const stub = {
    warn: (obj: Record<string, unknown>, msg: string) => {
      logged.push({ obj, msg });
    },
    trace: noop,
    debug: noop,
    info: noop,
    error: noop,
    fatal: noop,
    silent: noop,
    child: () => stub,
  };
  return { createLogger: () => stub };
});

import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

const REQ = {
  model: "gpt-oss:20b",
  messages: [{ role: "user" as const, content: "what is in my Q3 notes?" }],
};

type ToolCallSpec = { id: string; name: string; args: string };

/**
 * A gateway that issues `calls` on iteration 1, then answers. Tool results come
 * from `callTool`, which the caller supplies so each test can pick a wire shape.
 */
function buildDeps(
  calls: ToolCallSpec[],
  callTool: AgentDeps["mcp"]["callTool"],
): AgentDeps {
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
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.args },
              })),
            },
          },
        ],
      }),
    })
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { role: "assistant", content: "I could not read that file." },
            finish_reason: "stop",
          },
        ],
      }),
    });

  return {
    mcp: {
      listTools: vi.fn().mockResolvedValue([
        { name: "read_file", description: "d", inputSchema: {} },
        { name: "list_files", description: "d", inputSchema: {} },
      ]),
      callTool,
    } as never,
    aiGateway: { chat } as never,
  };
}

function wire(text: string, isError = true) {
  return vi.fn().mockResolvedValue({ isError, content: [{ type: "text", text }] });
}

const errorLines = () => logged.filter((l) => l.msg === "agent_tool_error");

beforeEach(() => {
  logged.length = 0;
});

describe("agent_tool_error — it fires, and carries the envelope", () => {
  it("logs a HANDLER_THREW envelope with the cause chain classified", async () => {
    await runAgent(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: '{"path":"/Notes/Q3.md"}' }],
        wire(
          '{"status":"error","error":{"code":"HANDLER_THREW","message":"fetch failed <- caused by: ECONNRESET"}}',
        ),
      ),
      REQ,
    );

    expect(errorLines()).toHaveLength(1);
    const { obj } = errorLines()[0];
    expect(obj).toMatchObject({
      tool: "read_file",
      tool_call_id: "call_1",
      iter: 0,
      error_shape: "envelope",
      error_code: "HANDLER_THREW",
      // WARP-1480's whole point: this distinguishes a reset socket from a DNS
      // failure from a timeout, and it is ALWAYS on.
      message_class: "econnreset",
      arg_keys: ["path"],
      arg_keys_dropped: 0,
    });
    expect(obj.turn_id).toEqual(expect.any(String));
    expect(obj.args_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(obj.args_identity).toMatch(/^[0-9a-f]{16}$/);
  });

  it("logs the ORCH-05 dispatch-throw path as string_error", async () => {
    await runAgent(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: '{"path":"/Notes/Q3.md"}' }],
        vi.fn().mockRejectedValue(new Error("stdio child gone")),
      ),
      REQ,
    );

    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0].obj).toMatchObject({
      error_shape: "string_error",
      error_code: "TOOL_DISPATCH_FAILED",
      message_class: "unclassified",
    });
  });

  it("logs a non-JSON stdio hiccup as raw", async () => {
    await runAgent(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: "{}" }],
        wire("Segmentation fault"),
      ),
      REQ,
    );

    expect(errorLines()[0].obj).toMatchObject({
      error_shape: "raw",
      error_code: "NON_JSON_RESULT",
    });
  });

  it("logs an isError body that carries no error field as unknown", async () => {
    // The fourth shape, end to end. It exists so a future drift in the
    // mcp-server wire contract shows up as a spike in ONE token rather than as
    // silence — which is the failure mode WARP-1604 already caught once.
    await runAgent(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: '{"path":"/a.md"}' }],
        wire('{"results":[]}'),
      ),
      REQ,
    );

    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0].obj).toMatchObject({
      error_shape: "unknown",
      error_code: "UNCLASSIFIED",
      message_class: "unclassified",
      message_len: 0,
    });
    // Still attributable: the correlation keys do not depend on the shape.
    expect(errorLines()[0].obj.tool_call_id).toBe("call_1");
  });
});

describe("agent_tool_error — what it must NOT log", () => {
  it("stays silent on a successful call", async () => {
    await runAgent(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: '{"path":"/a.md"}' }],
        wire('{"path":"/a.md","content":"hi"}', false),
      ),
      REQ,
    );

    expect(errorLines()).toHaveLength(0);
  });

  it("stays silent on confirmation_required — a UX pause is not a failure", async () => {
    // mcp-server sets isError only for status "error", so this is excluded for
    // free at the emit point. Pinned so a future change to that rule is caught.
    await runAgent(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: '{"path":"/a.md"}' }],
        wire(
          '{"status":"confirmation_required","error":{"code":"CONFIRM","message":"approve?"}}',
          false,
        ),
      ),
      REQ,
    );

    expect(errorLines()).toHaveLength(0);
  });

  it("omits message_excerpt with AGENT_BLANK_TURN_DEBUG off (the default)", async () => {
    await runAgent(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: '{"path":"/a.md"}' }],
        wire(
          '{"status":"error","error":{"code":"READ_FAILED","message":"nextcloud returned 500"}}',
        ),
      ),
      REQ,
    );

    const { obj } = errorLines()[0];
    expect(obj.message_excerpt).toBeUndefined();
    // …but attribution still works, which is the point of blocker 6.
    expect(obj.error_code).toBe("READ_FAILED");
    expect(obj.message_class).toBe("nextcloud_500");
    expect(obj.message_len).toBeGreaterThan(0);
  });
});

describe("agent_tool_error — model-controlled input is shape-guarded", () => {
  it("drops a path-shaped argument key before it can reach the diagnostics zip", async () => {
    await runAgent(
      buildDeps(
        [
          {
            id: "call_1",
            name: "read_file",
            // `safeParseArgs` is a bare JSON.parse and nothing validates these
            // against the inputSchema, so a KEY can be a full patient path.
            args: '{"path":"/x.md","/Patients/Jane Doe/chart.pdf":1}',
          },
        ],
        wire('{"status":"error","error":{"code":"READ_FAILED","message":"nope"}}'),
      ),
      REQ,
    );

    const { obj } = errorLines()[0];
    expect(obj.arg_keys).toEqual(["path"]);
    expect(obj.arg_keys_dropped).toBe(1);
    expect(JSON.stringify(obj)).not.toContain("Jane Doe");
  });

  it("never puts a model-supplied path into args_fingerprint", async () => {
    await runAgent(
      buildDeps(
        [
          {
            id: "call_1",
            name: "read_file",
            args: '{"path":"/Patients/Jane Doe/chart.pdf"}',
          },
        ],
        wire('{"status":"error","error":{"code":"READ_FAILED","message":"nope"}}'),
      ),
      REQ,
    );

    expect(JSON.stringify(errorLines()[0].obj)).not.toContain("Jane Doe");
  });
});

describe("agent_tool_error — correlation", () => {
  it("shares one turn_id across every failure in a turn, and mints a new one per turn", async () => {
    const calls: ToolCallSpec[] = [
      { id: "call_1", name: "read_file", args: '{"path":"/a.md"}' },
      { id: "call_2", name: "read_file", args: '{"path":"/b.md"}' },
    ];
    const failing = wire(
      '{"status":"error","error":{"code":"READ_FAILED","message":"nope"}}',
    );

    await runAgent(buildDeps(calls, failing), REQ);
    const turnOne = errorLines().map((l) => l.obj.turn_id);
    expect(turnOne).toHaveLength(2);
    expect(new Set(turnOne).size).toBe(1);
    // tool_call_id is the per-call join key `thread_id` cannot be.
    expect(errorLines().map((l) => l.obj.tool_call_id)).toEqual([
      "call_1",
      "call_2",
    ]);

    logged.length = 0;
    await runAgent(buildDeps(calls, failing), REQ);
    expect(errorLines()[0].obj.turn_id).not.toBe(turnOne[0]);
  });

  it("omits thread_id on an unpersisted turn rather than logging a blank", async () => {
    await runAgent(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: "{}" }],
        wire('{"status":"error","error":{"code":"READ_FAILED","message":"nope"}}'),
      ),
      REQ,
    );

    expect(errorLines()[0].obj).not.toHaveProperty("thread_id");
  });
});

describe("agent_tool_error — the excerpt is opt-in", () => {
  it("includes a bounded, redacted excerpt when AGENT_BLANK_TURN_DEBUG is on", async () => {
    vi.resetModules();
    vi.doMock("../config.js", async (importOriginal) => {
      const mod = await importOriginal<typeof import("../config.js")>();
      return { ...mod, config: { ...mod.config, AGENT_BLANK_TURN_DEBUG: true } };
    });
    const { runAgent: runWithDebug } = await import(
      "../services/llm-agent.service.js"
    );

    logged.length = 0;
    await runWithDebug(
      buildDeps(
        [{ id: "call_1", name: "read_file", args: '{"path":"/a.md"}' }],
        wire(
          '{"status":"error","error":{"code":"READ_FAILED","message":"upstream said Authorization: Bearer sk-live-abc123def456"}}',
        ),
      ),
      REQ,
    );

    const { obj } = errorLines()[0];
    expect(obj.message_excerpt).toBeDefined();
    expect(String(obj.message_excerpt)).toContain("[REDACTED]");
    expect(String(obj.message_excerpt)).not.toContain("sk-live-abc123def456");

    vi.doUnmock("../config.js");
    vi.resetModules();
  });
});
