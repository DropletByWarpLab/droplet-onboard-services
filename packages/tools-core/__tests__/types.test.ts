import { describe, it, expect } from "vitest";
import type { Tool, ToolContext, ToolResult } from "../src/types.js";

describe("types", () => {
  it("ToolResult.ok=true wraps data", () => {
    const r: ToolResult = { ok: true, data: { foo: "bar" } };
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ foo: "bar" });
  });

  it("ToolResult.ok=false carries error and status", () => {
    const r: ToolResult = {
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
      status: "error",
    };
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.status).toBe("error");
    }
  });

  it("Tool has the required shape", () => {
    const t: Tool = {
      name: "noop",
      description: "does nothing",
      inputSchema: { type: "object", properties: {} },
      requiresWrite: false,
      requiresConfirmation: false,
      handler: async () => ({ ok: true, data: null }),
    };
    expect(t.name).toBe("noop");
  });
});
