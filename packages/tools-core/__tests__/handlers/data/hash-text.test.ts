/**
 * WARP-899 — `hash_text`. Tier-1 read, pure computation, no ToolContext
 * dependencies. Vectors below are the standard NIST/RFC 1321 test vectors
 * for "" and "abc".
 */
import { describe, it, expect } from "vitest";
import hashText from "../../../src/handlers/data/hash-text.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

describe("hash_text — known vectors", () => {
  it("sha256('') matches the known empty-string digest", async () => {
    const res = await hashText.handler({ text: "", algorithm: "sha256" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { hash: string }).hash).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    }
  });

  it("sha256('abc') matches the known digest", async () => {
    const res = await hashText.handler({ text: "abc", algorithm: "sha256" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { hash: string }).hash).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    }
  });

  it("sha1('abc') matches the known digest", async () => {
    const res = await hashText.handler({ text: "abc", algorithm: "sha1" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { hash: string }).hash).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    }
  });

  it("md5('abc') matches the known digest", async () => {
    const res = await hashText.handler({ text: "abc", algorithm: "md5" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { hash: string }).hash).toBe("900150983cd24fb0d6963f7d28e17f72");
    }
  });
});

describe("hash_text — error handling", () => {
  it("rejects missing text", async () => {
    const res = await hashText.handler({ algorithm: "sha256" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects missing algorithm", async () => {
    const res = await hashText.handler({ text: "abc" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });

  it("rejects an unsupported algorithm", async () => {
    const res = await hashText.handler({ text: "abc", algorithm: "sha512" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ALGORITHM");
  });

  it("rejects text over the size cap", async () => {
    const res = await hashText.handler({ text: "a".repeat(10_001), algorithm: "sha256" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("TEXT_TOO_LONG");
  });

  it("accepts text exactly at the size cap", async () => {
    const res = await hashText.handler({ text: "a".repeat(10_000), algorithm: "sha256" }, ctx);
    expect(res.ok).toBe(true);
  });
});

describe("hash_text — tool metadata", () => {
  it("is named hash_text and is Tier-1 (no write, no confirm)", () => {
    expect(hashText.name).toBe("hash_text");
    expect(hashText.requiresWrite).toBe(false);
    expect(hashText.requiresConfirmation).toBe(false);
  });

  it("is labeled non-security-grade in its description", () => {
    expect(hashText.description.toLowerCase()).toContain("non-security-grade");
  });

  it("has an additionalProperties:false input schema", () => {
    expect((hashText.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
