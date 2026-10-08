// add-llm-tool:not-a-gate — pins the connections family's registration (names, domain, tiers, copy)
// for WARP-3904; the drift gates for the registry, catalog and route manifest live in their own files.

/**
 * WARP-3904 — the three connect-from-chat tools are registered, classified and
 * routed.
 *
 * Reachability from chat is decided in two layers, and only the first is this
 * package's: the tool's DOMAIN (catalog.ts) and whether the orchestrator's chat
 * scope excludes it or the selection rules reach that domain
 * (apps/orchestrator, not asserted here). What this file pins is the half
 * tools-core owns: the domain exists, holds exactly these three, claims no
 * module, and every tool has home copy and a manifest row.
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, TOOL_DOMAINS, HOME_DESCRIPTION_BY_NAME } from "../../../src/catalog.js";
import { TOOLS } from "../../../src/registry.js";
import { TOOL_ROUTES } from "../../../src/tool-routes.js";
import { MODULE_OWNED_TOOL_DOMAINS } from "../../../src/module-gate.js";

const NAMES = ["list_connections", "start_connection", "disconnect_connection"] as const;

describe("connect-from-chat registration (WARP-3904)", () => {
  it("registers all three tools", () => {
    for (const name of NAMES) expect(TOOLS.has(name), name).toBe(true);
  });

  it("puts them, and only them, in the `connections` domain", () => {
    expect(TOOL_DOMAINS).toContain("connections");
    const inDomain = TOOL_CATALOG.filter((t) => t.domain === "connections").map((t) => t.name).sort();
    expect(inDomain).toEqual([...NAMES].sort());
  });

  it("leaves the domain unclaimed by any module, so no module toggle can hide connecting a service", () => {
    expect(MODULE_OWNED_TOOL_DOMAINS.has("connections")).toBe(false);
  });

  it("carries the tiers the contract names, with the interceptor owning the prompt", () => {
    const flags = (name: string) => {
      const t = TOOL_CATALOG.find((e) => e.name === name)!;
      return [t.requiresWrite, t.requiresConfirmation, t.confirmationOwner];
    };
    expect(flags("list_connections")).toEqual([false, false, undefined]);
    expect(flags("start_connection")).toEqual([false, false, undefined]);
    expect(flags("disconnect_connection")).toEqual([true, true, undefined]);
  });

  it("has plain home copy for each, with no key-in-chat promise it cannot keep", () => {
    for (const name of NAMES) {
      const copy = HOME_DESCRIPTION_BY_NAME[name];
      expect(copy, name).toBeTruthy();
      expect(copy).not.toBe(TOOLS.get(name)!.description);
      expect(copy).not.toContain("!");
    }
    expect(HOME_DESCRIPTION_BY_NAME.disconnect_connection).toMatch(/approve it first/);
  });

  it("declares each route hop in the manifest, as a hop the MCP principal must reach", () => {
    const hops = (name: string) => TOOL_ROUTES.find((r) => r.tool === name)?.hops.map((h) => `${h.method} ${h.pathPattern} ${h.kind}`);
    expect(hops("list_connections")).toEqual(["get /api/connections admit"]);
    expect(hops("start_connection")).toEqual(["get /api/connections/card admit"]);
    expect(hops("disconnect_connection")).toEqual(["post /api/connections/disconnect admit"]);
  });

  it("keeps every schema closed and free of the constraints that blew the GBNF grammar (WARP-1839)", () => {
    for (const name of NAMES) {
      const schema = TOOLS.get(name)!.inputSchema as { additionalProperties?: boolean; properties: Record<string, object> };
      expect(schema.additionalProperties, name).toBe(false);
      const text = JSON.stringify(schema);
      for (const banned of ["maxLength", "minLength", "pattern", "enum"]) expect(text, `${name} ${banned}`).not.toContain(`"${banned}"`);
    }
  });
});
