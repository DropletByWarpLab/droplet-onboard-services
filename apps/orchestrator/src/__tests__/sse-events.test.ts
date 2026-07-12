import { describe, it, expect } from "vitest";
import { encodeSSE, type SSEEvent } from "../types/sse-events.js";

describe("encodeSSE", () => {
  it("encodes content_delta", () => {
    const e: SSEEvent = { type: "content_delta", text: "hello" };
    const out = encodeSSE(e);
    expect(out).toContain("event: content_delta");
    expect(out).toContain('data: {"text":"hello"}');
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("encodes tool_call with id, name, args", () => {
    const e: SSEEvent = {
      type: "tool_call",
      id: "c1",
      name: "list_files",
      args: { path: "/" },
    };
    const out = encodeSSE(e);
    expect(out).toContain("event: tool_call");
    expect(out).toContain('"name":"list_files"');
    expect(out).toContain('"id":"c1"');
    expect(out).toContain('"path":"/"');
  });

  it("encodes tool_result with status='confirmation_required' and message", () => {
    const e: SSEEvent = {
      type: "tool_result",
      id: "c2",
      ok: false,
      status: "confirmation_required",
      message: "Open the dashboard to approve",
    };
    const out = encodeSSE(e);
    expect(out).toContain("event: tool_result");
    expect(out).toContain('"status":"confirmation_required"');
    expect(out).toContain('"ok":false');
    expect(out).toContain('"message":"Open the dashboard to approve"');
  });

  it("encodes done with iterations + stop_reason", () => {
    const e: SSEEvent = { type: "done", iterations: 3, stop_reason: "model_done" };
    const out = encodeSSE(e);
    expect(out).toContain("event: done");
    expect(out).toContain('"iterations":3');
    expect(out).toContain('"stop_reason":"model_done"');
  });

  it("encodes model_loading with model + sizeGb (WARP-903)", () => {
    const e: SSEEvent = {
      type: "model_loading",
      model: "gpt-oss:20b",
      sizeGb: 13.8,
    };
    const out = encodeSSE(e);
    expect(out).toContain("event: model_loading");
    expect(out).toContain('"model":"gpt-oss:20b"');
    expect(out).toContain('"sizeGb":13.8');
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("encodes model_loading with a null sizeGb (size unreported)", () => {
    const e: SSEEvent = { type: "model_loading", model: "qwen3", sizeGb: null };
    const out = encodeSSE(e);
    expect(out).toContain("event: model_loading");
    expect(out).toContain('"sizeGb":null');
  });
});
