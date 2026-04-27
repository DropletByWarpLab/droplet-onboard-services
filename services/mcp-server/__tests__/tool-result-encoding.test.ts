import { describe, it, expect } from "vitest";
import { toolResultToContent } from "../src/server.js";
import type { ToolResult } from "@droplet/tools-core";

/**
 * `toolResultToContent` is the load-bearing translation between our
 * `ToolResult` ADT and the MCP `tools/call` content+isError envelope.
 *
 * The encoding rule (spec §7.1):
 *   - ok=true                                -> isError: false, text = JSON.stringify(data)
 *   - ok=false, status=error                 -> isError: true,  text = JSON.stringify({status, error})
 *   - ok=false, status=confirmation_required -> isError: false, text = JSON.stringify({status, error})
 *
 * confirmation_required is intentionally NOT a hard error from the model's
 * perspective — it's the expected outcome of calling a destructive tool
 * without prior approval, and the model is supposed to surface the message
 * back to the user verbatim.
 */
describe("toolResultToContent", () => {
  it("ok=true produces isError=false and JSON-stringified data", () => {
    const result: ToolResult = { ok: true, data: { devices: [{ mac: "AA:BB" }] } };
    const out = toolResultToContent(result);
    expect(out.isError).toBe(false);
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text)).toEqual({ devices: [{ mac: "AA:BB" }] });
  });

  it("ok=false status=error produces isError=true with code+message body", () => {
    const result: ToolResult = {
      ok: false,
      status: "error",
      error: { code: "ROUTING_UNAVAILABLE", message: "routing returned 500" },
    };
    const out = toolResultToContent(result);
    expect(out.isError).toBe(true);
    expect(out.content).toHaveLength(1);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.status).toBe("error");
    expect(parsed.error.code).toBe("ROUTING_UNAVAILABLE");
    expect(parsed.error.message).toBe("routing returned 500");
  });

  it("ok=false status=confirmation_required produces isError=false (NOT a hard error)", () => {
    const result: ToolResult = {
      ok: false,
      status: "confirmation_required",
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "Open the dashboard to approve",
        details: { mac: "AA:BB:CC:DD:EE:FF" },
      },
    };
    const out = toolResultToContent(result);
    // The crucial bit — model treats this as a normal tool result it can react to.
    expect(out.isError).toBe(false);
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.status).toBe("confirmation_required");
    expect(parsed.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(parsed.error.message).toBe("Open the dashboard to approve");
    expect(parsed.error.details).toEqual({ mac: "AA:BB:CC:DD:EE:FF" });
  });
});
