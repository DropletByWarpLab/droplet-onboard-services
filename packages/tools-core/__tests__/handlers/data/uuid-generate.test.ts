/**
 * WARP-901 — `uuid_generate` (RFC 4122 v4 UUIDs). Tier-1 read, pure
 * computation, no ToolContext dependencies.
 */
import { describe, it, expect } from "vitest";
import uuidGenerate from "../../../src/handlers/data/uuid-generate.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("uuid_generate", () => {
  it("generates a single valid v4 UUID by default", async () => {
    const res = await uuidGenerate.handler({}, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { uuids: string[] };
      expect(data.uuids).toHaveLength(1);
      expect(data.uuids[0]).toMatch(UUID_V4);
    }
  });

  it("generates `count` UUIDs, all distinct", async () => {
    const res = await uuidGenerate.handler({ count: 10 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { uuids: string[] };
      expect(data.uuids).toHaveLength(10);
      for (const u of data.uuids) expect(u).toMatch(UUID_V4);
      expect(new Set(data.uuids).size).toBe(10);
    }
  });

  it("clamps count above the max down to 100", async () => {
    const res = await uuidGenerate.handler({ count: 5000 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { uuids: string[] };
      expect(data.uuids).toHaveLength(100);
    }
  });

  it("clamps a non-positive count up to 1", async () => {
    const res = await uuidGenerate.handler({ count: 0 }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { uuids: string[] };
      expect(data.uuids).toHaveLength(1);
    }
  });
});

describe("uuid_generate — tool metadata", () => {
  it("is named uuid_generate and is Tier-1 (no write, no confirm)", () => {
    expect(uuidGenerate.name).toBe("uuid_generate");
    expect(uuidGenerate.requiresWrite).toBe(false);
    expect(uuidGenerate.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect((uuidGenerate.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
