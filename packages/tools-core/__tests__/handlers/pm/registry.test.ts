import { describe, expect, it } from "vitest";

import { TOOLS, getTool } from "../../../src/index.js";

/**
 * WARP-510 — MCP registration sanity for the embedded Plane PM tools.
 *
 * The MCP server auto-discovers tools from packages/tools-core's TOOLS
 * map. This suite asserts the 9 PM tools (5 read + 4 write) are
 * registered and tagged correctly for confirmation gating.
 */

const READ_TOOL_NAMES = [
  "pm_list_workspaces",
  "pm_list_projects",
  "pm_list_work_items",
  "pm_get_work_item",
  "pm_search_work_items",
] as const;

const WRITE_TOOL_NAMES = [
  "pm_create_work_item",
  "pm_update_work_item",
  "pm_add_work_item_comment",
  "pm_transition_work_item",
] as const;

describe("WARP-510 — PM tool registry", () => {
  it("registers every PM read tool with requiresWrite=false", () => {
    for (const name of READ_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, `${name} should be registered`).toBeDefined();
      if (!tool) continue;
      expect(tool.requiresWrite, `${name}.requiresWrite`).toBe(false);
      expect(tool.requiresConfirmation, `${name}.requiresConfirmation`).toBe(false);
      expect(TOOLS.has(name)).toBe(true);
    }
  });

  it("registers every PM write tool with requiresWrite=true AND requiresConfirmation=true", () => {
    for (const name of WRITE_TOOL_NAMES) {
      const tool = getTool(name);
      expect(tool, `${name} should be registered`).toBeDefined();
      if (!tool) continue;
      expect(tool.requiresWrite, `${name}.requiresWrite`).toBe(true);
      expect(tool.requiresConfirmation, `${name}.requiresConfirmation`).toBe(true);
      expect(TOOLS.has(name)).toBe(true);
    }
  });

  it("every PM tool has a name with pm_ prefix and a non-empty description", () => {
    const allPmTools = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES];
    for (const name of allPmTools) {
      const tool = getTool(name);
      expect(tool?.name).toMatch(/^pm_/);
      expect(tool?.description?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("WRITE_TOOLS surface — every write tool requires confirmation (rule from architecture-guard §3)", () => {
    // Pull every tool with requiresWrite=true; assert each also requires
    // confirmation. The orchestrator's WRITE_TOOLS set derives from
    // requiresWrite, so a mis-flag here would silently bypass the
    // confirmation prompt — exactly the kind of regression this test
    // exists to catch.
    const offenders: string[] = [];
    for (const [name, tool] of TOOLS) {
      if (!name.startsWith("pm_")) continue;
      if (tool.requiresWrite && !tool.requiresConfirmation) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
