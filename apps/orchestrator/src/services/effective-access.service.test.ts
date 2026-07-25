/**
 * WARP-1527 / ADR-032 §3 (RBAC v2 T3) — effective-access resolver matrix.
 *
 * Pins the pure §3 composition (computeEffectiveAccess) against the ticket's
 * resolver-unit matrix: tier-only floors, role narrowing, exception
 * allow/deny with the catalog clamp, workspace-module intersection, the
 * owner bypass, admins-narrowable (NO requireScope-style short-circuit),
 * the locks gate, the cloud AND-gate, the connector min, and the T7 usage
 * passthrough. Plus the fetch wrapper's null-on-missing-user contract.
 */
import { describe, it, expect, vi } from "vitest";
import type { ModuleId } from "@prisma/client";
import { TOOL_DOMAINS } from "@droplet/tools-core";
import {
  computeEffectiveAccess,
  resolveEffectiveAccess,
  _setEffectiveAccessForTests,
  type EffectiveAccessInputs,
} from "./effective-access.service.js";
import { GATEABLE_MODULE_IDS } from "./access-catalog.js";

const ALL_MODULES: ReadonlySet<ModuleId> = new Set<ModuleId>([
  "chat",
  ...GATEABLE_MODULE_IDS,
]);

/** Baseline inputs: null accessRole, every module workspace-effective,
 *  cloud escape off, no connections/exceptions/policy/departments. */
function baseInputs(overrides: Partial<EffectiveAccessInputs> = {}): EffectiveAccessInputs {
  return {
    user: { id: "u-1", role: "family", accessRole: null },
    exceptions: [],
    workspaceModuleIds: ALL_MODULES,
    cloudEscapeEnabled: false,
    connections: [],
    usagePolicy: null,
    deptRights: [],
    ...overrides,
  };
}

function role(overrides: Partial<NonNullable<EffectiveAccessInputs["user"]["accessRole"]>> = {}) {
  return {
    mayOperateLocks: false,
    cloudModelsAllowed: false,
    storageQuotaBytes: null as bigint | null,
    maxUploadSizeMb: null as number | null,
    llmDailyMessageCap: null as number | null,
    featureGrants: [] as Array<{ moduleId: ModuleId; level: "view" | "act" | "manage" }>,
    toolGrants: [] as Array<{ domain: string; level: "view" | "use" }>,
    connectorGrants: [] as Array<{ provider: string; level: "read" | "read_write" }>,
    ...overrides,
  };
}

function featureLevel(result: ReturnType<typeof computeEffectiveAccess>, moduleId: string) {
  return result.features.find((f) => f.moduleId === moduleId)?.level;
}

describe("effective-access — tier-only floors (null accessRoleId = today's world)", () => {
  it("family: manage on ordinary modules, view on network/switch, chat act, all domains", () => {
    const res = computeEffectiveAccess(baseInputs());
    expect(res.tier).toBe("family");
    expect(featureLevel(res, "chat")).toBe("act");
    expect(featureLevel(res, "files")).toBe("manage");
    expect(featureLevel(res, "network")).toBe("view");
    expect(featureLevel(res, "managed_switch")).toBe("view");
    // full catalog: chat + every gateable module
    expect(res.features).toHaveLength(GATEABLE_MODULE_IDS.length + 1);
    // write-filtered domain reach only (family loses all-write domains)
    expect(res.toolDomains).toContain("files");
    expect(res.toolDomains).toContain("network");
  });

  it("guest: view everywhere (voice act); locks stay off", () => {
    const res = computeEffectiveAccess(
      baseInputs({ user: { id: "u-g", role: "guest", accessRole: null } }),
    );
    expect(featureLevel(res, "files")).toBe("view");
    expect(featureLevel(res, "voice")).toBe("act");
    expect(res.locks).toBe(false);
  });

  it("family tier-only: locks on when smart_home is effective (today's write-filter reality)", () => {
    const res = computeEffectiveAccess(baseInputs());
    expect(res.locks).toBe(true);
  });
});

describe("effective-access — owner bypass", () => {
  it("owner resolves ALL features at manage (chat act), every domain, locks on", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: { id: "u-o", role: "owner", accessRole: null },
        // even with modules workspace-off, §3 puts owner outside the intersection
        workspaceModuleIds: new Set<ModuleId>(["chat"]),
      }),
    );
    expect(res.tier).toBe("owner");
    expect(featureLevel(res, "network")).toBe("manage");
    expect(featureLevel(res, "cameras")).toBe("manage");
    expect(featureLevel(res, "chat")).toBe("act");
    expect(res.features).toHaveLength(GATEABLE_MODULE_IDS.length + 1);
    expect([...res.toolDomains].sort()).toEqual([...TOOL_DOMAINS].sort());
    expect(res.locks).toBe(true);
  });

  it("owner ignores narrowing grant rows entirely (drifted data cannot narrow the owner)", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-o",
          role: "owner",
          accessRole: role({ featureGrants: [{ moduleId: "files", level: "view" }] }),
        },
      }),
    );
    expect(featureLevel(res, "files")).toBe("manage");
  });

  it("owner cloud is still the workspace escape gate (ai-gateway backstop is real for owners too)", () => {
    expect(computeEffectiveAccess(baseInputs({ user: { id: "o", role: "owner", accessRole: null } })).cloud).toBe(false);
    expect(
      computeEffectiveAccess(
        baseInputs({ user: { id: "o", role: "owner", accessRole: null }, cloudEscapeEnabled: true }),
      ).cloud,
    ).toBe(true);
  });
});

describe("effective-access — role narrowing (admins narrowable, no short-circuit)", () => {
  it("an admin-based role narrows an admin: absent grant row = feature OFF", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-a",
          role: "admin",
          accessRole: role({
            featureGrants: [
              { moduleId: "files", level: "manage" },
              { moduleId: "network", level: "view" },
            ],
          }),
        },
      }),
    );
    // granted modules present at their level
    expect(featureLevel(res, "files")).toBe("manage");
    expect(featureLevel(res, "network")).toBe("view");
    // ungranted modules are OFF — the admin IS narrowed
    expect(featureLevel(res, "cameras")).toBeUndefined();
    expect(featureLevel(res, "email")).toBeUndefined();
    // chat can never be narrowed off (always-on floor)
    expect(featureLevel(res, "chat")).toBe("act");
  });

  it("grant levels are clamped to the startingPoint tier's §9 ceiling", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-f",
          role: "family",
          accessRole: role({
            featureGrants: [
              { moduleId: "network", level: "manage" }, // floors at admin → view
              { moduleId: "files", level: "manage" }, // family may hold manage
            ],
          }),
        },
      }),
    );
    expect(featureLevel(res, "network")).toBe("view");
    expect(featureLevel(res, "files")).toBe("manage");
  });

  it("role tool grants are the domain allowlist, intersected with feature domains", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-f",
          role: "family",
          accessRole: role({
            featureGrants: [
              { moduleId: "files", level: "act" },
              { moduleId: "calendar", level: "act" },
            ],
            toolGrants: [
              { domain: "files", level: "use" },
              { domain: "network", level: "use" }, // network feature OFF → dropped
              { domain: "system", level: "view" }, // unclaimed → passes module filter
            ],
          }),
        },
      }),
    );
    expect(res.toolDomains).toContain("files");
    expect(res.toolDomains).toContain("system");
    expect(res.toolDomains).not.toContain("network");
    // calendar feature on, but NO tool grant row → domain absent (absent row = OFF)
    expect(res.toolDomains).not.toContain("calendar");
  });
});

describe("effective-access — exceptions ⊕ with clamp", () => {
  it("deny removes a module the role (or tier) would grant", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        exceptions: [{ id: "x1", moduleId: "cameras", effect: "deny", level: null }],
      }),
    );
    expect(featureLevel(res, "cameras")).toBeUndefined();
  });

  it("allow adds a module the role left off, clamped to the tier ceiling", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-f",
          role: "family",
          accessRole: role({ featureGrants: [{ moduleId: "files", level: "act" }] }),
        },
        exceptions: [
          { id: "x1", moduleId: "cameras", effect: "allow", level: "act" },
          { id: "x2", moduleId: "network", effect: "allow", level: "manage" }, // clamps to view
        ],
      }),
    );
    expect(featureLevel(res, "cameras")).toBe("act");
    expect(featureLevel(res, "network")).toBe("view");
  });

  it("exceptions ride the response verbatim (T8 seeds its editor from them)", () => {
    const exceptions = [
      { id: "x1", moduleId: "cameras" as ModuleId, effect: "deny" as const, level: null },
    ];
    const res = computeEffectiveAccess(baseInputs({ exceptions }));
    expect(res.exceptions).toEqual(exceptions);
  });
});

describe("effective-access — workspace-module intersection", () => {
  it("a workspace-disabled module drops out of features AND its tool domains", () => {
    const workspace = new Set<ModuleId>(ALL_MODULES);
    workspace.delete("cameras");
    workspace.delete("calendar");
    const res = computeEffectiveAccess(baseInputs({ workspaceModuleIds: workspace }));
    expect(featureLevel(res, "cameras")).toBeUndefined();
    expect(featureLevel(res, "calendar")).toBeUndefined();
    expect(res.toolDomains).not.toContain("cameras");
    expect(res.toolDomains).not.toContain("calendar");
    expect(res.toolDomains).not.toContain("reminders");
    expect(res.toolDomains).not.toContain("notifications");
    // an exception cannot resurrect a workspace-off module
    const res2 = computeEffectiveAccess(
      baseInputs({
        workspaceModuleIds: workspace,
        exceptions: [{ id: "x", moduleId: "cameras", effect: "allow", level: "view" }],
      }),
    );
    expect(featureLevel(res2, "cameras")).toBeUndefined();
  });
});

describe("effective-access — locks gate", () => {
  it("role.mayOperateLocks AND smart_home effective", () => {
    const withLocks = (grants: Array<{ moduleId: ModuleId; level: "view" | "act" | "manage" }>, may = true) =>
      computeEffectiveAccess(
        baseInputs({
          user: {
            id: "u",
            role: "family",
            accessRole: role({ mayOperateLocks: may, featureGrants: grants }),
          },
        }),
      ).locks;
    expect(withLocks([{ moduleId: "smart_home", level: "act" }])).toBe(true);
    expect(withLocks([])).toBe(false); // smart_home off → no locks
    expect(withLocks([{ moduleId: "smart_home", level: "act" }], false)).toBe(false);
  });

  it("a deny exception on smart_home turns locks off too", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u",
          role: "family",
          accessRole: role({
            mayOperateLocks: true,
            featureGrants: [{ moduleId: "smart_home", level: "act" }],
          }),
        },
        exceptions: [{ id: "x", moduleId: "smart_home", effect: "deny", level: null }],
      }),
    );
    expect(res.locks).toBe(false);
  });
});

describe("effective-access — cloud AND-gate", () => {
  it("workspace escape AND role.cloudModelsAllowed", () => {
    const cloud = (workspace: boolean, roleAllowed: boolean) =>
      computeEffectiveAccess(
        baseInputs({
          cloudEscapeEnabled: workspace,
          user: {
            id: "u",
            role: "family",
            accessRole: role({ cloudModelsAllowed: roleAllowed }),
          },
        }),
      ).cloud;
    expect(cloud(true, true)).toBe(true);
    expect(cloud(true, false)).toBe(false);
    expect(cloud(false, true)).toBe(false);
    expect(cloud(false, false)).toBe(false);
  });

  it("null accessRoleId keeps today's workspace-only gate", () => {
    expect(computeEffectiveAccess(baseInputs({ cloudEscapeEnabled: true })).cloud).toBe(true);
    expect(computeEffectiveAccess(baseInputs()).cloud).toBe(false);
  });
});

describe("effective-access — connector min", () => {
  const conns = [{ provider: "eaglesoft", writeEnabled: false }];
  const connsRw = [{ provider: "eaglesoft", writeEnabled: true }];

  it("min(role grant, connection level): read_write grant × read-only connection → read", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        connections: conns,
        user: {
          id: "u",
          role: "admin",
          accessRole: role({ connectorGrants: [{ provider: "eaglesoft", level: "read_write" }] }),
        },
      }),
    );
    expect(res.connectors).toEqual({ eaglesoft: "read" });
  });

  it("read grant × write-enabled connection → read; read_write × write-enabled → read_write", () => {
    const read = computeEffectiveAccess(
      baseInputs({
        connections: connsRw,
        user: {
          id: "u",
          role: "admin",
          accessRole: role({ connectorGrants: [{ provider: "eaglesoft", level: "read" }] }),
        },
      }),
    );
    expect(read.connectors).toEqual({ eaglesoft: "read" });
    const rw = computeEffectiveAccess(
      baseInputs({
        connections: connsRw,
        user: {
          id: "u",
          role: "admin",
          accessRole: role({ connectorGrants: [{ provider: "eaglesoft", level: "read_write" }] }),
        },
      }),
    );
    expect(rw.connectors).toEqual({ eaglesoft: "read_write" });
  });

  it("no grant row = no reach; a grant without a connection = no reach", () => {
    const noGrant = computeEffectiveAccess(
      baseInputs({
        connections: connsRw,
        user: { id: "u", role: "admin", accessRole: role() },
      }),
    );
    expect(noGrant.connectors).toEqual({});
    const noConn = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u",
          role: "admin",
          accessRole: role({ connectorGrants: [{ provider: "eaglesoft", level: "read" }] }),
        },
      }),
    );
    expect(noConn.connectors).toEqual({});
  });

  it("null accessRoleId: admin tier keeps today's connection-level reach; family/guest none", () => {
    const admin = computeEffectiveAccess(
      baseInputs({ connections: connsRw, user: { id: "u", role: "admin", accessRole: null } }),
    );
    expect(admin.connectors).toEqual({ eaglesoft: "read_write" });
    const family = computeEffectiveAccess(baseInputs({ connections: connsRw }));
    expect(family.connectors).toEqual({});
  });

  it("owner reaches every connection at its writeEnabled level", () => {
    const res = computeEffectiveAccess(
      baseInputs({ connections: conns, user: { id: "u", role: "owner", accessRole: null } }),
    );
    expect(res.connectors).toEqual({ eaglesoft: "read" });
  });
});

describe("effective-access — usage passthrough (T7)", () => {
  it("person ?? role ?? default, field-by-field, BigInt string-encoded, sources carried", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        usagePolicy: { storageQuotaBytes: 5_000_000_000n, maxUploadSizeMb: null, llmDailyMessageCap: null },
        user: {
          id: "u",
          role: "family",
          accessRole: role({ storageQuotaBytes: 9_000_000_000n, maxUploadSizeMb: 200, llmDailyMessageCap: null }),
        },
      }),
    );
    expect(res.usage.storageQuotaBytes).toBe("5000000000"); // person wins
    expect(res.usage.maxUploadSizeMb).toBe(200); // role default fills the unset field
    expect(res.usage.llmDailyMessageCap).toBeNull(); // box default
    expect(res.usage.source).toBe("person"); // headline = storage field's source
    expect(res.usage.sources).toEqual({
      storageQuotaBytes: "person",
      maxUploadSizeMb: "role",
      llmDailyMessageCap: "default",
    });
  });

  it("no policy row and no role resolves all-default (today's behavior)", () => {
    const res = computeEffectiveAccess(baseInputs());
    expect(res.usage).toEqual({
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      source: "default",
      sources: {
        storageQuotaBytes: "default",
        maxUploadSizeMb: "default",
        llmDailyMessageCap: "default",
      },
    });
  });
});

describe("effective-access — deptRights are a read-only reference", () => {
  it("passes department rights through untouched (ADR-029 owns them)", () => {
    const deptRights = [{ id: "d1", name: "Reception", right: "contributor" }];
    const res = computeEffectiveAccess(baseInputs({ deptRights }));
    expect(res.deptRights).toEqual(deptRights);
  });
});

describe("resolveEffectiveAccess — bound fetch wrapper", () => {
  it("returns null for a missing user (route maps to 404)", async () => {
    const prisma: any = {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    _setEffectiveAccessForTests(prisma, {} as any);
    await expect(resolveEffectiveAccess("nope")).resolves.toBeNull();
    _setEffectiveAccessForTests(null, null);
  });

  it("throws when unwired (fail closed, scope-loader posture)", async () => {
    _setEffectiveAccessForTests(null, null);
    await expect(resolveEffectiveAccess("u-1")).rejects.toThrow(/not initialised/);
  });
});
