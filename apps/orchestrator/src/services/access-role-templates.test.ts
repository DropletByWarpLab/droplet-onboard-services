/**
 * WARP-2738 — the role-template catalogue's safety net.
 *
 * `access-role-templates.ts` is HAND-AUTHORED DATA. Nothing else in the
 * system checks it: the create route clamps whatever it is given and never
 * refuses, so a template that over-asks does not fail loudly — it silently
 * stores a SMALLER grant than the card it was chosen from advertised, and the
 * operator is left believing they granted something they did not. That is the
 * exact defect class this file exists to catch.
 *
 * So the load-bearing spec here is not "the data parses". It is: run every
 * template through the SAME functions the server applies at write time
 * (`clampLevel`, `clampConnectorLevel`, the locks AND-gate) and at resolve
 * time (`satisfiedModuleIds`, `domainsForFeatures`, `tierReachableDomains`),
 * and assert NOTHING CHANGES. If a §9 floor moves, a module declares a new
 * dependency, or a tool domain's last read-only tool becomes a write, this
 * file goes red in the same commit instead of a preset quietly degrading.
 *
 * The checks run against `roleTemplateCreatePayload(t)`, not the raw literal,
 * so the projection into the route's payload shape is covered by the same
 * assertions rather than being a second, unchecked seam.
 */
import { describe, it, expect } from "vitest";
import { TOOL_DOMAINS } from "@droplet/tools-core";
import type { ModuleId } from "@prisma/client";
import {
  ROLE_TEMPLATES,
  ROLE_TEMPLATE_BY_ID,
  isRoleTemplateId,
  roleTemplateCreatePayload,
  type AccessRoleCreatePayload,
  type RoleTemplate,
} from "./access-role-templates.js";
import {
  GATEABLE_MODULE_IDS,
  GRANTABLE_TOOL_DOMAINS,
  clampConnectorLevel,
  clampLevel,
  domainsForFeatures,
  tierReachableDomains,
} from "./access-catalog.js";
import { ASSIGNABLE_ROLES } from "./role-mutation-guard.service.js";
import { MODULE_REQUIRES, satisfiedModuleIds } from "../modules/module-registry.js";

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The catalogue at its DECLARED type rather than its `as const` literal type.
 *
 * Needed, not cosmetic: `as const` narrows `moduleId` to the exact union the
 * catalogue happens to contain today, so `g.moduleId === "money"` inside a
 * guard is a TS2367 "no overlap" COMPILE ERROR the moment no template grants
 * money — which is precisely the state the guard exists to keep. A guard that
 * stops compiling when it starts holding is not a guard. Widening once here
 * keeps every such check runtime-real.
 */
const TEMPLATES: readonly RoleTemplate[] = ROLE_TEMPLATES;

/** Every template, as the [id, payload] pair the per-template specs iterate.
 *  Built once so each spec names the failing template in its title. */
const PAYLOADS: Array<[string, AccessRoleCreatePayload]> = ROLE_TEMPLATES.map((t) => [
  t.id,
  roleTemplateCreatePayload(t),
]);

describe("access-role-templates — catalogue identity", () => {
  // Pinned in order. `id` is written into the creation activity's refs and
  // referenced by the dashboard, so it is an API surface: a rename here is a
  // breaking change and has to be a deliberate edit to this list.
  it("ships the eight templates, in presentation order, with stable ids", () => {
    expect(ROLE_TEMPLATES.map((t) => t.id)).toEqual([
      "front-desk",
      "clinical-staff",
      "office-manager",
      "bookkeeper",
      "it-facilities",
      "marketing-outreach",
      "read-only-auditor",
      "contractor-temp",
    ]);
  });

  it("ids are unique and kebab-case", () => {
    const ids = ROLE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(KEBAB_CASE);
  });

  it("BY_ID indexes every template and the guard admits exactly those ids", () => {
    expect(ROLE_TEMPLATE_BY_ID.size).toBe(ROLE_TEMPLATES.length);
    for (const t of ROLE_TEMPLATES) {
      expect(ROLE_TEMPLATE_BY_ID.get(t.id)).toBe(t);
      expect(isRoleTemplateId(t.id)).toBe(true);
    }
    expect(isRoleTemplateId("front_desk")).toBe(false);
    expect(isRoleTemplateId("")).toBe(false);
    expect(isRoleTemplateId("__proto__")).toBe(false);
  });

  // The route's zod bounds (rolePayloadSchema): name trim().min(1).max(80),
  // description max(500). A template that violates one is a 400 the operator
  // cannot fix from the UI.
  it("names and descriptions fit the create schema's bounds", () => {
    for (const t of TEMPLATES) {
      expect(t.name.trim()).toBe(t.name);
      expect(t.name.length).toBeGreaterThanOrEqual(1);
      expect(t.name.length).toBeLessThanOrEqual(80);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.description.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("access-role-templates — grant vocabulary", () => {
  it.each(PAYLOADS)("%s grants only gateable modules, once each, never chat", (_id, payload) => {
    const ids = payload.featureGrants.map((g) => g.moduleId);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const moduleId of ids) {
      expect(GATEABLE_MODULE_IDS).toContain(moduleId);
      // `chat` is the always-on floor the resolver injects; a grant row for it
      // is a hard 400 on the create route and cannot exist in the schema.
      expect(moduleId).not.toBe("chat");
    }
  });

  it.each(PAYLOADS)("%s grants only grantable tool domains, once each, never erp", (_id, payload) => {
    const domains = payload.toolGrants.map((g) => g.domain);
    expect(new Set(domains).size).toBe(domains.length);
    for (const domain of domains) {
      expect(GRANTABLE_TOOL_DOMAINS).toContain(domain);
      expect(TOOL_DOMAINS).toContain(domain);
      // Connector reach is the §5.4 connectors axis, never a tool grant.
      expect(domain).not.toBe("erp");
    }
  });

  it.each(PAYLOADS)("%s starts from an assignable tier", (_id, payload) => {
    expect(ASSIGNABLE_ROLES).toContain(payload.startingPoint);
  });
});

/**
 * THE LOAD-BEARING SPEC.
 *
 * `normalizeGrants` (routes/access.ts) is the server's authoritative re-clamp
 * and it is SILENT by contract — over-asking is clamped down, never refused.
 * Re-running its three components here is the only thing standing between a
 * catalogue edit and a preset that advertises a level the box will not store.
 */
describe("access-role-templates — the server re-clamp is a no-op on every template", () => {
  it.each(PAYLOADS)("%s survives clampLevel on every feature grant unchanged", (_id, payload) => {
    const clamped = payload.featureGrants.map((g) => ({
      moduleId: g.moduleId,
      level: clampLevel(payload.startingPoint, g.moduleId, g.level),
    }));
    // toEqual over the whole array, not per-grant: a diff names the module AND
    // the level it fell to, which is the information needed to fix the table.
    expect(clamped).toEqual(payload.featureGrants);
  });

  it.each(PAYLOADS)("%s survives clampConnectorLevel unchanged (no row dropped)", (_id, payload) => {
    // Vacuous today (this ticket ships no connector grants) and deliberately
    // written to stay meaningful if that decision is ever revisited: the guest
    // rule DROPS the row entirely rather than lowering it, so a length change
    // is the failure to catch.
    const clamped = payload.connectorGrants.flatMap((g) => {
      const level = clampConnectorLevel(payload.startingPoint, g.level);
      return level === null ? [] : [{ provider: g.provider, level }];
    });
    expect(clamped).toEqual(payload.connectorGrants);
  });

  it.each(PAYLOADS)("%s keeps mayOperateLocks through the smart_home AND-gate", (_id, payload) => {
    const smartHomeOn = payload.featureGrants.some((g) => g.moduleId === "smart_home");
    expect(payload.mayOperateLocks && smartHomeOn).toBe(payload.mayOperateLocks);
  });
});

describe("access-role-templates — the resolver keeps what the template grants", () => {
  /**
   * MODULE_REQUIRES is applied per-person in effective-access.service.ts via
   * `satisfiedModuleIds`, so a template granting a child without its parent
   * loses the child at resolve time — the row saves, the capability does not
   * exist. Derived from the map (one edge today, docs → files); never spelled
   * out here, so a second edge is covered the day it is declared.
   */
  it.each(PAYLOADS)("%s satisfies every declared module dependency", (_id, payload) => {
    const held = new Set<ModuleId>(payload.featureGrants.map((g) => g.moduleId));
    expect([...satisfiedModuleIds(held)].sort()).toEqual([...held].sort());
    // Same statement from the other direction, so a failure says WHICH edge.
    for (const moduleId of held) {
      const parent = MODULE_REQUIRES.get(moduleId);
      if (parent !== undefined) {
        expect(held.has(parent), `${moduleId} requires ${parent}`).toBe(true);
      }
    }
  });

  /**
   * `tierReachableDomains` is the ADR-004 write filter at domain granularity:
   * family and guest lose every domain whose tools are ALL `requiresWrite`.
   * Today that is `team_chat` — both of its tools send — which is why the
   * family/guest templates grant the team_chat FEATURE (the Messages surface)
   * and never the team_chat TOOL domain.
   */
  it.each(PAYLOADS)("%s grants only tool domains its tier can reach", (_id, payload) => {
    const reachable = tierReachableDomains(payload.startingPoint);
    for (const g of payload.toolGrants) {
      expect(reachable.has(g.domain), `${g.domain} unreachable for ${payload.startingPoint}`).toBe(
        true,
      );
    }
  });

  /**
   * `domainsForFeatures` is the feature intersection: a CLAIMED domain passes
   * only when its owning module is held, and every UNCLAIMED domain passes
   * unconditionally (see the unclaimed-domain spec below).
   */
  it.each(PAYLOADS)("%s grants only tool domains its features reach", (_id, payload) => {
    const featureIds = new Set<ModuleId>(payload.featureGrants.map((g) => g.moduleId));
    const featureDomains = domainsForFeatures(featureIds);
    for (const g of payload.toolGrants) {
      expect(featureDomains.has(g.domain), `${g.domain} not reached by this feature set`).toBe(
        true,
      );
    }
  });

  /**
   * What is actually true about the unclaimed domains, stated rather than
   * assumed — because four templates lean on it.
   *
   * `money`, `business`, `data` and `system` are NOT module-gated: no module
   * declares them in `toolDomains`, so `domainsForFeatures` passes them for
   * ANY feature set, including the empty one. (`money` is the surprising one:
   * the Money MODULE exists and is feature-gated, but it claims no tool
   * domain — WARP-2581 kept `money_list_open_documents` out of the chat pool
   * — so the `money` tool domain rides the other axes only.)
   *
   * The consequence for this catalogue: granting those domains is a real
   * grant on the tool axis (the role's grant set is still an intersection
   * term), but it is NOT narrowed by the feature grants, so the templates
   * must not treat a feature grant as the thing that authorises them.
   */
  it("the unclaimed domains this catalogue relies on pass with no features at all", () => {
    const noFeatures = domainsForFeatures(new Set<ModuleId>());
    for (const domain of ["money", "business", "data", "system"]) {
      expect(noFeatures.has(domain), `${domain} should be unclaimed`).toBe(true);
    }
    // …and a claimed domain does not, which is what makes the above a real
    // distinction rather than "domainsForFeatures returns everything".
    expect(noFeatures.has("files")).toBe(false);
    expect(noFeatures.has("crm")).toBe(false);
  });
});

describe("access-role-templates — this ticket's product decisions", () => {
  it("no template carries a connector grant", () => {
    // Provider slugs are box-specific; a template naming one this box has not
    // configured would store dead config the roles list then advertises as
    // reach. The operator adds connector access after creating.
    for (const t of TEMPLATES) {
      expect(t.connectorGrants, `${t.id} must ship no connector grants`).toEqual([]);
    }
  });

  it("no template sets a usage cap", () => {
    // llmDailyMessageCap is stored and rendered but NOT enforced (routes/llm.ts
    // D-7). Shipping a cap would advertise a limit the box does not keep, so
    // all three usage fields stay null and the operator sets them knowingly.
    for (const t of TEMPLATES) {
      expect(t.storageQuotaBytes, `${t.id} storageQuotaBytes`).toBeNull();
      expect(t.maxUploadSizeMb, `${t.id} maxUploadSizeMb`).toBeNull();
      expect(t.llmDailyMessageCap, `${t.id} llmDailyMessageCap`).toBeNull();
    }
  });

  it("no template allows cloud models", () => {
    // The cloud escape is a box-wide channel ANDed with the role flag; a
    // preset is the wrong place to open it.
    for (const t of TEMPLATES) expect(t.cloudModelsAllowed).toBe(false);
  });

  it("locks are granted only alongside smart_home, and only where intended", () => {
    const withLocks = TEMPLATES.filter((t) => t.mayOperateLocks);
    expect(withLocks.map((t) => t.id)).toEqual(["it-facilities"]);
    for (const t of withLocks) {
      expect(t.featureGrants.some((g) => g.moduleId === "smart_home")).toBe(true);
    }
  });

  it("guest-based templates carry no connector grant and no money feature grant", () => {
    const guests = TEMPLATES.filter((t) => t.startingPoint === "guest");
    expect(guests.length).toBeGreaterThan(0);
    for (const guest of guests) {
      // clampConnectorLevel drops a guest connector row entirely, so one here
      // would be a setting that silently does nothing.
      expect(guest.connectorGrants, `${guest.id} connectorGrants`).toEqual([]);
      // money's `view` floors at FAMILY, and /api/money is
      // requireRole("owner","admin","family") — a Money card on a guest role
      // would advertise reach that 403s at the door.
      expect(
        guest.featureGrants.some((g) => g.moduleId === "money"),
        `${guest.id} must not grant money`,
      ).toBe(false);
    }
  });

  it("money at manage appears only on admin-based templates", () => {
    // The catalogue floors money `manage` at admin, so a family/guest template
    // asking for it would clamp DOWN silently. Belt to the clamp spec's braces,
    // stated as the product rule it is.
    for (const t of TEMPLATES) {
      const money = t.featureGrants.find((g) => g.moduleId === "money");
      if (money?.level === "manage") expect(t.startingPoint).toBe("admin");
    }
  });

  it("write-capable tool levels appear only on admin-based templates", () => {
    // tool-access.service.ts reads `level === "use"` only inside
    // tierKeepsWriteTools (owner/admin ONLY), so `use` on a family/guest
    // template is indistinguishable from `view` — an honest catalogue does not
    // print a level the tier cannot act on.
    for (const t of TEMPLATES) {
      if (t.toolGrants.some((g) => g.level === "use")) {
        expect(t.startingPoint, `${t.id} asks for a write tool level`).toBe("admin");
      }
    }
  });
});

describe("access-role-templates — createPayload projection", () => {
  it("carries every payload field the create route parses", () => {
    const payload = roleTemplateCreatePayload(ROLE_TEMPLATE_BY_ID.get("it-facilities")!);
    expect(Object.keys(payload).sort()).toEqual(
      [
        "cloudModelsAllowed",
        "connectorGrants",
        "description",
        "featureGrants",
        "llmDailyMessageCap",
        "maxUploadSizeMb",
        "mayOperateLocks",
        "name",
        "startingPoint",
        "storageQuotaBytes",
        "toolGrants",
      ].sort(),
    );
    expect(payload.name).toBe("IT & Facilities");
    expect(payload.startingPoint).toBe("admin");
    expect(payload.mayOperateLocks).toBe(true);
    // description is nullable-REQUIRED on the schema: present, never undefined.
    expect(typeof payload.description).toBe("string");
    expect(payload.storageQuotaBytes).toBeNull();
  });

  it("returns fresh arrays and objects so a caller cannot mutate the catalogue", () => {
    const template = ROLE_TEMPLATE_BY_ID.get("front-desk")!;
    const a = roleTemplateCreatePayload(template);
    const b = roleTemplateCreatePayload(template);
    expect(a.featureGrants).not.toBe(b.featureGrants);
    expect(a.featureGrants[0]).not.toBe(b.featureGrants[0]);

    a.featureGrants.push({ moduleId: "network", level: "manage" });
    a.featureGrants[0].level = "manage";
    a.toolGrants.length = 0;

    const c = roleTemplateCreatePayload(template);
    expect(c.featureGrants).toHaveLength(template.featureGrants.length);
    expect(c.featureGrants[0].level).toBe(template.featureGrants[0].level);
    expect(c.toolGrants).toHaveLength(template.toolGrants.length);
  });
});
