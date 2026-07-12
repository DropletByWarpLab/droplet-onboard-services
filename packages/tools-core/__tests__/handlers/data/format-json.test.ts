/**
 * WARP-900 — `format_json`. Tier-1 read, pure computation, no ToolContext
 * dependencies.
 */
import { describe, it, expect } from "vitest";
import formatJson from "../../../src/handlers/data/format-json.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

describe("format_json — pretty mode", () => {
  it("pretty-prints with the default 2-space indent", async () => {
    const res = await formatJson.handler({ input: '{"a":1,"b":[1,2]}', mode: "pretty" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { output: string }).output).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    }
  });

  it("respects a custom indent", async () => {
    const res = await formatJson.handler({ input: '{"a":1}', mode: "pretty", indent: 4 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { output: string }).output).toBe('{\n    "a": 1\n}');
  });

  it("clamps an out-of-range indent into [1,8]", async () => {
    const res = await formatJson.handler({ input: '{"a":1}', mode: "pretty", indent: 99 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { output: string }).output).toBe('{\n        "a": 1\n}');
  });
});

describe("format_json — minify mode", () => {
  it("strips all insignificant whitespace", async () => {
    const res = await formatJson.handler(
      { input: '{\n  "a": 1,\n  "b": [1, 2]\n}', mode: "minify" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { output: string }).output).toBe('{"a":1,"b":[1,2]}');
  });
});

describe("format_json — pretty/minify round-trip preserves the value", () => {
  it("minify(pretty(x)) parses back to the same value as x", async () => {
    const original = { z: 1, a: [1, "two", null, { nested: true }] };
    const pretty = await formatJson.handler({ input: JSON.stringify(original), mode: "pretty" }, ctx);
    expect(pretty.ok).toBe(true);
    if (!pretty.ok) return;
    const minified = await formatJson.handler(
      { input: (pretty.data as { output: string }).output, mode: "minify" },
      ctx,
    );
    expect(minified.ok).toBe(true);
    if (minified.ok) {
      expect(JSON.parse((minified.data as { output: string }).output)).toEqual(original);
    }
  });
});

describe("format_json — error handling", () => {
  it("rejects missing input", async () => {
    const res = await formatJson.handler({ mode: "pretty" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects missing mode", async () => {
    const res = await formatJson.handler({ input: "{}" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects an unknown mode", async () => {
    const res = await formatJson.handler({ input: "{}", mode: "compact" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_MODE");
  });

  it("rejects malformed JSON", async () => {
    const res = await formatJson.handler({ input: "{not json", mode: "pretty" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PARSE_FAILED");
  });

  it("rejects input over the size cap", async () => {
    const res = await formatJson.handler({ input: `[${"1,".repeat(10_001)}1]`, mode: "minify" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INPUT_TOO_LONG");
  });
});

describe("format_json — tool metadata", () => {
  it("is named format_json and is Tier-1 (no write, no confirm)", () => {
    expect(formatJson.name).toBe("format_json");
    expect(formatJson.requiresWrite).toBe(false);
    expect(formatJson.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect((formatJson.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
