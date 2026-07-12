/**
 * WARP-899 — `encode_text`. Tier-1 read, pure computation, no ToolContext
 * dependencies.
 */
import { describe, it, expect } from "vitest";
import encodeText from "../../../src/handlers/data/encode-text.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

describe("encode_text — known vectors", () => {
  it("encodes base64", async () => {
    const res = await encodeText.handler({ text: "hello", encoding: "base64" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { encoded: string }).encoded).toBe("aGVsbG8=");
  });

  it("encodes base64url (no padding, url-safe alphabet)", async () => {
    // ">>" -> base64 "Pj4=" but base64url strips padding and swaps +/ for -_
    const res = await encodeText.handler({ text: ">>", encoding: "base64url" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { encoded: string }).encoded).toBe("Pj4");
  });

  it("encodes hex", async () => {
    const res = await encodeText.handler({ text: "hello", encoding: "hex" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { encoded: string }).encoded).toBe("68656c6c6f");
  });

  it("encodes url (percent-encoding)", async () => {
    const res = await encodeText.handler({ text: "a b&c", encoding: "url" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { encoded: string }).encoded).toBe("a%20b%26c");
  });
});

describe("encode_text — error handling", () => {
  it("rejects missing text", async () => {
    const res = await encodeText.handler({ encoding: "base64" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects missing encoding", async () => {
    const res = await encodeText.handler({ text: "hi" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects an unknown encoding", async () => {
    const res = await encodeText.handler({ text: "hi", encoding: "rot13" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ENCODING");
  });

  it("rejects text over the size cap", async () => {
    const res = await encodeText.handler({ text: "a".repeat(10_001), encoding: "base64" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("TEXT_TOO_LONG");
  });

  it("accepts text exactly at the size cap", async () => {
    const res = await encodeText.handler({ text: "a".repeat(10_000), encoding: "hex" }, ctx);
    expect(res.ok).toBe(true);
  });
});

describe("encode_text — tool metadata", () => {
  it("is named encode_text and is Tier-1 (no write, no confirm)", () => {
    expect(encodeText.name).toBe("encode_text");
    expect(encodeText.requiresWrite).toBe(false);
    expect(encodeText.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect((encodeText.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
