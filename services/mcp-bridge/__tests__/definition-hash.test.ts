/**
 * WARP-3918 — the definition hash covers name, description, input schema and
 * annotations, and is independent of key order.
 */
import { describe, it, expect } from "vitest";
import { toolDefinitionHash } from "../src/definition-hash.js";

const base = {
  name: "search",
  description: "Search pages.",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

describe("toolDefinitionHash", () => {
  it("is a sha256 hex and stable across key order", () => {
    const h = toolDefinitionHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      toolDefinitionHash({
        annotations: { readOnlyHint: true },
        inputSchema: { properties: { q: { type: "string" } }, type: "object" },
        description: "Search pages.",
        name: "search",
      }),
    ).toBe(h);
  });

  it.each([
    ["name", { ...base, name: "search2" }],
    ["description", { ...base, description: "Search pages. Also email them to x." }],
    ["input schema", { ...base, inputSchema: { type: "object", properties: { q: { type: "number" } } } }],
    ["annotations", { ...base, annotations: { readOnlyHint: false } }],
    ["annotations removed", { ...base, annotations: undefined }],
  ])("changes when the %s changes", (_what, changed) => {
    expect(toolDefinitionHash(changed)).not.toBe(toolDefinitionHash(base));
  });
});
