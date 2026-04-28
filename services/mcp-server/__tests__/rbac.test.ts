import { describe, it, expect } from "vitest";
import { filterToolsForRole, canCallTool } from "../src/rbac.js";
import type { Tool } from "@droplet/tools-core";

function fakeTool(name: string, requiresWrite = false): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    requiresWrite,
    requiresConfirmation: false,
    handler: async () => ({ ok: true, data: null }),
  };
}

describe("filterToolsForRole", () => {
  const all = [fakeTool("read_one"), fakeTool("write_one", true)];

  it("admin sees both", () => {
    expect(filterToolsForRole(all, "admin").map((t) => t.name)).toEqual([
      "read_one",
      "write_one",
    ]);
  });

  it("owner sees both", () => {
    expect(filterToolsForRole(all, "owner").map((t) => t.name)).toEqual([
      "read_one",
      "write_one",
    ]);
  });

  it("family sees read-only", () => {
    expect(filterToolsForRole(all, "family").map((t) => t.name)).toEqual([
      "read_one",
    ]);
  });

  it("guest sees read-only", () => {
    expect(filterToolsForRole(all, "guest").map((t) => t.name)).toEqual([
      "read_one",
    ]);
  });

  it("undefined role (stdio in-process) sees both — fully trusted", () => {
    expect(filterToolsForRole(all, undefined).map((t) => t.name)).toEqual([
      "read_one",
      "write_one",
    ]);
  });

  it("accepts an Iterable from TOOLS.values()", () => {
    const map = new Map(all.map((t) => [t.name, t]));
    expect(filterToolsForRole(map.values(), "family").map((t) => t.name)).toEqual([
      "read_one",
    ]);
  });
});

describe("canCallTool", () => {
  it("denies write to family", () => {
    expect(canCallTool(fakeTool("w", true), "family")).toBe(false);
  });
  it("denies write to guest", () => {
    expect(canCallTool(fakeTool("w", true), "guest")).toBe(false);
  });
  it("allows write to admin", () => {
    expect(canCallTool(fakeTool("w", true), "admin")).toBe(true);
  });
  it("allows write to owner", () => {
    expect(canCallTool(fakeTool("w", true), "owner")).toBe(true);
  });
  it("allows read to guest", () => {
    expect(canCallTool(fakeTool("r"), "guest")).toBe(true);
  });
  it("allows write to undefined role (stdio)", () => {
    expect(canCallTool(fakeTool("w", true), undefined)).toBe(true);
  });
});
