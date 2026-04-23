import { describe, it, expect } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  RpcCode,
  parseJsonRpcRequest,
  rpcError,
  rpcSuccess,
  wrapToolResult,
} from "../services/mcp-protocol.js";

describe("parseJsonRpcRequest", () => {
  it("accepts a well-formed request", () => {
    const r = parseJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect("error" in r).toBe(false);
    expect((r as any).method).toBe("tools/list");
  });

  it("preserves params when present", () => {
    const r = parseJsonRpcRequest({
      jsonrpc: "2.0", id: "abc", method: "tools/call", params: { name: "x" },
    });
    expect((r as any).params).toEqual({ name: "x" });
    expect((r as any).id).toBe("abc");
  });

  it("rejects non-object input", () => {
    for (const bad of [null, "string", 42, [1, 2]]) {
      const r = parseJsonRpcRequest(bad);
      expect("error" in r).toBe(true);
      expect((r as any).error.code).toBe(RpcCode.INVALID_REQUEST);
    }
  });

  it("rejects wrong jsonrpc version", () => {
    const r = parseJsonRpcRequest({ jsonrpc: "1.0", id: 1, method: "x" });
    expect("error" in r).toBe(true);
    expect((r as any).error.message).toMatch(/jsonrpc/);
  });

  it("rejects missing or empty method", () => {
    const r1 = parseJsonRpcRequest({ jsonrpc: "2.0", id: 1 });
    expect("error" in r1).toBe(true);
    const r2 = parseJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "" });
    expect("error" in r2).toBe(true);
  });

  it("rejects missing id (we don't support notifications in v1)", () => {
    const r = parseJsonRpcRequest({ jsonrpc: "2.0", method: "ping" });
    expect("error" in r).toBe(true);
    expect((r as any).error.message).toMatch(/id/);
  });

  it("preserves the id (or null when invalid) in the error response", () => {
    // Valid id type — preserved
    const r1 = parseJsonRpcRequest({ jsonrpc: "1.0", id: 42, method: "x" });
    expect((r1 as any).id).toBe(42);
    // Invalid id type — null
    const r2 = parseJsonRpcRequest({ jsonrpc: "2.0", id: { weird: 1 }, method: "x" });
    expect((r2 as any).id).toBe(null);
  });
});

describe("rpcSuccess / rpcError", () => {
  it("rpcSuccess shape", () => {
    expect(rpcSuccess(7, { ok: true })).toEqual({
      jsonrpc: "2.0", id: 7, result: { ok: true },
    });
  });
  it("rpcError shape with data", () => {
    expect(rpcError("x", -1, "boom", { extra: 1 })).toEqual({
      jsonrpc: "2.0", id: "x", error: { code: -1, message: "boom", data: { extra: 1 } },
    });
  });
  it("rpcError omits data field when not provided", () => {
    expect(rpcError("x", -1, "boom")).toEqual({
      jsonrpc: "2.0", id: "x", error: { code: -1, message: "boom" },
    });
  });
});

describe("wrapToolResult", () => {
  it("string passthrough", () => {
    const r = wrapToolResult("hello");
    expect(r.content[0]).toEqual({ type: "text", text: "hello" });
    expect(r.isError).toBeUndefined();
  });
  it("JSON-stringifies objects", () => {
    const r = wrapToolResult({ a: 1, b: "two" });
    expect(JSON.parse(r.content[0].text)).toEqual({ a: 1, b: "two" });
  });
  it("marks isError when requested", () => {
    const r = wrapToolResult({ error: "nope" }, true);
    expect(r.isError).toBe(true);
  });
  it("falls back to String() for unserializable values", () => {
    // Circular ref forces JSON.stringify to throw
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const r = wrapToolResult(cyclic);
    expect(r.content[0].text).toMatch(/object/i);
  });
});

describe("MCP_PROTOCOL_VERSION", () => {
  it("matches the published spec date format", () => {
    expect(MCP_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
