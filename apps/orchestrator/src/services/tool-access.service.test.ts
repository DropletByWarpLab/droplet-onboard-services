/**
 * WARP-1529 / ADR-032 §3 axis d (RBAC v2 T5) — per-role tool-domain narrowing.
 *
 * Pins the ONE predicate both enforcement points share (the catalog build in
 * routes/llm.ts and the fail-closed dispatch re-check in
 * llm-agent.service.ts), plus the scope resolver's fail-closed posture and
 * the "no AccessRole = today, bit-for-bit" floor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TOOL_CATALOG, TOOL_DOMAINS } from "@droplet/tools-core";
import { MODULES } from "../modules/module-registry.js";
import {
  DENY_ALL_TOOL_SCOPE,
  firstForbiddenToolName,
  isLockLikeInvocation,
  lockOperationDenied,
  narrowToolNamesToScope,
  resolveAttributedToolAccess,
  resolveToolAccessScope,
  toolAllowedInScope,
  type ToolAccessScope,
} from "./tool-access.service.js";

const scopeOf = (
  domains: string[],
  writeDomains: string[] = [],
  locks = false,
): ToolAccessScope => ({
  domains: new Set(domains),
  writeDomains: new Set(writeDomains),
  locks,
});

// Two real registry names per domain, one read + one write — the whole point
// is that `requiresWrite` is read off tools-core, never hand-listed here.
const nameOf = (domain: string, write: boolean): string => {
  const entry = TOOL_CATALOG.find(
    (t) => t.domain === domain && t.requiresWrite === write,
  );
  if (!entry) throw new Error(`no ${write ? "write" : "read"} tool in ${domain}`);
  return entry.name;
};

describe("toolAllowedInScope — the shared narrowing predicate", () => {
  it("`view` on a domain keeps its read tools and drops its write tools", () => {
    // view = the domain is reachable but NOT write-capable.
    const scope = scopeOf(["files"]);
    expect(toolAllowedInScope(nameOf("files", false), scope)).toBe(true);
    expect(toolAllowedInScope(nameOf("files", true), scope)).toBe(false);
  });

  it("`use` on a domain keeps its write tools too", () => {
    const scope = scopeOf(["files"], ["files"]);
    expect(toolAllowedInScope(nameOf("files", false), scope)).toBe(true);
    expect(toolAllowedInScope(nameOf("files", true), scope)).toBe(true);
  });

  it("drops a domain the scope does not contain, reads included", () => {
    const scope = scopeOf(["files"], ["files"]);
    expect(toolAllowedInScope(nameOf("cameras", false), scope)).toBe(false);
    expect(toolAllowedInScope(nameOf("cameras", true), scope)).toBe(false);
  });

  it("fails closed on a tool with no catalog entry", () => {
    expect(toolAllowedInScope("knowledge_base_search", scopeOf([...TOOL_DOMAINS], [...TOOL_DOMAINS]))).toBe(
      false,
    );
  });

  it("write-capability never widens past the domain set (use without reach)", () => {
    // A `use` grant on a domain the module axis dropped is inert.
    const scope = scopeOf([], ["cameras"]);
    expect(toolAllowedInScope(nameOf("cameras", true), scope)).toBe(false);
  });

  it("DENY_ALL_TOOL_SCOPE admits nothing", () => {
    for (const entry of TOOL_CATALOG) {
      expect(toolAllowedInScope(entry.name, DENY_ALL_TOOL_SCOPE)).toBe(false);
    }
  });
});

describe("narrowToolNamesToScope", () => {
  it("filters a requested list, preserving order and dropping unknowns", () => {
    const read = nameOf("files", false);
    const write = nameOf("files", true);
    const other = nameOf("cameras", false);
    expect(
      narrowToolNamesToScope([read, write, other, "not_a_tool"], scopeOf(["files"])),
    ).toEqual([read]);
  });
});

describe("lockOperationDenied — mayOperateLocks (§3 locks)", () => {
  const noLocks = scopeOf(["smart-home"], ["smart-home"], false);
  const withLocks = scopeOf(["smart-home"], ["smart-home"], true);

  it("denies a lock command when the role lacks mayOperateLocks", () => {
    expect(
      lockOperationDenied("control_device", { node_id: "n1", command: "lock" }, noLocks),
    ).toBe(true);
    expect(
      lockOperationDenied("control_device", { node_id: "n1", command: "unlock" }, noLocks),
    ).toBe(true);
  });

  it("denies the handler's documented bypass shapes (synonyms, data stuffing)", () => {
    for (const args of [
      { command: "LOCK" },
      { command: "lock_door" },
      { command: "set_lock" },
      { command: "set_state", data: { set_locked: true } },
      { command: "set_state", data: { lockState: "locked" } },
      { command: "set_state", data: { mode: "unlock" } },
    ]) {
      expect(lockOperationDenied("control_device", args, noLocks)).toBe(true);
    }
  });

  it("allows a lock command when the role holds mayOperateLocks (handler still confirms)", () => {
    expect(
      lockOperationDenied("control_device", { node_id: "n1", command: "lock" }, withLocks),
    ).toBe(false);
  });

  it("never blocks ordinary smart-home control", () => {
    expect(
      lockOperationDenied("control_device", { node_id: "n1", command: "turn_on" }, noLocks),
    ).toBe(false);
    expect(
      lockOperationDenied(
        "control_device",
        { node_id: "n1", command: "set_brightness", data: { brightness: 40 } },
        noLocks,
      ),
    ).toBe(false);
  });

  it("only guards control_device — scene-level lock analysis is not this gate", () => {
    expect(lockOperationDenied("run_scene", { command: "lock" }, noLocks)).toBe(false);
  });

  it("isLockLikeInvocation tolerates a non-object args payload", () => {
    expect(isLockLikeInvocation(undefined)).toBe(false);
    expect(isLockLikeInvocation({})).toBe(false);
  });
});

// ── module-registry ↔ tools-core vocabulary ────────────────────────
//
// WHICH domains each module claims (the calendar/reminders/notifications
// grouping, knowledge→memory, projects→pm, smart_home→smart-home, and the
// four unclaimed pass-through domains) is asserted by T3's
// access-catalog.test.ts — that suite owns the grouping and this one does
// NOT fork it. What is pinned here is the one thing T3 cannot see from the
// resolved side: that no registry entry names a domain tools-core has never
// heard of. A typo there is silent — `domainsForFeatures` would simply never
// match it, and the module would gate nothing.
describe("module-registry toolDomains vocabulary", () => {
  it("every registry toolDomain is a real tools-core catalog domain", () => {
    const known = new Set<string>(TOOL_DOMAINS);
    for (const def of MODULES) {
      for (const d of def.toolDomains) {
        expect(known.has(d), `module ${def.id} claims unknown domain '${d}'`).toBe(true);
      }
    }
  });
});

// ── the resolver ────────────────────────────────────────────────────
const resolveEffectiveAccessMock = vi.hoisted(() => vi.fn());
vi.mock("./effective-access.service.js", () => ({
  resolveEffectiveAccess: resolveEffectiveAccessMock,
}));

interface FakeUserRow {
  accessRoleId: string | null;
  accessRole: { toolGrants: Array<{ domain: string; level: "view" | "use" }> } | null;
}

const fakePrisma = (row: FakeUserRow | null | Error) =>
  ({
    user: {
      findUnique: vi.fn(async () => {
        if (row instanceof Error) throw row;
        return row;
      }),
    },
  }) as never;

describe("resolveToolAccessScope", () => {
  beforeEach(() => {
    resolveEffectiveAccessMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null (no narrowing) for the owner — §3 owner bypass", async () => {
    const prisma = fakePrisma({ accessRoleId: "r1", accessRole: { toolGrants: [] } });
    await expect(
      resolveToolAccessScope(prisma, { id: "u1", role: "owner" }),
    ).resolves.toBeNull();
  });

  it("returns null for service principals and for an absent principal", async () => {
    const prisma = fakePrisma({ accessRoleId: "r1", accessRole: { toolGrants: [] } });
    await expect(
      resolveToolAccessScope(prisma, { id: "_service:voice", role: "service" }),
    ).resolves.toBeNull();
    await expect(resolveToolAccessScope(prisma, undefined)).resolves.toBeNull();
  });

  it("returns null for a user with no AccessRole — today's world, bit-for-bit", async () => {
    const prisma = fakePrisma({ accessRoleId: null, accessRole: null });
    await expect(
      resolveToolAccessScope(prisma, { id: "u1", role: "family" }),
    ).resolves.toBeNull();
    // The heavy §3 resolve is not even consulted on this path.
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("composes T3 toolDomains + grant levels for a role holder", async () => {
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["files", "cameras"],
      locks: true,
    });
    const scope = await resolveToolAccessScope(
      fakePrisma({
        accessRoleId: "r1",
        accessRole: {
          toolGrants: [
            { domain: "files", level: "use" },
            { domain: "cameras", level: "view" },
            // granted but dropped upstream by the module/tier axes
            { domain: "network", level: "use" },
          ],
        },
      }),
      { id: "u1", role: "admin" },
    );
    expect(scope).not.toBeNull();
    expect([...scope!.domains].sort()).toEqual(["cameras", "files"]);
    expect([...scope!.writeDomains]).toEqual(["files"]);
    expect(scope!.locks).toBe(true);
  });

  it("keeps a non-privileged tier write-free even when the role grants `use`", async () => {
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "family",
      toolDomains: ["files"],
      locks: false,
    });
    const scope = await resolveToolAccessScope(
      fakePrisma({
        accessRoleId: "r1",
        accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
      }),
      { id: "u1", role: "family" },
    );
    expect([...scope!.domains]).toEqual(["files"]);
    expect([...scope!.writeDomains]).toEqual([]);
  });

  it("fails CLOSED when the user row is missing", async () => {
    await expect(
      resolveToolAccessScope(fakePrisma(null), { id: "ghost", role: "family" }),
    ).resolves.toEqual(DENY_ALL_TOOL_SCOPE);
  });

  it("fails CLOSED when the read throws", async () => {
    await expect(
      resolveToolAccessScope(fakePrisma(new Error("db down")), {
        id: "u1",
        role: "family",
      }),
    ).resolves.toEqual(DENY_ALL_TOOL_SCOPE);
  });

  it("fails CLOSED when the §3 resolve throws or returns null", async () => {
    const row: FakeUserRow = {
      accessRoleId: "r1",
      accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
    };
    resolveEffectiveAccessMock.mockRejectedValueOnce(new Error("unwired"));
    await expect(
      resolveToolAccessScope(fakePrisma(row), { id: "u1", role: "family" }),
    ).resolves.toEqual(DENY_ALL_TOOL_SCOPE);
    resolveEffectiveAccessMock.mockResolvedValueOnce(null);
    await expect(
      resolveToolAccessScope(fakePrisma(row), { id: "u1", role: "family" }),
    ).resolves.toEqual(DENY_ALL_TOOL_SCOPE);
  });

  it("fails CLOSED when a role-tier principal carries no user id", async () => {
    await expect(
      resolveToolAccessScope(fakePrisma(null), { role: "family" }),
    ).resolves.toEqual(DENY_ALL_TOOL_SCOPE);
  });
});

// ── WARP-1580: the pre-flight + the attributed principal ────────────

describe("firstForbiddenToolName — the whole-list pre-flight", () => {
  it("returns the FIRST out-of-reach name so the refusal names one tool", () => {
    const scope = scopeOf(["files"], ["files"]);
    expect(
      firstForbiddenToolName(
        [nameOf("files", false), nameOf("cameras", false), nameOf("network", false)],
        scope,
      ),
    ).toBe(nameOf("cameras", false));
  });

  it("returns null when every name is in reach", () => {
    const scope = scopeOf(["files"], ["files"]);
    expect(
      firstForbiddenToolName([nameOf("files", false), nameOf("files", true)], scope),
    ).toBeNull();
  });

  it("treats a null/absent scope as no narrowing (owner, service, role-less)", () => {
    expect(firstForbiddenToolName(["control_device", "not_a_tool"], null)).toBeNull();
    expect(firstForbiddenToolName(["control_device"], undefined)).toBeNull();
  });

  it("fails closed on an unregistered name under a scope", () => {
    expect(firstForbiddenToolName(["not_a_tool"], scopeOf([...TOOL_DOMAINS]))).toBe(
      "not_a_tool",
    );
  });

  it("admits nothing under DENY_ALL_TOOL_SCOPE", () => {
    expect(firstForbiddenToolName([nameOf("files", false)], DENY_ALL_TOOL_SCOPE)).toBe(
      nameOf("files", false),
    );
  });
});

interface FakeAttributedRow {
  role: string;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
  accessRoleId: string | null;
  accessRole: { toolGrants: Array<{ domain: string; level: "view" | "use" }> } | null;
}

const fakeAttributedPrisma = (row: FakeAttributedRow | null | Error) =>
  ({
    user: {
      findUnique: vi.fn(async () => {
        if (row instanceof Error) throw row;
        return row;
      }),
    },
  }) as never;

describe("resolveAttributedToolAccess — the no-token principal", () => {
  beforeEach(() => {
    resolveEffectiveAccessMock.mockReset();
  });

  it("DENIES an absent principal — the inversion vs. the request path", async () => {
    // resolveToolAccessScope(undefined) means "AUTH_ENABLED=false, owner".
    // Here it means "we do not know who is asking", which must never widen.
    await expect(
      resolveAttributedToolAccess(fakeAttributedPrisma(null), null),
    ).resolves.toEqual({ scope: DENY_ALL_TOOL_SCOPE, unresolved: "no_principal" });
  });

  it("DENIES a principal whose row no longer exists", async () => {
    await expect(
      resolveAttributedToolAccess(fakeAttributedPrisma(null), "ghost"),
    ).resolves.toEqual({ scope: DENY_ALL_TOOL_SCOPE, unresolved: "user_missing" });
  });

  it("DENIES a deactivated principal even at owner tier", async () => {
    await expect(
      resolveAttributedToolAccess(
        fakeAttributedPrisma({
          role: "owner",
          directoryStatus: "DEACTIVATED",
          accessRoleId: null,
          accessRole: null,
        }),
        "u1",
      ),
    ).resolves.toEqual({ scope: DENY_ALL_TOOL_SCOPE, unresolved: "user_deactivated" });
  });

  it("DENIES when the row read throws", async () => {
    await expect(
      resolveAttributedToolAccess(fakeAttributedPrisma(new Error("db down")), "u1"),
    ).resolves.toEqual({ scope: DENY_ALL_TOOL_SCOPE, unresolved: "read_failed" });
  });

  it("bypasses for an ACTIVE owner — row-derived, no §3 resolve", async () => {
    await expect(
      resolveAttributedToolAccess(
        fakeAttributedPrisma({
          role: "owner",
          directoryStatus: "ACTIVE",
          accessRoleId: null,
          accessRole: null,
        }),
        "u1",
      ),
    ).resolves.toEqual({ scope: null, unresolved: null });
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("does not narrow a role-less person — today's world, bit-for-bit", async () => {
    await expect(
      resolveAttributedToolAccess(
        fakeAttributedPrisma({
          role: "family",
          directoryStatus: "ACTIVE",
          accessRoleId: null,
          accessRole: null,
        }),
        "u1",
      ),
    ).resolves.toEqual({ scope: null, unresolved: null });
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("composes the SAME scope the request path does for a role holder", async () => {
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["files"],
      locks: false,
    });
    const row: FakeAttributedRow = {
      role: "admin",
      directoryStatus: "ACTIVE",
      accessRoleId: "r1",
      accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
    };
    const attributed = await resolveAttributedToolAccess(
      fakeAttributedPrisma(row),
      "u1",
    );
    const viaRequest = await resolveToolAccessScope(
      fakePrisma({ accessRoleId: "r1", accessRole: row.accessRole }),
      { id: "u1", role: "admin" },
    );
    expect(attributed.unresolved).toBeNull();
    expect(attributed.scope).toEqual(viaRequest);
  });

  it("DENIES when the §3 resolve fails for an attributed role holder", async () => {
    resolveEffectiveAccessMock.mockRejectedValueOnce(new Error("unwired"));
    const attributed = await resolveAttributedToolAccess(
      fakeAttributedPrisma({
        role: "family",
        directoryStatus: "ACTIVE",
        accessRoleId: "r1",
        accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
      }),
      "u1",
    );
    // `unresolved` stays null — the identity WAS resolved; it is the §3
    // composition that failed, and that already fails closed to DENY_ALL.
    expect(attributed.scope).toEqual(DENY_ALL_TOOL_SCOPE);
  });
});

/**
 * WARP-1582 — the session-claim read elision, and the four properties that
 * make it safe. Every one of these is load-bearing; see the trust argument
 * in tool-access.service.ts.
 */
describe("WARP-1582 — resolveToolAccessScope trust modes", () => {
  beforeEach(() => {
    resolveEffectiveAccessMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DEFAULTS to the database — a call site that says nothing gets the read", async () => {
    // The fail-safe default is the whole reason the parameter is opt-IN.
    // A new consumer that never thought about staleness must not silently
    // inherit the elision.
    const prisma = fakePrisma({ accessRoleId: null, accessRole: null });
    await expect(
      resolveToolAccessScope(prisma, { id: "u1", role: "family", accessRoleId: null }),
    ).resolves.toBeNull();
    expect((prisma as any).user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("elides the read when the claim is PRESENT and says `null`", async () => {
    const prisma = fakePrisma({ accessRoleId: null, accessRole: null });
    await expect(
      resolveToolAccessScope(
        prisma,
        { id: "u1", role: "family", accessRoleId: null },
        "session-claim",
      ),
    ).resolves.toBeNull();
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("READS when the claim is ABSENT — undefined is 'unknown', never 'no role'", async () => {
    // THE fail-open bug this design exists to prevent. Every token minted
    // before this shipped has no claim; reading `undefined` as "no custom
    // role" would drop the T5 narrowing for every one of them.
    const prisma = fakePrisma({
      accessRoleId: "r1",
      accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
    });
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["files"],
      locks: false,
    });
    const scope = await resolveToolAccessScope(
      prisma,
      { id: "u1", role: "family" },
      "session-claim",
    );
    expect((prisma as any).user.findUnique).toHaveBeenCalledTimes(1);
    expect(scope?.domains.has("files")).toBe(true);
  });

  it("READS when the claim NAMES a role — the claim is never the grant source", async () => {
    // A claim can only ever say "no narrowing applies". The grants and the
    // §3 resolve always come from the database.
    const prisma = fakePrisma({
      accessRoleId: "r1",
      accessRole: { toolGrants: [{ domain: "files", level: "view" }] },
    });
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["files"],
      locks: false,
    });
    const scope = await resolveToolAccessScope(
      prisma,
      { id: "u1", role: "family", accessRoleId: "r1" },
      "session-claim",
    );
    expect((prisma as any).user.findUnique).toHaveBeenCalledTimes(1);
    expect(scope?.writeDomains.has("files")).toBe(false);
  });

  it("a claim of `null` that DISAGREES with the row loses under the default mode", async () => {
    // The staleness case made explicit: admin narrowed this person after
    // the token was minted. Session revocation is what normally closes
    // this (see the trust argument); the database mode closes it
    // unconditionally, which is why write-capable surfaces stay on it.
    const prisma = fakePrisma({
      accessRoleId: "r1",
      accessRole: { toolGrants: [] },
    });
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "family",
      toolDomains: ["files"],
      locks: false,
    });
    const scope = await resolveToolAccessScope(prisma, {
      id: "u1",
      role: "family",
      accessRoleId: null,
    });
    expect(scope).not.toBeNull();
    expect(scope?.domains.has("files")).toBe(true);
  });

  it("the claim never rescues a principal with no id — still fails CLOSED", async () => {
    const prisma = fakePrisma(null);
    await expect(
      resolveToolAccessScope(prisma, { role: "family", accessRoleId: null }, "session-claim"),
    ).resolves.toBe(DENY_ALL_TOOL_SCOPE);
  });

  it("owner/service short-circuits are unchanged under either mode", async () => {
    const prisma = fakePrisma({ accessRoleId: "r1", accessRole: { toolGrants: [] } });
    await expect(
      resolveToolAccessScope(prisma, { id: "u1", role: "owner" }, "session-claim"),
    ).resolves.toBeNull();
    await expect(
      resolveToolAccessScope(prisma, { id: "_service:voice", role: "service" }, "session-claim"),
    ).resolves.toBeNull();
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled();
  });
});
