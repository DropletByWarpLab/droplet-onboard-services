/**
 * WARP-2972 — the module verdict: which tool domains a module toggle (box axis)
 * and a person's own grants (person axis) withhold.
 *
 * The person axis is driven through the REAL §3 composition
 * (`computeEffectiveAccess`) so "a role-less user with a deny exception" is the
 * shipped resolver's answer, not a fixture's.
 */
import { describe, it, expect, vi } from "vitest";
import type { ModuleId } from "@prisma/client";
import { FAIL_CLOSED_MODULE_VERDICT, MODULE_OWNED_TOOL_DOMAINS, TOOL_DOMAINS } from "@droplet/tools-core";
import { GATEABLE_MODULE_IDS, OWNERS_BY_DOMAIN } from "./access-catalog.js";
import { computeEffectiveAccess, type EffectiveAccessInputs } from "./effective-access.service.js";
import {
  createModuleVerdictResolver,
  withheldDomainsFor,
  type ModuleVerdictDeps,
} from "./tool-module-verdict.service.js";
import { createModuleGate } from "../middleware/module-gate.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";
import { readPackageFile } from "../__tests__/helpers/test-paths.js";

const ALL: ModuleId[] = ["chat", ...GATEABLE_MODULE_IDS];
const without = (...off: ModuleId[]) => new Set(ALL.filter((m) => !off.includes(m)));

type Row = { id: string; username: string; role: string; directoryStatus?: string };
const CAROL: Row = { id: "u-carol", username: "carol", role: "admin" };
const OWNER: Row = { id: "u-owner", username: "olive", role: "owner" };

function prismaWith(rows: Row[]): ModuleVerdictDeps["prisma"] {
  return {
    user: {
      findMany: vi.fn(async ({ where }: { where: { OR: Array<Record<string, string>> } }) =>
        rows
          .filter((r) =>
            where.OR.some((clause) =>
              Object.entries(clause).every(([k, v]) => (r as unknown as Record<string, string>)[k] === v),
            ),
          )
          .map((r) => ({
            id: r.id,
            username: r.username,
            role: r.role,
            displayName: r.username,
            email: null,
            directoryStatus: r.directoryStatus ?? "ACTIVE",
          })),
      ),
    },
  } as never;
}

/** The real resolver's `features`, for a role-less person with these exceptions. */
function featuresOf(
  role: "owner" | "admin" | "family" | "guest",
  opts: { workspace: ReadonlySet<ModuleId>; deny?: ModuleId[] },
): ReadonlySet<ModuleId> {
  const inputs: EffectiveAccessInputs = {
    user: { id: "u", role, accessRole: null },
    exceptions: (opts.deny ?? []).map((moduleId, i) => ({
      id: `x${i}`,
      moduleId,
      effect: "deny" as const,
      level: null,
    })),
    workspaceModuleIds: opts.workspace,
    cloudEscapeEnabled: false,
    connections: [],
    usagePolicy: null,
    deptRights: [],
  };
  return new Set(computeEffectiveAccess(inputs).features.map((f) => f.moduleId));
}

function resolver(over: Partial<ModuleVerdictDeps> & { rows?: Row[] } = {}) {
  const { rows, ...deps } = over;
  return createModuleVerdictResolver({
    prisma: prismaWith(rows ?? [CAROL, OWNER]),
    boxModuleIds: async () => without(),
    personModuleIds: async () => without(),
    ...deps,
  });
}

describe("withheldDomainsFor", () => {
  it("withholds nothing when every module is held", () => {
    expect([...withheldDomainsFor(new Set(ALL))]).toEqual([]);
  });

  it("withholds the domains of a module that is not held", () => {
    const w = withheldDomainsFor(without("cameras"));
    expect(w.has("cameras")).toBe(true);
    expect(w.has("network")).toBe(false);
  });

  it("a shared domain needs ANY owner: business survives crm alone and projects alone", () => {
    expect(withheldDomainsFor(without("crm")).has("business")).toBe(false);
    expect(withheldDomainsFor(without("projects")).has("business")).toBe(false);
    expect(withheldDomainsFor(without("crm", "projects")).has("business")).toBe(true);
  });

  it("never withholds a domain no module claims, even with every module off", () => {
    const w = withheldDomainsFor(new Set());
    for (const d of ["system", "data", "agent_runs", "routines", "workspace", "erp", "cloud"]) {
      expect(w.has(d), d).toBe(false);
    }
  });

  it("maps the registry's non-obvious slugs (knowledge→memory, smart_home→smart-home)", () => {
    expect(withheldDomainsFor(without("knowledge")).has("memory")).toBe(true);
    expect(withheldDomainsFor(without("smart_home")).has("smart-home")).toBe(true);
    expect(withheldDomainsFor(without("calendar"))).toEqual(
      new Set(["calendar", "reminders", "notifications"]),
    );
  });
});

describe("the fail-closed list agrees with the registry", () => {
  it("MODULE_OWNED_TOOL_DOMAINS is exactly the set of domains a module claims", () => {
    expect(
      [...MODULE_OWNED_TOOL_DOMAINS].sort(),
      "a module now claims (or has stopped claiming) a tool domain. Update " +
        "MODULE_OWNED_TOOL_DOMAINS in packages/tools-core/src/module-gate.ts to match the " +
        "registry's `toolDomains`: the mcp-server has no registry to ask, and FAILS CLOSED on that list.",
    ).toEqual([...OWNERS_BY_DOMAIN.keys()].sort());
  });

  it("every claimed domain is a real tool domain", () => {
    for (const d of MODULE_OWNED_TOOL_DOMAINS) expect(TOOL_DOMAINS as string[], d).toContain(d);
  });
});

describe("box axis", () => {
  it("withholds the domains of a module that is off for the box, for a caller with no person", async () => {
    const v = await resolver({ boxModuleIds: async () => without("cameras") })(null);
    expect(v.withheldDomains.has("cameras")).toBe(true);
    expect(v.withheldDomains.has("network")).toBe(false);
  });

  it("applies to the owner", async () => {
    const v = await resolver({ boxModuleIds: async () => without("email") })("olive");
    expect(v.withheldDomains.has("email")).toBe(true);
  });

  it("applies to a role-less person", async () => {
    const v = await resolver({
      boxModuleIds: async () => without("smart_home"),
      personModuleIds: async () => without(),
    })("carol");
    expect(v.withheldDomains.has("smart-home")).toBe(true);
  });

  it("with no identity system (AUTH_ENABLED=false) a named person is the box: the synthetic dev owner has no row to resolve", async () => {
    const prisma = prismaWith([]);
    const v = await createModuleVerdictResolver({
      prisma,
      boxModuleIds: async () => without("cameras"),
      personAxis: () => false,
    })("dev");
    expect(v.withheldDomains.has("cameras")).toBe(true);
    expect(v.withheldDomains.has("network")).toBe(false);
    expect(v).not.toBe(FAIL_CLOSED_MODULE_VERDICT);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("the person axis is ON unless explicitly switched off", async () => {
    // Mutation: default `personAxis` to off → a named unknown person stops failing closed.
    expect(await resolver({ rows: [] })("ghost")).toBe(FAIL_CLOSED_MODULE_VERDICT);
    expect(
      await resolver({ rows: [], personAxis: () => true })("ghost"),
    ).toBe(FAIL_CLOSED_MODULE_VERDICT);
  });

  it("treats a service principal as the box, with no person lookup", async () => {
    const prisma = prismaWith([]);
    const v = await createModuleVerdictResolver({
      prisma,
      boxModuleIds: async () => without("smart_home"),
    })("_service:voice");
    expect(v.withheldDomains.has("smart-home")).toBe(true);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("an empty asserted value is the box too", async () => {
    const v = await resolver({ boxModuleIds: async () => without("money") })("");
    expect(v.withheldDomains.has("money")).toBe(true);
  });

  it("fails CLOSED when the module set cannot be read", async () => {
    const v = await resolver({
      boxModuleIds: async () => {
        throw new Error("db down");
      },
    })("carol");
    expect(v).toBe(FAIL_CLOSED_MODULE_VERDICT);
  });
});

describe("person axis", () => {
  it("a role-less admin with a DENY exception on a module loses that module's tools", async () => {
    const workspace = without();
    const v = await resolver({
      personModuleIds: async () => featuresOf("admin", { workspace, deny: ["email"] }),
    })("carol");
    expect(v.withheldDomains.has("email")).toBe(true);
    expect(v.withheldDomains.has("cameras")).toBe(false);
  });

  it("the same person without the exception keeps them", async () => {
    const v = await resolver({
      personModuleIds: async () => featuresOf("admin", { workspace: without() }),
    })("carol");
    expect(v.withheldDomains.has("email")).toBe(false);
  });

  it("the person axis only narrows: a module the person holds but the box has off stays withheld", async () => {
    const v = await resolver({
      boxModuleIds: async () => without("cameras"),
      personModuleIds: async () => new Set(ALL),
    })("carol");
    expect(v.withheldDomains.has("cameras")).toBe(true);
  });

  it("the owner is not narrowed per person (§3's one bypass), whatever the resolver says", async () => {
    const personModuleIds = vi.fn(async () => new Set<ModuleId>());
    const v = await resolver({ personModuleIds })("olive");
    expect(v.withheldDomains.size).toBe(0);
    expect(personModuleIds).not.toHaveBeenCalled();
  });

  it("resolves a person by User.id as well as username", async () => {
    const v = await resolver({
      personModuleIds: async () => featuresOf("admin", { workspace: without(), deny: ["email"] }),
    })("u-carol");
    expect(v.withheldDomains.has("email")).toBe(true);
  });

  it.each([
    ["an unknown person", "nobody", [CAROL]],
    ["a deactivated person", "carol", [{ ...CAROL, directoryStatus: "DEACTIVATED" }]],
    ["an ambiguous name", "dup", [
      { id: "a", username: "dup", role: "admin" },
      { id: "dup", username: "other", role: "admin" },
    ]],
  ] as Array<[string, string, Row[]]>)("fails CLOSED for %s", async (_label, asserted, rows) => {
    expect(await resolver({ rows })(asserted)).toBe(FAIL_CLOSED_MODULE_VERDICT);
  });

  it("fails CLOSED when the person's grants cannot be read", async () => {
    const v = await resolver({
      personModuleIds: async () => {
        throw new Error("tx aborted");
      },
    })("carol");
    expect(v).toBe(FAIL_CLOSED_MODULE_VERDICT);
  });

  it("fails CLOSED when the person's grants resolve to nothing", async () => {
    expect(await resolver({ personModuleIds: async () => null })("carol")).toBe(FAIL_CLOSED_MODULE_VERDICT);
  });

  it("fails CLOSED when the user lookup throws", async () => {
    const prisma = { user: { findMany: vi.fn().mockRejectedValue(new Error("boom")) } } as never;
    expect(await resolver({ prisma })("carol")).toBe(FAIL_CLOSED_MODULE_VERDICT);
  });
});

describe("caching", () => {
  it("reads a person's grants once per TTL, and again after it", async () => {
    let t = 1_000;
    const personModuleIds = vi.fn(async () => without());
    const r = resolver({ personModuleIds, ttlMs: 5_000, now: () => t });
    await r("carol");
    await r("carol");
    expect(personModuleIds).toHaveBeenCalledTimes(1);
    t += 5_001;
    await r("carol");
    expect(personModuleIds).toHaveBeenCalledTimes(2);
  });

  it("reads the BOX set every time, so a toggle is visible at once (the module gate owns that cache)", async () => {
    const boxModuleIds = vi.fn(async () => without());
    const r = resolver({ boxModuleIds });
    await r("carol");
    await r("carol");
    expect(boxModuleIds).toHaveBeenCalledTimes(2);
  });

  it("caches an UNRESOLVED person for the TTL: one lookup per TTL, still fail-closed, re-resolved after it", async () => {
    let t = 1_000;
    const rows: Row[] = [CAROL];
    const prisma = prismaWith(rows);
    const r = resolver({ prisma, ttlMs: 5_000, now: () => t });
    expect(await r("nobody")).toBe(FAIL_CLOSED_MODULE_VERDICT);
    expect(await r("nobody")).toBe(FAIL_CLOSED_MODULE_VERDICT);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    rows.push({ id: "u-nobody", username: "nobody", role: "admin" });
    t += 5_001;
    expect((await r("nobody")).withheldDomains.size).toBe(0);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const personModuleIds = vi.fn(async () => {
      if (fail) throw new Error("blip");
      return without();
    });
    const r = resolver({ personModuleIds });
    expect(await r("carol")).toBe(FAIL_CLOSED_MODULE_VERDICT);
    fail = false;
    expect((await r("carol")).withheldDomains.size).toBe(0);
  });
});

describe("one cache with the module gate", () => {
  const CFG: AvailabilityConfig = {
    AI_GATEWAY_URL: "http://ai-gateway:8000",
    FILE_INDEXER_URL: "http://file-indexer:8001",
    NEXTCLOUD_URL: "http://nextcloud",
    DOCS_ENABLED: "1",
    DOCS_INTERNAL_URL: "http://docs",
    SERVICE_TOKEN_EMAIL: "tok",
    SERVICE_TOKEN_VOICE: "tok",
    FRIGATE_URL: "http://frigate:5000",
    DROPLET_MATTER_SERVICE_URL: "http://matter:8003",
    ROUTING_SERVICE_URL: "http://routing:8004",
    SWITCH_SERVICE_URL: "http://switch:8005",
  };

  it("a toggle leaves (and rejoins) the tool list on the same invalidate() that moves the route gate", async () => {
    let rows: Array<{ moduleId: string; enabled: boolean }> = [];
    const prisma = { moduleSetting: { findMany: vi.fn(async () => rows) } };
    const gate = createModuleGate(prisma as never, CFG, 60_000);
    const verdict = createModuleVerdictResolver({
      prisma: prismaWith([]),
      boxModuleIds: gate.effectiveIds,
    });

    // `cameras` ships OFF by default (registry defaultEnabled: false).
    expect((await verdict(null)).withheldDomains.has("cameras")).toBe(true);

    rows = [{ moduleId: "cameras", enabled: true }];
    // Same cache as the route gate: still the old answer until the write invalidates it.
    expect((await verdict(null)).withheldDomains.has("cameras")).toBe(true);
    gate.invalidate();
    expect((await verdict(null)).withheldDomains.has("cameras")).toBe(false);

    rows = [{ moduleId: "cameras", enabled: false }];
    gate.invalidate();
    expect((await verdict(null)).withheldDomains.has("cameras")).toBe(true);
    // ONE read per invalidation, shared with the route gate — not a second reader.
    expect(prisma.moduleSetting.findMany).toHaveBeenCalledTimes(3);
  });

  it("a module UNAVAILABLE on the box is withheld even when enabled", async () => {
    const prisma = { moduleSetting: { findMany: async () => [{ moduleId: "cameras", enabled: true }] } };
    const gate = createModuleGate(prisma as never, { ...CFG, FRIGATE_URL: "" }, 0);
    const v = await createModuleVerdictResolver({ prisma: prismaWith([]), boxModuleIds: gate.effectiveIds })(null);
    expect(v.withheldDomains.has("cameras")).toBe(true);
  });

  it("app.ts binds the verdict to the SAME module gate the routes use, and only person-narrows when auth is on", () => {
    const app = readPackageFile("src", "app.ts");
    expect(app).toContain(
      "initToolModuleVerdict(prisma, moduleGate.effectiveIds, () => config.AUTH_ENABLED)",
    );
    // Bound after the gate exists.
    expect(app.indexOf("createModuleGate(prisma, config)")).toBeLessThan(
      app.indexOf("initToolModuleVerdict(prisma"),
    );
  });
});
