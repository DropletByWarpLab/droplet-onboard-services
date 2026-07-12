/**
 * WARP-899 — `decode_text`. Tier-1 read, pure computation, no ToolContext
 * dependencies.
 */
import { describe, it, expect } from "vitest";
import decodeText from "../../../src/handlers/data/decode-text.js";
import encodeText from "../../../src/handlers/data/encode-text.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

describe("decode_text — known vectors", () => {
  it("decodes base64", async () => {
    const res = await decodeText.handler({ text: "aGVsbG8=", encoding: "base64" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { decoded: string }).decoded).toBe("hello");
  });

  it("decodes base64url (no padding)", async () => {
    const res = await decodeText.handler({ text: "Pj4", encoding: "base64url" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { decoded: string }).decoded).toBe(">>");
  });

  it("decodes hex", async () => {
    const res = await decodeText.handler({ text: "68656c6c6f", encoding: "hex" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { decoded: string }).decoded).toBe("hello");
  });

  it("decodes url (percent-encoding)", async () => {
    const res = await decodeText.handler({ text: "a%20b%26c", encoding: "url" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { decoded: string }).decoded).toBe("a b&c");
  });
});

describe("decode_text — round-trips with encode_text", () => {
  const samples = ["Hello, Droplet!", "unicode: café ☕", "", "line1\nline2\ttab"];
  const encodings = ["base64", "base64url", "hex", "url"] as const;

  for (const encoding of encodings) {
    for (const sample of samples) {
      it(`round-trips ${JSON.stringify(sample)} through ${encoding}`, async () => {
        const encoded = await encodeText.handler({ text: sample, encoding }, ctx);
        expect(encoded.ok).toBe(true);
        if (!encoded.ok) return;
        const decoded = await decodeText.handler(
          { text: (encoded.data as { encoded: string }).encoded, encoding },
          ctx,
        );
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect((decoded.data as { decoded: string }).decoded).toBe(sample);
      });
    }
  }
});

describe("decode_text — error handling", () => {
  it("rejects missing text", async () => {
    const res = await decodeText.handler({ encoding: "base64" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects an unknown encoding", async () => {
    const res = await decodeText.handler({ text: "aGk=", encoding: "rot13" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ENCODING");
  });

  it("rejects text over the size cap", async () => {
    const res = await decodeText.handler({ text: "a".repeat(10_001), encoding: "hex" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("TEXT_TOO_LONG");
  });

  it("rejects malformed base64 instead of silently truncating", async () => {
    const res = await decodeText.handler({ text: "not valid base64!!", encoding: "base64" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("DECODE_FAILED");
  });

  it("rejects malformed hex (odd length / non-hex chars)", async () => {
    const res = await decodeText.handler({ text: "zz", encoding: "hex" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("DECODE_FAILED");
  });

  it("rejects malformed url encoding (bad percent escape)", async () => {
    const res = await decodeText.handler({ text: "%zz", encoding: "url" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("DECODE_FAILED");
  });
});

describe("decode_text — tool metadata", () => {
  it("is named decode_text and is Tier-1 (no write, no confirm)", () => {
    expect(decodeText.name).toBe("decode_text");
    expect(decodeText.requiresWrite).toBe(false);
    expect(decodeText.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect((decodeText.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
