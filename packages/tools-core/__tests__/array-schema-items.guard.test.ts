// add-llm-tool:not-a-gate — checks every schema's shape, reads no add-a-tool site; its own failure names the tool and path.

// Every `type: "array"` in a tool schema must say what its items are.
//
// The gpt-oss chat template in Docker Model Runner / llama.cpp renders each
// tool's parameters into the prompt and throws on an array with no `items`.
// It throws for the WHOLE request, so one bad schema anywhere in the
// advertised set 500s every chat turn that advertises it — not just calls to
// that tool. Found live on the bench box 2026-09-28: `create_spreadsheet`'s
// `rows: { items: { type: "array" } }` made any file-related turn return an
// empty stream.

import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/index.js";

function arraysWithoutItems(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => arraysWithoutItems(n, `${path}[${i}]`, out));
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const types = Array.isArray(o.type) ? o.type : [o.type];
  if (types.includes("array") && !("items" in o)) out.push(path || "(root)");
  for (const [k, v] of Object.entries(o)) arraysWithoutItems(v, path ? `${path}.${k}` : k, out);
}

describe("tool schemas: every array declares items", () => {
  it("no tool has an array schema without items", () => {
    const offenders: string[] = [];
    for (const tool of TOOLS.values()) {
      arraysWithoutItems(tool.inputSchema, tool.name, offenders);
    }
    expect(offenders).toEqual([]);
  });
});
