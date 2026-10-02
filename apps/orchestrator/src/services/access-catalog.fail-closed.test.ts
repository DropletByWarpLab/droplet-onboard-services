/**
 * WARP-2742 — a tool domain nobody has decided about is DENIED.
 *
 * The bug this pins: `domainsForFeatures` used to pass every domain no module
 * claimed, so a domain tools-core added without a module claim (money, cloud,
 * agent_runs, routines …) was reachable by every role-holder whatever their
 * features. Here tools-core grows a brand-new domain with no claim and no
 * ungated declaration, and the gate must drop it for every feature set.
 */
import { describe, it, expect, vi } from "vitest";
import type { ModuleId } from "@prisma/client";
import { domainsForFeatures, unmappedToolDomains } from "./access-catalog.js";
import { MODULES } from "../modules/module-registry.js";

vi.mock("@droplet/tools-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@droplet/tools-core")>();
  return { ...real, TOOL_DOMAINS: [...real.TOOL_DOMAINS, "brand_new_domain"] };
});

// vi.mock is hoisted above the imports, so access-catalog sees the extra domain.
describe("access-catalog — fail-closed on an unmapped domain (WARP-2742)", () => {
  it("reports the unmapped domain", () => {
    expect(unmappedToolDomains()).toEqual(["brand_new_domain"]);
  });

  it("denies it with every feature held, and with none", () => {
    const all = new Set<ModuleId>(MODULES.map((m) => m.id));
    expect(domainsForFeatures(all).has("brand_new_domain")).toBe(false);
    expect(domainsForFeatures(new Set()).has("brand_new_domain")).toBe(false);
  });
});
