/**
 * WARP-2178 — a shortened tool result still lets the next iteration chain.
 *
 * The ticket's risk: "a summary that drops the one id the next iteration
 * needed turns a working run into a confidently wrong one." The reducer
 * already keeps cursors and counts honest (WARP-2203); this pins the OTHER
 * half — the fields a follow-up call is built from are never cut, however
 * long they are, and the cap is a knob rather than a constant.
 *
 *   1. `isIdentifierKey` — exact keys and the conventional suffixes, and
 *      nothing that merely ends in "id".
 *   2. A `list_files` result too large for the cap is shortened, stays valid
 *      JSON, and every surviving `path` is one the tool actually returned,
 *      byte-identical — so the model's next `read_file` dereferences.
 *   3. End to end through `runAgent`: iteration 0 lists 400 files (over the
 *      cap), iteration 1 reads a path taken from the SHORTENED reply the
 *      model received, and the dispatch carries a real path.
 *   4. A long `path` beside a huge `content` — the content is cut, the path
 *      is not.
 *   5. The cap parameter: a lower cap engages the reducer on a payload the
 *      default would pass verbatim; the default is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import {
  boundToolResultForModel,
  isIdentifierKey,
  MODEL_TOOL_RESULT_CAP_CHARS,
  TRUNCATION_MARKER_KEY,
  WRAPPED_VALUE_KEY,
} from "../services/tool-result-bounding.js";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

const listing = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: `/Documents/Projects/2026/Q3/planning/section-${String(i).padStart(3, "0")}-notes-final-v2.docx`,
    name: `section-${String(i).padStart(3, "0")}-notes-final-v2.docx`,
    size: 10_000 + i,
    modified: "2026-09-04T12:00:00Z",
    type: "file",
  }));

describe("WARP-2178 — isIdentifierKey", () => {
  it("matches the exact keys and the conventional suffixes", () => {
    for (const k of ["id", "path", "name", "url", "href", "key", "uuid", "slug", "fileId", "file_id", "sourcePath", "source_path", "apiKey", "nextUrl"]) {
      expect(isIdentifierKey(k), k).toBe(true);
    }
  });
  it("does not match bulk-content keys or words that merely end in 'id'", () => {
    for (const k of ["content", "text", "summary", "body", "paid", "valid", "kid", "next_weekday", "_id", "Id"]) {
      expect(isIdentifierKey(k), k).toBe(false);
    }
  });
});

describe("WARP-2178 — a shortened list_files still chains", () => {
  it("keeps every surviving path byte-identical to one the tool returned", () => {
    const entries = listing(400);
    const text = JSON.stringify(entries);
    expect(text.length).toBeGreaterThan(MODEL_TOOL_RESULT_CAP_CHARS);
    const bounded = boundToolResultForModel(text, "list_files");
    expect(bounded.length).toBeLessThanOrEqual(MODEL_TOOL_RESULT_CAP_CHARS);
    const parsed = JSON.parse(bounded) as Record<string, unknown>;
    expect(parsed[TRUNCATION_MARKER_KEY]).toBeTruthy();
    const survivors = parsed[WRAPPED_VALUE_KEY] as Array<{ path: string }>;
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.length).toBeLessThan(entries.length);
    const originals = new Set(entries.map((e) => e.path));
    for (const s of survivors) expect(originals.has(s.path), s.path).toBe(true);
  });

  it("end to end: the next iteration's read_file carries a path from the shortened reply", async () => {
    const entries = listing(400);
    const originals = new Set(entries.map((e) => e.path));
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      dispatched.push({ name, args });
      if (name === "list_files") {
        return { isError: false, content: [{ type: "text", text: JSON.stringify(entries) }] };
      }
      expect(originals.has(String(args.path))).toBe(true);
      return { isError: false, content: [{ type: "text", text: JSON.stringify({ content: "Q3 notes" }) }] };
    });
    // The "model": lists first, then reads the first path it was actually
    // shown in the (shortened) tool reply, then answers.
    const chat = vi.fn(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
      const toolReplies = req.messages.filter((m) => m.role === "tool");
      let message: unknown;
      if (toolReplies.length === 0) {
        message = {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: '{"path":"/Documents"}' } }],
        };
      } else if (toolReplies.length === 1) {
        const shown = JSON.parse(String(toolReplies[0]!.content)) as Record<string, unknown>;
        const first = (shown[WRAPPED_VALUE_KEY] as Array<{ path: string }>)[0]!;
        message = {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: first.path }) } }],
        };
      } else {
        message = { role: "assistant", content: "Read the first section." };
      }
      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    });
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue(
          ["list_files", "read_file"].map((name) => ({ name, description: "d", inputSchema: {} })),
        ),
        callTool,
      } as never,
      aiGateway: { chat } as never,
    };
    const result = await runAgent(deps, {
      model: "m",
      messages: [{ role: "user", content: "read my Q3 planning notes" }],
      max_iter: 5,
    });
    expect(result.stop_reason).toBe("model_done");
    expect(dispatched.map((d) => d.name)).toEqual(["list_files", "read_file"]);
    expect(originals.has(String(dispatched[1]!.args.path))).toBe(true);
  });

  it("cuts a huge content field but never the path beside it", () => {
    const path = "/Documents/" + "very-long-directory-name/".repeat(8) + "file.txt";
    expect(path.length).toBeGreaterThan(40);
    const text = JSON.stringify({ path, content: "x".repeat(12_000), next_offset: 12_000 });
    const bounded = boundToolResultForModel(text, "read_file");
    const parsed = JSON.parse(bounded) as { path: string; content: string };
    expect(parsed.path).toBe(path);
    expect(parsed.content.length).toBeLessThan(12_000);
  });
});

describe("WARP-2178 — the cap is a knob", () => {
  it("a lower cap engages the reducer where the default passes verbatim", () => {
    const text = JSON.stringify({ content: "y".repeat(3_000) });
    expect(boundToolResultForModel(text, "read_file")).toBe(text);
    const bounded = boundToolResultForModel(text, "read_file", undefined, 2_000);
    expect(bounded).not.toBe(text);
    expect(bounded.length).toBeLessThanOrEqual(2_000);
    expect(JSON.parse(bounded)[TRUNCATION_MARKER_KEY]).toBeTruthy();
  });
});
