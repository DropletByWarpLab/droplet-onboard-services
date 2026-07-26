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

// ── WARP-1528 (T4 / QA) — the always-on floor is intersection-EXEMPT ──
//
// `chat` is a CORE module, and core modules are exempt from workspace
// enablement everywhere else in the system: app.ts's workspace gate does
// `if (def.core) continue`, so `/api/llm` is never enablement-gated, and the
// owner branch above returns before the intersection so owners keep `chat`
// unconditionally. But `chat`'s registry availability is
// `isSet(AI_GATEWAY_URL)`, so on a box with that env unset it drops out of the
// workspace-effective set — and only ROLE-HOLDERS reach the intersection.
// The resolver was therefore applying a narrowing to the always-on floor that
// neither the workspace gate nor the owner path applies: an inconsistency, not
// a design choice. Worse, it made the "a person's feature set can never be
// empty" invariant — which the dashboard's fail-open guard leans on — false.
describe("effective-access — always-on floor survives the workspace intersection", () => {
  it("a role-holder on a box with AI_GATEWAY_URL unset still resolves `chat`", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: { id: "u-1", role: "family", accessRole: role({ featureGrants: [] }) },
        // Availability is off for chat → it is absent from the workspace set.
        workspaceModuleIds: new Set<ModuleId>(GATEABLE_MODULE_IDS as ModuleId[]),
      }),
    );
    expect(featureLevel(res, "chat")).toBe("act");
    // …and the set is therefore never empty, which is the load-bearing part.
    expect(res.features.length).toBeGreaterThan(0);
  });

  it("a grantless role on a gateway-less box resolves to the floor, NOT an empty set", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: { id: "u-1", role: "guest", accessRole: role({ featureGrants: [] }) },
        workspaceModuleIds: new Set<ModuleId>(),
      }),
    );
    expect(res.features).toEqual([{ moduleId: "chat", level: "act" }]);
  });

  it("still intersects every GATEABLE module against the workspace", () => {
    // The exemption is scoped to the always-on floor — it must not become a
    // hole that lets workspace-disabled features through.
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-1",
          role: "family",
          accessRole: role({
            featureGrants: [
              { moduleId: "files", level: "manage" },
              { moduleId: "cameras", level: "view" },
            ],
          }),
        },
        workspaceModuleIds: new Set<ModuleId>(["files"]),
      }),
    );
    expect(featureLevel(res, "files")).toBe("manage");
    expect(featureLevel(res, "cameras")).toBeUndefined();
    expect(featureLevel(res, "chat")).toBe("act");
  });

  it("a role-LESS person keeps the floor too when the gateway is unset", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: { id: "u-1", role: "family", accessRole: null },
        workspaceModuleIds: new Set<ModuleId>(),
      }),
    );
    expect(featureLevel(res, "chat")).toBe("act");
  });

  it("owners are unaffected — they never reached the intersection anyway", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: { id: "u-1", role: "owner", accessRole: null },
        workspaceModuleIds: new Set<ModuleId>(),
      }),
    );
    expect(featureLevel(res, "chat")).toBe("act");
  });
});

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

describe("effective-access — archive is not revoke (C2)", () => {
  it("an ARCHIVED role still resolves its grants for existing members (archive is not revoke)", () => {
    // Deliberate semantics, pinned so a future 'archived ⇒ no access'
    // change has to break a test and argue for itself: archiving stops a
    // role being ASSIGNABLE (both assign paths 409), it never silently
    // strips access from the people already holding it. The resolver
    // therefore does not read AccessRole.state at all.
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-arch",
          role: "family",
          accessRole: role({ featureGrants: [{ moduleId: "files", level: "act" }] }),
        },
      }),
    );
    expect(featureLevel(res, "files")).toBe("act");
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

// ── WARP-1585 — declared module dependencies (`ModuleDef.requires`) ──
//
// `docs` has no surface of its own (registry `navHrefs: []`): the substantive
// act is minting an editor session for a Nextcloud path, which lives on
// `/api/files/:filePath(*)/editor-session` and is gated by `files`. So a
// Documents grant with no Files grant grants nothing reachable — which is
// exactly the dishonest direction this ticket exists to close. The resolver
// applies the registry's dependency closure right after the workspace
// intersection, so the RESOLVED set never claims a capability the person
// can't actually use, and `effectiveForUser` stays truthful for the dashboard.
//
// `knowledge` deliberately has NO such edge: it reads FileContentChunk rows
// out of the orchestrator's own Postgres (sources `nextcloud` AND `brain`)
// behind FILE_INDEXER_URL, so it stands on its own and must survive a
// files-less grant untouched.
describe("effective-access — declared module dependencies (WARP-1585)", () => {
  it("drops docs when the person holds no files grant", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-2",
          role: "family",
          accessRole: role({
            featureGrants: [
              { moduleId: "docs", level: "manage" },
              { moduleId: "knowledge", level: "view" },
            ],
          }),
        },
      }),
    );
    expect(featureLevel(res, "docs")).toBeUndefined();
    // …and knowledge, which declares no parent, is untouched.
    expect(featureLevel(res, "knowledge")).toBe("view");
  });

  it("keeps docs when files is held alongside it", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-3",
          role: "family",
          accessRole: role({
            featureGrants: [
              { moduleId: "files", level: "view" },
              { moduleId: "docs", level: "act" },
            ],
          }),
        },
      }),
    );
    expect(featureLevel(res, "files")).toBe("view");
    expect(featureLevel(res, "docs")).toBe("act");
  });

  it("an ALLOW exception cannot resurrect docs without files", () => {
    // Same rule as the workspace intersection: exceptions widen within the
    // model, they don't suspend it.
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-4",
          role: "family",
          accessRole: role({ featureGrants: [{ moduleId: "knowledge", level: "view" }] }),
        },
        exceptions: [{ id: "x", moduleId: "docs", effect: "allow", level: "manage" }],
      }),
    );
    expect(featureLevel(res, "docs")).toBeUndefined();
  });

  it("a DENY exception on files also drops docs", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u-5",
          role: "family",
          accessRole: role({
            featureGrants: [
              { moduleId: "files", level: "manage" },
              { moduleId: "docs", level: "manage" },
            ],
          }),
        },
        exceptions: [{ id: "x", moduleId: "files", effect: "deny", level: null }],
      }),
    );
    expect(featureLevel(res, "files")).toBeUndefined();
    expect(featureLevel(res, "docs")).toBeUndefined();
  });

  it("the owner bypass is outside the dependency closure, like every other intersection", () => {
    const res = computeEffectiveAccess(
      baseInputs({ user: { id: "o", role: "owner", accessRole: null } }),
    );
    expect(featureLevel(res, "docs")).toBe("manage");
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

/**
 * WARP-1579 — the RAW grant, reported BESIDE the min().
 *
 * `connectors` folds `connection.writeEnabled` into the level, which makes
 * "the role is read-only" and "the connection has writes off" the same value.
 * The ERP write gate has to tell those apart — one is a 403 about the role,
 * the other today's 409 `WRITE_NOT_ENABLED` about the connection — so the
 * resolver reports the role's own grant untouched as well.
 *
 * `null` means "no custom role narrows this axis": role-less people and owners
 * (§3's one bypass). It is deliberately NOT `{}`, which is the sharply
 * different "this role holds no connector grants at all".
 */
describe("effective-access — raw connector grants (WARP-1579)", () => {
  const connsRw = [{ provider: "eaglesoft", writeEnabled: true }];
  const connsRo = [{ provider: "eaglesoft", writeEnabled: false }];

  it("reports the role's own level, unclamped by the connection, beside the min()", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        connections: connsRo,
        user: {
          id: "u",
          role: "admin",
          accessRole: role({ connectorGrants: [{ provider: "eaglesoft", level: "read_write" }] }),
        },
      }),
    );
    expect(res.connectors).toEqual({ eaglesoft: "read" }); // min() unchanged
    expect(res.connectorGrants).toEqual({ eaglesoft: "read_write" }); // the raw fact
  });

  it("distinguishes a read-only ROLE from a write-disabled CONNECTION — both min() to 'read'", () => {
    const readOnlyRole = computeEffectiveAccess(
      baseInputs({
        connections: connsRw,
        user: {
          id: "u",
          role: "admin",
          accessRole: role({ connectorGrants: [{ provider: "eaglesoft", level: "read" }] }),
        },
      }),
    );
    const readOnlyConnection = computeEffectiveAccess(
      baseInputs({
        connections: connsRo,
        user: {
          id: "u",
          role: "admin",
          accessRole: role({ connectorGrants: [{ provider: "eaglesoft", level: "read_write" }] }),
        },
      }),
    );
    expect(readOnlyRole.connectors).toEqual(readOnlyConnection.connectors);
    expect(readOnlyRole.connectorGrants).toEqual({ eaglesoft: "read" });
    expect(readOnlyConnection.connectorGrants).toEqual({ eaglesoft: "read_write" });
  });

  it("reports a grant even when NO connection exists — the role's intent is not a connection fact", () => {
    const res = computeEffectiveAccess(
      baseInputs({
        user: {
          id: "u",
          role: "admin",
          accessRole: role({ connectorGrants: [{ provider: "eaglesoft", level: "read_write" }] }),
        },
      }),
    );
    expect(res.connectors).toEqual({}); // no connection = no reach
    expect(res.connectorGrants).toEqual({ eaglesoft: "read_write" });
  });

  it("{} for a role holding no connector grants — sharply different from null", () => {
    const res = computeEffectiveAccess(
      baseInputs({ connections: connsRw, user: { id: "u", role: "admin", accessRole: role() } }),
    );
    expect(res.connectorGrants).toEqual({});
  });

  it("null for a role-LESS person and for an owner — nothing narrows this axis", () => {
    const roleLess = computeEffectiveAccess(
      baseInputs({ connections: connsRw, user: { id: "u", role: "admin", accessRole: null } }),
    );
    expect(roleLess.connectorGrants).toBeNull();
    const owner = computeEffectiveAccess(
      baseInputs({ connections: connsRw, user: { id: "u", role: "owner", accessRole: null } }),
    );
    expect(owner.connectorGrants).toBeNull();
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
