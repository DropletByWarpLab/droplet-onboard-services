/**
 * WARP-2969 — `lib/tool-domains` is the dashboard's hand-kept half of a pair
 * whose other half lives in `@droplet/tools-core`.
 *
 * `DOMAIN_META` covered 16 of the catalog's 21 domains and nothing noticed:
 * `labelForDomain` / `iconForDomain` fall back to a title-cased slug and a
 * generic wrench ON PURPOSE, so a domain the catalog adds renders un-prettied
 * instead of crashing the page. That fallback is also why the gap was
 * invisible — `agent_runs`, `cloud`, `crm`, `erp` and `money` rendered as
 * wrenches labelled "Crm" / "Erp" and read as a styling bug.
 *
 * The drift gate below is the only thing that can tell the two apart. It
 * imports the domain list from tools-core rather than restating it, because a
 * restated list is the exact failure it exists to catch.
 */

import { describe, it, expect } from "vitest";
import { TOOL_DOMAINS } from "@droplet/tools-core";
import type { ToolCatalogEntry } from "./types";
import {
  DOMAIN_META,
  iconForDomain,
  labelForDomain,
  reachNote,
  reachableInChat,
} from "./tool-domains";

describe("DOMAIN_META covers the catalog (WARP-2969)", () => {
  it("has an entry for every tools-core domain", () => {
    const missing = TOOL_DOMAINS.filter((d) => !(d in DOMAIN_META));
    expect(missing).toEqual([]);
  });

  it("gives every domain a non-empty label and an icon", () => {
    for (const d of TOOL_DOMAINS) {
      expect(labelForDomain(d).length, d).toBeGreaterThan(0);
      expect(iconForDomain(d), d).toBeTruthy();
    }
  });

  it("declares no domain the catalog does not have", () => {
    const stale = Object.keys(DOMAIN_META).filter(
      (d) => !(TOOL_DOMAINS as string[]).includes(d),
    );
    expect(stale).toEqual([]);
  });
});

/* ───────────────────────── reach helpers ───────────────────────── */

function tool(reach?: ToolCatalogEntry["reach"]): ToolCatalogEntry {
  return {
    name: "t",
    description: "[agent] t",
    homeDescription: "does a thing",
    domain: "system",
    requiresWrite: false,
    requiresConfirmation: false,
    ...(reach ? { reach } : {}),
  };
}

describe("reachableInChat / reachNote (WARP-2969)", () => {
  it("a fully reachable tool is in chat and carries no note", () => {
    const t = tool({ module: "on", chat: "allowed" });
    expect(reachableInChat(t)).toBe(true);
    expect(reachNote(t)).toBeNull();
  });

  it("a module-off tool is out of chat and says which side is off", () => {
    const t = tool({ module: "off", chat: "allowed" });
    expect(reachableInChat(t)).toBe(false);
    expect(reachNote(t)).toBe("Module off");
  });

  it("a chat-excluded tool is out of chat but still reachable elsewhere", () => {
    const t = tool({ module: "on", chat: "excluded" });
    expect(reachableInChat(t)).toBe(false);
    expect(reachNote(t)).toBe("Dashboard & MCP only");
  });

  it("names the module when both gates withhold — it is the one a person can flip", () => {
    expect(reachNote(tool({ module: "off", chat: "excluded" }))).toBe("Module off");
  });

  it("treats a missing reach as reachable, not as withheld", () => {
    // An orchestrator from before WARP-2969. Absence is no evidence.
    expect(reachableInChat(tool())).toBe(true);
    expect(reachNote(tool())).toBeNull();
  });
});
