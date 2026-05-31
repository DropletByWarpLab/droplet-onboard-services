/**
 * WARP-555: read-only tool catalog metadata.
 *
 * The dashboard `/tools` surface renders every built-in tool grouped by
 * domain, with `requiresWrite` / `requiresConfirmation` badges. The wire
 * shape it needs (domain + the two safety flags) is not on the JSON-RPC
 * `tools/list` response, so `tools-core` exposes a `TOOL_CATALOG` that
 * layers a `domain` onto each registered tool.
 *
 * The non-negotiable invariant these tests pin: the catalog is derived
 * from the canonical `TOOLS` registry, so it can never silently drift
 * out of sync when a tool is added to `registry.ts`. `name`,
 * `description`, `requiresWrite`, and `requiresConfirmation` are read off
 * the live `Tool` object — only `domain` is new metadata.
 */

import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/registry.js";
import { TOOL_CATALOG, TOOL_DOMAINS, type ToolCatalogEntry } from "../src/catalog.js";

describe("TOOL_CATALOG (WARP-555)", () => {
  it("has exactly one catalog entry per registered tool", () => {
    expect(TOOL_CATALOG.length).toBe(TOOLS.size);
    const catalogNames = new Set(TOOL_CATALOG.map((t) => t.name));
    expect(catalogNames.size).toBe(TOOL_CATALOG.length); // no duplicates
    for (const name of TOOLS.keys()) {
      expect(catalogNames.has(name)).toBe(true);
    }
  });

  it("reads name/description/flags straight off the live Tool (no drift)", () => {
    for (const entry of TOOL_CATALOG) {
      const tool = TOOLS.get(entry.name);
      expect(tool, `catalog tool ${entry.name} must be registered`).toBeDefined();
      expect(entry.description).toBe(tool!.description);
      expect(entry.requiresWrite).toBe(tool!.requiresWrite);
      expect(entry.requiresConfirmation).toBe(tool!.requiresConfirmation);
    }
  });

  it("assigns every tool a non-empty domain drawn from TOOL_DOMAINS", () => {
    const known = new Set(TOOL_DOMAINS);
    for (const entry of TOOL_CATALOG) {
      expect(entry.domain, `${entry.name} needs a domain`).toBeTruthy();
      expect(known.has(entry.domain)).toBe(true);
    }
  });

  it("lists domains in a stable, de-duplicated order", () => {
    expect(new Set(TOOL_DOMAINS).size).toBe(TOOL_DOMAINS.length);
    // network is the first surface in the IA; pin it so the filter order
    // doesn't reshuffle under the user without a test catching it.
    expect(TOOL_DOMAINS[0]).toBe("network");
    // every domain in the list is actually used by at least one tool
    const used = new Set(TOOL_CATALOG.map((t) => t.domain));
    for (const d of TOOL_DOMAINS) {
      expect(used.has(d), `domain ${d} is declared but unused`).toBe(true);
    }
  });

  it("classifies known anchor tools into the expected domain", () => {
    const byName = new Map<string, ToolCatalogEntry>(
      TOOL_CATALOG.map((t) => [t.name, t]),
    );
    expect(byName.get("list_network_devices")?.domain).toBe("network");
    expect(byName.get("list_files")?.domain).toBe("files");
    expect(byName.get("list_cameras")?.domain).toBe("cameras");
    expect(byName.get("run_scene")?.domain).toBe("smart-home");
    expect(byName.get("email_search")?.domain).toBe("email");
    expect(byName.get("memory_recall")?.domain).toBe("memory");
    expect(byName.get("pm_list_projects")?.domain).toBe("pm");
    expect(byName.get("get_system_health")?.domain).toBe("system");
  });

  it("marks a destructive tool as write + confirm and a read tool as neither", () => {
    const byName = new Map(TOOL_CATALOG.map((t) => [t.name, t]));
    const block = byName.get("block_network_device");
    expect(block?.requiresWrite).toBe(true);
    expect(block?.requiresConfirmation).toBe(true);

    const list = byName.get("list_network_devices");
    expect(list?.requiresWrite).toBe(false);
    expect(list?.requiresConfirmation).toBe(false);
  });
});
