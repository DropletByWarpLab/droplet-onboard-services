/**
 * WARP-2203 Phase 1 — the tool result the MODEL reads must be valid JSON,
 * must fit the cap, and must never carry a cursor that over-claims.
 *
 * ## Why this file lives in the orchestrator, not in tools-core
 *
 * The original defect was INVISIBLE to every tool-boundary test. The 8000-char
 * cap is orchestrator-only: `llm-agent.service.ts` did
 * `content: text.slice(0, 8000)` on `JSON.stringify(result.data)`. Both
 * `read_file` and `read_document_text` shipped green handler suites while being
 * inert on the chat path, because the handler returns the whole page and the
 * loop cut it afterwards. A paging tool puts bulk text FIRST and the
 * continuation marker LAST, so a character cut deletes exactly the "there is
 * more" signal and keeps the fragment that looks complete.
 *
 * So every assertion here is on **the exact string pushed onto `messages`** —
 * observed through the second `aiGateway.chat()` call, which is the only place
 * the model-facing history is visible from outside. Nothing here asserts on a
 * handler return value; that is the class of test that missed the bug.
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

import { getTool, type ToolContext, type ToolResult } from "@droplet/tools-core";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import { MODEL_TOOL_RESULT_CAP_CHARS } from "../services/tool-result-bounding.js";

const REQ = {
  model: "gpt-oss:20b",
  messages: [{ role: "user" as const, content: "read my Q3 notes" }],
};

const CAP = MODEL_TOOL_RESULT_CAP_CHARS;

/**
 * mcp-server's `toolResultToContent`, replicated. Documented in
 * `services/tool-result-payload.ts`: ok → the handler payload UNWRAPPED at the
 * root; !ok → `{status, error}` at the root. No `ok`, no `data` wrapper. A test
 * that hand-rolled `{ok, data}` here would be testing a shape production never
 * emits — that is how WARP-1604 hid for a release cycle.
 */
function onTheWire(result: ToolResult): { isError: boolean; content: { type: string; text: string }[] } {
  const text = result.ok
    ? JSON.stringify(result.data)
    : JSON.stringify({ status: result.status, error: result.error });
  return {
    isError: !result.ok && result.status === "error",
    content: [{ type: "text", text }],
  };
}

/**
 * Run one agent turn in which the model calls `toolName` once and then answers.
 * Returns the exact `content` string the loop pushed onto the model-facing
 * `messages` array.
 */
async function boundedToolMessage(
  toolName: string,
  wireText: string,
  opts: { isError?: boolean } = {},
): Promise<string> {
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
                  function: { name: toolName, arguments: "{}" },
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

  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue([
        { name: toolName, description: "d", inputSchema: {} },
      ]),
      callTool: vi.fn().mockResolvedValue({
        isError: opts.isError ?? false,
        content: [{ type: "text", text: wireText }],
      }),
    } as never,
    aiGateway: { chat } as never,
  };

  await runAgent(deps, REQ);

  expect(chat.mock.calls.length).toBeGreaterThanOrEqual(2);
  const followUp = chat.mock.calls[1][0] as {
    messages: { role: string; content: string }[];
  };
  const toolMsgs = followUp.messages.filter((m) => m.role === "tool");
  expect(toolMsgs).toHaveLength(1);
  return toolMsgs[0].content;
}

beforeEach(() => {
  logged.length = 0;
});

/** Every path, including refusal, must hand the model parseable JSON. */
function parses(s: string): unknown {
  return JSON.parse(s);
}

describe("WARP-2203 — the fast path is byte-for-byte untouched", () => {
  it("passes a small payload through VERBATIM", async () => {
    const wire = JSON.stringify({ path: "/a.md", content: "hello", next_offset: null });
    const out = await boundedToolMessage("read_file", wire);
    expect(out).toBe(wire);
  });

  it("passes a payload of exactly CAP chars through VERBATIM", async () => {
    const filler = "x".repeat(CAP - JSON.stringify({ path: "/a.md", content: "" }).length);
    const wire = JSON.stringify({ path: "/a.md", content: filler });
    expect(wire.length).toBe(CAP);
    const out = await boundedToolMessage("read_file", wire);
    expect(out).toBe(wire);
  });

  it("passes a bare-array payload (list_files) through VERBATIM under the cap", async () => {
    const wire = JSON.stringify([
      { name: "a.md", type: "file" },
      { name: "b.md", type: "file" },
    ]);
    const out = await boundedToolMessage("list_files", wire);
    expect(out).toBe(wire);
    expect(Array.isArray(parses(out))).toBe(true);
  });
});

describe("WARP-2203 — the old character slice produced invalid JSON; the new one cannot", () => {
  it("emits valid JSON for an over-cap read_file page (the flagship defect)", async () => {
    const wire = JSON.stringify({
      path: "/Notes/Q3.md",
      content: "A".repeat(10000),
      offset: 0,
      truncated: true,
      next_offset: 10000,
      bytes_total: 25000,
      chars_total: 25000,
    });
    // Baseline the DEFECT: the old behaviour is not valid JSON.
    expect(() => JSON.parse(wire.slice(0, CAP))).toThrow();

    const out = await boundedToolMessage("read_file", wire);
    expect(out.length).toBeLessThanOrEqual(CAP);
    const parsed = parses(out) as Record<string, unknown>;
    expect(parsed.path).toBe("/Notes/Q3.md");
    expect(parsed._orchestrator_truncation).toBeTruthy();
  });

  it("emits valid JSON for an over-cap bare array (list_files end to end)", async () => {
    const wire = JSON.stringify(
      Array.from({ length: 400 }, (_, i) => ({
        name: `file-${i}.md`,
        path: `/deep/nested/directory/name/file-${i}.md`,
        size: 1234,
      })),
    );
    expect(wire.length).toBeGreaterThan(CAP);
    const out = await boundedToolMessage("list_files", wire);
    expect(out.length).toBeLessThanOrEqual(CAP);
    const parsed = parses(out) as Record<string, unknown>;
    // A bare array root cannot carry the marker, so it is wrapped — the ONLY
    // shape change, and only on the path that was already being destroyed.
    expect(Array.isArray(parsed.value)).toBe(true);
    expect((parsed.value as unknown[]).length).toBeGreaterThan(0);
    expect((parsed.value as unknown[]).length).toBeLessThan(400);
    expect(parsed._orchestrator_truncation).toBeTruthy();
  });

  it("emits valid JSON for a non-object, non-array root (B5 — the Matter tools)", async () => {
    // `control_device`, `get_smart_home_device` and `list_smart_home_devices`
    // return whatever the Matter sidecar handed back: statically `unknown`.
    const wire = JSON.stringify("S".repeat(20000));
    const out = await boundedToolMessage("control_device", wire);
    expect(out.length).toBeLessThanOrEqual(CAP);
    const parsed = parses(out) as Record<string, unknown>;
    expect(typeof parsed.value).toBe("string");
    expect(parsed._orchestrator_truncation).toBeTruthy();
  });

  it("emits valid JSON for non-JSON stdio spew above the cap", async () => {
    const out = await boundedToolMessage("read_file", "Segmentation fault ".repeat(2000), {
      isError: true,
    });
    expect(out.length).toBeLessThanOrEqual(CAP);
    const parsed = parses(out) as Record<string, unknown>;
    expect(typeof parsed.value).toBe("string");
  });
});

describe("WARP-2203 — B1: the cursor pass is INSIDE the measured payload", () => {
  it("keeps read_document_text's default page under the cap AFTER the cursor pass", async () => {
    // DEFAULT_MAX_CHARS = 12000, so the flagship payload always exceeds 8000.
    const wire = JSON.stringify({
      type: "read_document_text",
      path: "/Docs/handbook.pdf",
      source: "nextcloud",
      text: "T".repeat(12000),
      chunks_returned: 6,
      start_chunk: 0,
      next_chunk: 7,
      total_chunks: 40,
      pages: [1, 2, 3],
    });
    const out = await boundedToolMessage("read_document_text", wire);
    expect(out.length).toBeLessThanOrEqual(CAP);
    parses(out);
  });

  it("stays under the cap for a payload engineered to sit just over it", async () => {
    for (const overshoot of [1, 2, 7, 40, 200, 900]) {
      const base = JSON.stringify({ path: "/a.md", content: "", offset: 0, next_offset: null });
      const wire = JSON.stringify({
        path: "/a.md",
        content: "y".repeat(CAP - base.length + overshoot),
        offset: 0,
        next_offset: null,
      });
      expect(wire.length).toBeGreaterThan(CAP);
      const out = await boundedToolMessage("read_file", wire);
      expect(out.length).toBeLessThanOrEqual(CAP);
      parses(out);
    }
  });
});

describe("WARP-2203 — B4: read_document_text's whole accounting group goes", () => {
  it("removes next_chunk AND the siblings that could reconstruct it", async () => {
    const wire = JSON.stringify({
      type: "read_document_text",
      path: "/Docs/handbook.pdf",
      source: "nextcloud",
      text: "T".repeat(12000),
      chunks_returned: 6,
      start_chunk: 3,
      next_chunk: 9,
      total_chunks: 40,
    });
    const out = await boundedToolMessage("read_document_text", wire);
    const parsed = parses(out) as Record<string, unknown>;

    // Chunk indices are NOT promised dense (see read-document-text.ts), so
    // `start_chunk + chunks_returned` is not `next_chunk` — leaving the pair
    // behind hands the model a wrong resume point it can compute itself.
    expect(parsed).not.toHaveProperty("next_chunk");
    expect(parsed).not.toHaveProperty("start_chunk");
    expect(parsed).not.toHaveProperty("chunks_returned");
    expect(parsed).not.toHaveProperty("total_chunks");

    // What survives is what is still true.
    expect(parsed.path).toBe("/Docs/handbook.pdf");
    expect(parsed.type).toBe("read_document_text");
    expect(typeof parsed.text).toBe("string");

    const marker = parsed._orchestrator_truncation as Record<string, unknown>;
    expect(marker.removed_keys).toEqual(
      expect.arrayContaining(["next_chunk", "start_chunk", "chunks_returned", "total_chunks"]),
    );
  });
});

describe("WARP-2203 — a cursor never over-claims", () => {
  /**
   * The AC that matters most: page `read_file` to exhaustion THROUGH the
   * bounding step and reconstruct the source EXACTLY. This drives the real
   * tools-core handler, serializes it the way mcp-server does, and pushes each
   * page through `runAgent`, then follows the `next_offset` the MODEL sees.
   */
  it("pages read_file to exhaustion through the bounding step with no skipped range", async () => {
    const source = Array.from({ length: 2600 }, (_, i) => `line ${i} of the source document`).join("\n");
    const readFile = getTool("read_file")!;

    const ctx = {
      http: {
        nextcloud: {
          get: vi.fn().mockImplementation(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => "text/plain; charset=utf-8" },
            text: async () => source,
            arrayBuffer: async () => new TextEncoder().encode(source).buffer,
          })),
          post: vi.fn(),
          patch: vi.fn(),
          delete: vi.fn(),
        },
      },
      userId: "alice",
      ncToken: "tok",
      signal: new AbortController().signal,
    } as unknown as ToolContext;

    let offset: number | null = 0;
    let rebuilt = "";
    let pages = 0;
    while (offset !== null) {
      pages++;
      expect(pages).toBeLessThan(40); // termination guard on the test itself
      const result = await readFile.handler({ path: "/Notes/big.md", offset }, ctx);
      const wire = onTheWire(result).content[0].text;
      const bounded = await boundedToolMessage("read_file", wire);

      expect(bounded.length).toBeLessThanOrEqual(CAP);
      const seen = parses(bounded) as Record<string, unknown>;
      const content = seen.content as string;
      expect(typeof content).toBe("string");
      rebuilt += content;

      const next = seen.next_offset;
      expect(next === null || typeof next === "number").toBe(true);
      if (typeof next === "number") {
        // No skipped range: the next page starts exactly where this one ended.
        expect(next).toBe(offset! + content.length);
      }
      offset = next as number | null;
    }

    expect(pages).toBeGreaterThan(1);
    expect(rebuilt).toBe(source);
  });

  it("recomputes a numeric next_offset from the delivered content", async () => {
    const wire = JSON.stringify({
      path: "/Notes/Q3.md",
      content: "A".repeat(10000),
      offset: 4000,
      truncated: true,
      next_offset: 14000,
      bytes_total: 90000,
      chars_total: 90000,
    });
    const parsed = parses(await boundedToolMessage("read_file", wire)) as Record<string, unknown>;
    expect(parsed.next_offset).toBe(4000 + (parsed.content as string).length);
  });

  it("recomputes a NULL next_offset rather than leaving 'exhausted' standing", async () => {
    // Last page of a 25000-char file: `next_offset: null` means "you have it
    // all". Cut the content and that claim becomes a lie, and the model stops
    // paging one page short.
    const wire = JSON.stringify({
      path: "/Notes/Q3.md",
      content: "A".repeat(9400),
      offset: 15600,
      truncated: false,
      next_offset: null,
      bytes_total: 25000,
      chars_total: 25000,
    });
    const parsed = parses(await boundedToolMessage("read_file", wire)) as Record<string, unknown>;
    expect(parsed.next_offset).toBe(15600 + (parsed.content as string).length);
    expect(parsed.next_offset).not.toBeNull();
  });

  it("deletes a cursor it cannot recompute rather than shortening the body beside it", async () => {
    // Chunk indices and character lengths are different units — there is no
    // arithmetic that turns a shortened `text` into a correct `next_chunk`.
    const wire = JSON.stringify({
      type: "read_document_text",
      path: "/Docs/x.pdf",
      text: "T".repeat(12000),
      chunks_returned: 6,
      start_chunk: 0,
      next_chunk: 7,
      total_chunks: 40,
    });
    const parsed = parses(await boundedToolMessage("read_document_text", wire)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("next_chunk");
  });

  it("deletes cursors at every DEPTH, not just the root", async () => {
    const wire = JSON.stringify({
      groups: [
        { label: "a", items: Array.from({ length: 300 }, (_, i) => `item-${i}`), nextCursor: "abc" },
      ],
      body: "B".repeat(9000),
    });
    const parsed = parses(await boundedToolMessage("search_content", wire)) as Record<string, unknown>;
    const group = (parsed.groups as Record<string, unknown>[])[0];
    expect(group).not.toHaveProperty("nextCursor");
    // Deletion is depth-agnostic; RECOMPUTE stays root-level, because the
    // `cursor = base + delivered` identity is only checkable against siblings
    // the root actually publishes. So a nested cursor is always deleted — and
    // the marker says which, at the root, where the model will read it.
    expect((parsed._orchestrator_truncation as Record<string, unknown>).removed_keys).toContain(
      "nextCursor",
    );
  });

  it("matches cursor keys EXACTLY — `next_weekday` is a value, not a cursor", async () => {
    const wire = JSON.stringify({
      next_weekday: "2026-09-01",
      notes: "N".repeat(12000),
    });
    const parsed = parses(await boundedToolMessage("get_current_datetime", wire)) as Record<string, unknown>;
    expect(parsed.next_weekday).toBe("2026-09-01");
  });
});

describe("WARP-2203 — B3: a delivered count must not survive as a falsehood", () => {
  it("removes a sibling scalar that equalled the pre-reduction collection length", async () => {
    const wire = JSON.stringify({
      files: Array.from({ length: 300 }, (_, i) => ({ name: `f-${i}.md`, path: `/some/dir/f-${i}.md` })),
      count: 300,
    });
    const parsed = parses(await boundedToolMessage("list_files", wire)) as Record<string, unknown>;
    const files = parsed.files as unknown[];
    expect(files.length).toBeLessThan(300);
    // `count` is defined by every producer as the length of the array in the
    // SAME payload — not "how many the tool found". Leaving 300 beside 40
    // delivered rows is a claim the model will believe.
    expect(parsed.count === undefined || parsed.count === files.length).toBe(true);
    expect(parsed.count).not.toBe(300);
  });

  it("does not rewrite a corpus total into a delivered count", async () => {
    // `chars_total` legitimately equals `content.length` on a single-page
    // read. Rewriting it to the shortened length would be a NEW falsehood
    // about the file, so it is removed instead.
    const wire = JSON.stringify({
      path: "/a.md",
      content: "A".repeat(9000),
      offset: 0,
      truncated: false,
      next_offset: null,
      bytes_total: 9000,
      chars_total: 9000,
    });
    const parsed = parses(await boundedToolMessage("read_file", wire)) as Record<string, unknown>;
    expect(parsed.chars_total).not.toBe((parsed.content as string).length);
  });
});

describe("WARP-2203 — completeness flags cannot outlive the body they describe", () => {
  it("drops summarize_file's `truncated` flag when the summary itself was cut", async () => {
    const wire = JSON.stringify({
      path: "/Notes/Q3.md",
      summary: "S".repeat(12000),
      truncated: false,
    });
    const parsed = parses(await boundedToolMessage("summarize_file", wire)) as Record<string, unknown>;
    // `truncated: false` referred to the INPUT the summarizer saw. Beside a cut
    // summary the model reads it as "this summary is complete".
    expect(parsed).not.toHaveProperty("truncated");
  });

  it("drops a `complete: true` sibling", async () => {
    const wire = JSON.stringify({ report: "R".repeat(12000), complete: true });
    const parsed = parses(await boundedToolMessage("get_profile", wire)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("complete");
  });
});

describe("WARP-2203 — B2: the loop terminates and never grows the output", () => {
  it("never returns more characters than it was given", async () => {
    const payloads = [
      JSON.stringify({ a: "x".repeat(9000) }),
      JSON.stringify(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, `v${i}`]))),
      JSON.stringify(Array.from({ length: 900 }, (_, i) => i)),
      JSON.stringify({ nested: { deep: { deeper: { s: "z".repeat(20000) } } } }),
      JSON.stringify(Array.from({ length: 60 }, () => ({ s: "q".repeat(300) }))),
    ];
    for (const wire of payloads) {
      const out = await boundedToolMessage("list_files", wire);
      expect(out.length).toBeLessThanOrEqual(Math.max(wire.length, CAP));
      expect(out.length).toBeLessThanOrEqual(CAP);
      parses(out);
    }
  });

  it("terminates on a payload made only of many small irreducible strings", async () => {
    // 400 keys × ~20 chars. No single reduction site is large enough to pay
    // for its own `reductions[]` entry, which is exactly the shape that made
    // the naive loop grow the output instead of shrinking it.
    const wire = JSON.stringify(
      Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`key_${i}`, `value_${i}_padding`])),
    );
    expect(wire.length).toBeGreaterThan(CAP);
    const out = await boundedToolMessage("list_files", wire);
    expect(out.length).toBeLessThanOrEqual(CAP);
    parses(out);
  });
});

describe("WARP-2203 — multi-byte and astral characters at the cut boundary", () => {
  it("never emits a lone surrogate half", async () => {
    // "🙂" is a surrogate PAIR in UTF-16. Cutting between the halves leaves a
    // lone surrogate that becomes U+FFFD the moment anything UTF-8-encodes it.
    const wire = JSON.stringify({ path: "/e.md", content: "🙂".repeat(6000) });
    const out = await boundedToolMessage("read_file", wire);
    const parsed = parses(out) as Record<string, unknown>;
    const content = parsed.content as string;
    for (let i = 0; i < content.length; i++) {
      const c = content.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const lo = content.charCodeAt(i + 1);
        expect(lo >= 0xdc00 && lo <= 0xdfff).toBe(true);
        i++;
      } else {
        expect(c >= 0xdc00 && c <= 0xdfff).toBe(false);
      }
    }
    expect(content).not.toContain("�");
    // Round-trips through UTF-8 with no loss.
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
  });

  it("never splits a pair AT ANY cut offset — swept, not sampled", async () => {
    // A single astral payload proves nothing: whether the chosen cut lands
    // between the halves depends on the PARITY of the offset the search picks,
    // and one sample lands even half the time. Shifting an ASCII prefix by one
    // character shifts the cut by one, so this sweep walks the boundary across
    // both parities and the guard has to hold on every one of them.
    for (let pad = 0; pad < 24; pad++) {
      const wire = JSON.stringify({ p: "x".repeat(pad), content: "🙂".repeat(6000) });
      const parsed = parses(await boundedToolMessage("read_file", wire)) as Record<string, unknown>;
      const content = parsed.content as string;
      expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
      expect(content.length % 2).toBe(0);
    }
  });

  it("stays under the cap when the payload is multi-byte", async () => {
    // The cap counts CHARACTERS; a CJK page is 3 bytes per character. The
    // measured quantity must still be the emitted string's length.
    const wire = JSON.stringify({ path: "/cn.md", content: "測".repeat(9000) });
    const out = await boundedToolMessage("read_file", wire);
    expect(out.length).toBeLessThanOrEqual(CAP);
    parses(out);
  });

  it("does not split a combining sequence's base from a surrogate pair", async () => {
    const wire = JSON.stringify({ path: "/e.md", content: "a🙂".repeat(5000) });
    const parsed = parses(await boundedToolMessage("read_file", wire)) as Record<string, unknown>;
    expect(Buffer.from(parsed.content as string, "utf8").toString("utf8")).toBe(parsed.content);
  });
});

describe("WARP-2203 — refusal is a LAST resort, and it is logged", () => {
  it("logs agent_tool_result_refused with the operator's correlation keys", async () => {
    // A payload that cannot be reduced below the cap: hundreds of keys whose
    // NAMES alone exceed it. Nothing here is a reducible site.
    const wire = JSON.stringify(
      Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}_${"n".repeat(24)}`, 1])),
    );
    expect(wire.length).toBeGreaterThan(CAP);
    const out = await boundedToolMessage("list_files", wire);
    expect(out.length).toBeLessThanOrEqual(CAP);
    parses(out);

    const refusals = logged.filter((l) => l.msg === "agent_tool_result_refused");
    expect(refusals).toHaveLength(1);
    // The SSE event already told the dashboard `ok: true` and the trace holds
    // the FULL payload — without this line an operator reading the trace and a
    // model reading the history are looking at different turns with no way to
    // tell.
    expect(refusals[0].obj).toMatchObject({
      tool: "list_files",
      tool_call_id: "call_1",
      iter: 0,
      input_chars: wire.length,
    });
    expect(refusals[0].obj.turn_id).toEqual(expect.any(String));
    expect(refusals[0].obj.reason).toEqual(expect.any(String));
  });

  it("does not log a refusal when the payload was successfully reduced", async () => {
    const wire = JSON.stringify({ path: "/a.md", content: "A".repeat(12000) });
    await boundedToolMessage("read_file", wire);
    expect(logged.filter((l) => l.msg === "agent_tool_result_refused")).toHaveLength(0);
  });
});

describe("WARP-2203 — the recompute cannot invent a base (QA counterexamples)", () => {
  it("deletes rather than infer a base from integers that merely add up", async () => {
    // Reproduced on the orchestrator path because that is where the lie would
    // be told. Before the published-base rule this emitted
    // `next_offset: 10379` beside 7,379 delivered characters — 3,000 past the
    // end of the body the model was handed.
    const wire = JSON.stringify({
      path: "/a.md",
      content: "A".repeat(9000),
      offset: 0,
      next_offset: null,
      a: 3000,
      b: 12000,
    });
    const out = await boundedToolMessage("read_file", wire);
    const parsed = parses(out) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("next_offset");
    expect(out).not.toContain("10379");
    expect(out.length).toBeLessThanOrEqual(CAP);
  });

  it("deletes rather than recompute when a second body could own the cursor", async () => {
    // `next_offset - offset === sidecar.length`, so the arithmetic closes over
    // the WRONG body. `content` was delivered in full; resuming at 4365 would
    // have skipped characters 3000-4364 of it.
    const wire = JSON.stringify({
      path: "/a.md",
      content: "C".repeat(3000),
      sidecar: "S".repeat(9000),
      offset: 0,
      next_offset: 9000,
      chars_total: 40000,
    });
    const out = await boundedToolMessage("read_file", wire);
    const parsed = parses(out) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("next_offset");
    expect(parsed.content).toBe("C".repeat(3000));
    expect(out).not.toContain("4365");
  });
});
