import { describe, it, expect } from "vitest";
import {
  newRequestId,
  sanitizeRequestId,
  getRequestId,
  runWithRequestId,
} from "../lib/request-context.js";

describe("request-context", () => {
  it("newRequestId returns a v4 uuid string", () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sanitizeRequestId accepts valid ids and rejects junk", () => {
    expect(sanitizeRequestId(newRequestId())).toBeTypeOf("string");
    expect(sanitizeRequestId("abc123_-Z9")).toBe("abc123_-Z9");
    expect(sanitizeRequestId("short")).toBeUndefined(); // < 8 chars
    expect(sanitizeRequestId("has space")).toBeUndefined();
    expect(sanitizeRequestId("bad\nnewline")).toBeUndefined();
    expect(sanitizeRequestId("x".repeat(65))).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
  });

  it("getRequestId is undefined outside a context and set inside", () => {
    expect(getRequestId()).toBeUndefined();
    const out = runWithRequestId("test-id-123", () => getRequestId());
    expect(out).toBe("test-id-123");
    expect(getRequestId()).toBeUndefined();
  });

  it("propagates across awaits", async () => {
    const seen = await runWithRequestId("async-id-1", async () => {
      await Promise.resolve();
      return getRequestId();
    });
    expect(seen).toBe("async-id-1");
  });
});
