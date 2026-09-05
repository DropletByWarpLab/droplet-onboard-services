/**
 * WARP-1527 (RBAC v2 T3) — server-side §9 access catalog.
 *
 * Pins the authoritative floor table the resolver + the roles routes clamp
 * against (ADR-032 §2: "a feature grant's level may not exceed the §9
 * catalog ceiling for the role's startingPoint"). The dashboard carries a
 * rendering copy of this table (apps/web-dashboard/src/lib/access.ts,
 * WARP-1532) — the SERVER is the boundary and re-clamps authoritatively;
 * these specs keep the two from drifting on the load-bearing values.
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, TOOL_DOMAINS } from "@droplet/tools-core";
import {
  GATEABLE_MODULE_IDS,
  ALWAYS_ON_FEATURES,
  GRANTABLE_TOOL_DOMAINS,
  maxLevelFor,
  clampConnectorLevel,
  clampLevel,
  fullCatalogFeatures,
  domainsForFeatures,
  tierReachableDomains,
} from "./access-catalog.js";

describe("access-catalog — module vocabulary", () => {
  // WARP-2117/2018 added `crm` and `contacts`, taking this from 12 to 14;
  // WARP-2581 added `money` for 15. The list is pinned so a new ModuleId
  // cannot arrive without someone writing its §9 ladder — which is exactly
  // what this test caught each time they did.
  it("gates the 15 non-core ModuleIds; chat is the always-on module at act", () => {
    expect([...GATEABLE_MODULE_IDS].sort()).toEqual(
      [
        "calendar",
        "cameras",
        "contacts",
        "crm",
        "docs",
        "email",
        "files",
        "knowledge",
        "managed_switch",
        "money",
        "network",
        "projects",
        "smart_home",
        "team_chat",
        "voice",
      ].sort(),
    );
    expect(GATEABLE_MODULE_IDS).not.toContain("chat");
    expect(ALWAYS_ON_FEATURES).toEqual([{ moduleId: "chat", level: "act" }]);
  });
});

describe("access-catalog — §9 floor ceilings per tier", () => {
  it("guest ceiling is view everywhere except voice + team_chat (act un-floored)", () => {
    expect(maxLevelFor("guest", "files")).toBe("view");
    expect(maxLevelFor("guest", "cameras")).toBe("view");
    expect(maxLevelFor("guest", "network")).toBe("view");
    expect(maxLevelFor("guest", "managed_switch")).toBe("view");
    expect(maxLevelFor("guest", "voice")).toBe("act");
    // WARP-1683: requireRole on /api/team-chat admits guests, so the §9
    // ceiling matches — a guest may read and send messages.
    expect(maxLevelFor("guest", "team_chat")).toBe("act");
  });

  it("family ceiling is manage on ordinary features, view on network + switch", () => {
    expect(maxLevelFor("family", "files")).toBe("manage");
    expect(maxLevelFor("family", "email")).toBe("manage");
    expect(maxLevelFor("family", "smart_home")).toBe("manage");
    expect(maxLevelFor("family", "voice")).toBe("manage");
    expect(maxLevelFor("family", "network")).toBe("view");
    expect(maxLevelFor("family", "managed_switch")).toBe("view");
  });

  it("admin (and owner) ceiling is each module's own top level (manage everywhere except team_chat)", () => {
    for (const moduleId of GATEABLE_MODULE_IDS) {
      // WARP-1683: team_chat tops out at `act` BY DESIGN — v1 has no admin
      // surface, and a `manage` level that gates nothing would be a lie in
      // the roles UI. Every other module still ceilings at manage.
      const top = moduleId === "team_chat" ? "act" : "manage";
      expect(maxLevelFor("admin", moduleId), moduleId).toBe(top);
      expect(maxLevelFor("owner", moduleId), moduleId).toBe(top);
    }
  });

  it("clampLevel pulls an over-floor grant down to the highest §9-legal level", () => {
    // guest-based role granted files manage → view (act/manage floored at family)
    expect(clampLevel("guest", "files", "manage")).toBe("view");
    // guest voice manage → act (act is un-floored on voice; manage floors at family)
    expect(clampLevel("guest", "voice", "manage")).toBe("act");
    // family network manage → view (act/manage floor at admin)
    expect(clampLevel("family", "network", "manage")).toBe("view");
    // managed_switch offers no act level — a family act request clamps to view
    expect(clampLevel("family", "managed_switch", "act")).toBe("view");
    // within-floor grants pass through untouched
    expect(clampLevel("family", "files", "act")).toBe("act");
    expect(clampLevel("admin", "network", "manage")).toBe("manage");
  });
});

describe("access-catalog — tier default catalog (null accessRoleId world)", () => {
  it("family default: manage on ordinary modules, view on network/switch, chat always-on", () => {
    const features = fullCatalogFeatures("family");
    const byId = new Map(features.map((f) => [f.moduleId, f.level]));
    expect(byId.get("chat")).toBe("act");
    expect(byId.get("files")).toBe("manage");
    expect(byId.get("network")).toBe("view");
    expect(byId.get("managed_switch")).toBe("view");
    // every gateable module + chat present exactly once
    expect(features).toHaveLength(GATEABLE_MODULE_IDS.length + 1);
  });

  it("guest default: view everywhere (voice act), chat act", () => {
    const byId = new Map(fullCatalogFeatures("guest").map((f) => [f.moduleId, f.level]));
    expect(byId.get("files")).toBe("view");
    expect(byId.get("voice")).toBe("act");
    expect(byId.get("chat")).toBe("act");
  });
});

describe("access-catalog — tool-domain mapping (tools-core vocabulary)", () => {
  it("maps features to tools-core domains; unclaimed domains always pass", () => {
    const domains = domainsForFeatures(new Set(["calendar", "knowledge", "projects", "smart_home"]));
    // calendar claims its trio (the WARP-1532 grouping)
    expect(domains.has("calendar")).toBe(true);
    expect(domains.has("reminders")).toBe(true);
    expect(domains.has("notifications")).toBe(true);
    // knowledge → memory, projects → pm, smart_home → smart-home (tools-core names)
    expect(domains.has("memory")).toBe(true);
    expect(domains.has("pm")).toBe(true);
    expect(domains.has("smart-home")).toBe(true);
    // module-claimed domains for features NOT in the set are dropped
    expect(domains.has("files")).toBe(false);
    expect(domains.has("network")).toBe(false);
    expect(domains.has("switch")).toBe(false);
    // domains no module claims (system/business/data/erp) are not module-gated
    expect(domains.has("system")).toBe(true);
    expect(domains.has("business")).toBe(true);
    expect(domains.has("data")).toBe(true);
    expect(domains.has("erp")).toBe(true);
  });

  it("feature set ∅ still passes the unclaimed domains only", () => {
    const domains = domainsForFeatures(new Set());
    expect(domains.has("files")).toBe(false);
    expect(domains.has("system")).toBe(true);
  });

  it("GRANTABLE_TOOL_DOMAINS is the tools-core union minus erp (connector axis owns erp)", () => {
    expect(GRANTABLE_TOOL_DOMAINS).not.toContain("erp");
    for (const d of GRANTABLE_TOOL_DOMAINS) {
      expect(TOOL_DOMAINS).toContain(d);
    }
    expect(GRANTABLE_TOOL_DOMAINS.length).toBe(TOOL_DOMAINS.length - 1);
  });

  it("`business` is grantable in its own right and holds every business_* tool (WARP-2583)", () => {
    // ADR-045 moved the PM and CRM tools into one domain. A grant on `pm` or
    // `crm` reaches nothing local any more (both are empty landing slots for
    // remote catalogs), so a role that lacks `business` reaches none of them.
    expect(GRANTABLE_TOOL_DOMAINS).toContain("business");
    const business = TOOL_CATALOG.filter((t) => t.name.startsWith("business_"));
    expect(business.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "business_find",
        "business_timeline",
        "business_create",
        "business_update",
        "business_link",
      ]),
    );
    for (const t of business) expect(t.domain, t.name).toBe("business");
    expect(TOOL_CATALOG.filter((t) => t.domain === "pm" || t.domain === "crm")).toEqual([]);
  });
});

describe("access-catalog — tier write-filter reachability", () => {
  it("owner/admin reach every catalog domain", () => {
    expect([...tierReachableDomains("owner")].sort()).toEqual([...TOOL_DOMAINS].sort());
    expect([...tierReachableDomains("admin")].sort()).toEqual([...TOOL_DOMAINS].sort());
  });

  it("family/guest reach only domains with at least one non-write tool", () => {
    const family = tierReachableDomains("family");
    // read tools exist in these domains (list_network_devices, read_file, …)
    expect(family.has("network")).toBe(true);
    expect(family.has("files")).toBe(true);
    // and the set never exceeds the catalog union
    for (const d of family) expect(TOOL_DOMAINS).toContain(d);
    expect(tierReachableDomains("guest")).toEqual(family);
  });
});

/**
 * WARP-1578 / ADR-032 §8 O-2 — the two connector floors, in one place.
 *
 * The dashboard renders these as DISABLED options with the reason (never
 * hidden, never silently accepted); this is the server half that makes the
 * client's honesty enforceable.
 */
describe("access-catalog — connector floors (O-2)", () => {
  it("Admin-based roles hold both levels — the cap is a floor, not a ban", () => {
    expect(clampConnectorLevel("admin", "read")).toBe("read");
    expect(clampConnectorLevel("admin", "read_write")).toBe("read_write");
  });

  it("Family-based roles cap at read — Read & write is Admin-only", () => {
    expect(clampConnectorLevel("family", "read")).toBe("read");
    expect(clampConnectorLevel("family", "read_write")).toBe("read");
  });

  it("Guest-based roles hold NO grant — they sit below the family-and-up read floor", () => {
    // null, not "read": routes/erp.ts refuses a guest at the tier floor
    // BEFORE the resolver is even read, so a stored row is inert by
    // construction. Storing it would let an operator save a setting that
    // silently does nothing.
    expect(clampConnectorLevel("guest", "read")).toBeNull();
    expect(clampConnectorLevel("guest", "read_write")).toBeNull();
  });

  it("service principals hold none either — they never resolve through layer 2 (§3)", () => {
    expect(clampConnectorLevel("service", "read_write")).toBeNull();
  });
});
