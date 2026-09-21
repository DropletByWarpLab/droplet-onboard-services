/**
 * WARP-899/WARP-900/WARP-901 — the `data` tool domain (encode/decode, hashing,
 * format conversion + misc dev utilities: timestamp_convert / uuid_generate /
 * regex_test) ships in tools-core's catalog, so the dashboard domain map must
 * know it. Without an explicit entry the /tools page would render the domain
 * with the generic fallback icon — the same drift the catalog completeness
 * tests guard against on the tools-core side.
 */
import { describe, it, expect } from "vitest";
import { Braces, Wrench } from "lucide-react";
import { TOOL_DOMAINS } from "@droplet/tools-core";
import type { ToolCatalogEntry } from "./types";
import {
  DOMAIN_META,
  iconForDomain,
  labelForDomain,
  reachNote,
  reachableInChat,
} from "./tool-domains";

describe("tool-domains — data domain (WARP-899/WARP-900/WARP-901)", () => {
  it("labels the data domain 'Data'", () => {
    expect(labelForDomain("data")).toBe("Data");
  });

  it("gives the data domain a dedicated icon, not the generic fallback", () => {
    expect(iconForDomain("data")).toBe(Braces);
    expect(iconForDomain("data")).not.toBe(Wrench);
  });

  it("still falls back gracefully for a truly unknown domain", () => {
    expect(labelForDomain("never-heard-of-it")).toBe("Never heard of it");
    expect(iconForDomain("never-heard-of-it")).toBe(Wrench);
  });
});

describe("tool-domains — team_chat domain (WARP-1685)", () => {
  it("labels the team_chat domain 'Messages' with a dedicated icon", () => {
    expect(labelForDomain("team_chat")).toBe("Messages");
    expect(iconForDomain("team_chat")).not.toBe(Wrench);
  });
});

describe("tool-domains — routines domain (WARP-2894)", () => {
  it("labels the routines domain 'Routines' with the nav entry's icon, not the fallback", () => {
    expect(labelForDomain("routines")).toBe("Routines");
    expect(iconForDomain("routines")).not.toBe(Wrench);
  });
});

/**
 * WARP-2969 — the per-domain tests above are the pattern this file has
 * followed since WARP-899: one more `it` each time a domain lands. It missed
 * five anyway. `DOMAIN_META` covered 16 of the catalog's 21 domains, and
 * `agent_runs`, `cloud`, `crm`, `erp` and `money` rendered as a generic
 * wrench labelled "Crm" / "Erp" — which reads as a styling bug, not as a
 * missing entry, because the fallback is silent BY DESIGN (a domain the
 * catalog adds must never crash the page).
 *
 * So: stop adding one test per domain and assert the whole set against
 * tools-core. The list is IMPORTED, never restated here — a restated list is
 * the exact drift this exists to catch.
 */
describe("DOMAIN_META covers the catalog (WARP-2969)", () => {
  it("has an entry for every tools-core domain", () => {
    expect(TOOL_DOMAINS.filter((d) => !(d in DOMAIN_META))).toEqual([]);
  });

  it("gives every domain a non-empty label and an icon that is not the fallback", () => {
    for (const d of TOOL_DOMAINS) {
      expect(labelForDomain(d).length, d).toBeGreaterThan(0);
      expect(iconForDomain(d), d).not.toBe(Wrench);
    }
  });

  it("declares no domain the catalog does not have", () => {
    const stale = Object.keys(DOMAIN_META).filter(
      (d) => !(TOOL_DOMAINS as string[]).includes(d),
    );
    expect(stale).toEqual([]);
  });
});

/**
 * WARP-2969 — the ONE reading of `reach`, shared by the `/chat` slash menu
 * (which filters on it) and the `/tools` chip (which explains it), so the two
 * surfaces cannot disagree about what a tool's absence from chat means.
 */
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
  it("a reachable tool is offered in chat and carries no note", () => {
    const t = tool({ chat: "allowed" });
    expect(reachableInChat(t)).toBe(true);
    expect(reachNote(t)).toBeNull();
  });

  it("a chat-excluded tool is out of chat but says it is reachable elsewhere", () => {
    const t = tool({ chat: "excluded" });
    expect(reachableInChat(t)).toBe(false);
    // Not "unavailable": the tool works, just not by asking for it.
    expect(reachNote(t)).toBe("Dashboard & MCP only");
  });

  it("treats a missing reach as reachable, not as withheld", () => {
    // An orchestrator from before WARP-2969. Absence is no evidence, and
    // reading it the other way would empty the slash menu on the one box
    // that cannot tell us better.
    expect(reachableInChat(tool())).toBe(true);
    expect(reachNote(tool())).toBeNull();
  });
});
