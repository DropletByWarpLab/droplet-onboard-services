/**
 * WARP-1534 (RBAC v2 T10, ADR-032) — the guard-rail invariants that only a
 * REAL Postgres can prove, driven end-to-end through the real routers.
 *
 * WHY A SEPARATE LANE, AND WHY THESE CASES
 *
 * WARP-1570 is the reason this file exists: four blockers reached main
 * CI-green because mocked Prisma answered every question the way the test
 * author expected it to. A hand-written `count()` stub returns whatever the
 * fixture array says — so an in-memory suite asserting "the last operator
 * cannot be demoted" proves only that the STUB counts, never that the rail
 * counts the right rows, inside the right transaction, at the right
 * isolation level. Everything in this file therefore runs against a real DB:
 *
 *   rails 4 + 5   — last-owner / last-operator, as real COUNTs inside the
 *                   real SERIALIZABLE transaction the routes open, on all
 *                   three mutation shapes (demote / disable / remove) and
 *                   across BOTH surfaces;
 *   §9 floor      — the clamp as PERSISTED, read back from the grant tables
 *                   rather than from the route's response body (the response
 *                   can be honest while the write is not);
 *   O-2 connector — read_write clamped to read on a non-admin starting point,
 *                   and RE-floored on the stored rows when a PATCH moves the
 *                   starting point down;
 *   resolver      — the §3 composition over real rows: an `allow` exception
 *                   cannot resurrect a module the workspace does not have,
 *                   and cannot exceed the tier's ceiling;
 *   built-in tier — {accessRoleId: null, tier} through the same rails.
 *
 * The PRE-transaction rails (owner-untouchable, self-action, rank cap,
 * assignable enum) are pure functions of the actor and the target row and are
 * covered as a rail x path matrix in rbac-v2-guard-rails.e2e.test.ts; they
 * are re-asserted here only where a real row is what makes the case honest.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, exactly like
 * access-role.pg.test.ts. Local: scripts/test-orchestrator-pg.sh. CI: the
 * `pg-integration` job in .github/workflows/orchestrator-tests.yml.
 *
 * FIXTURE SCOPING — this DB is shared by the pg suites running in parallel.
 * Every row this file mints is namespaced `warp1534-` and every cleanup and
 * count is scoped to that prefix (the rule access-role.pg.test.ts's beforeEach
 * documents).
 *
 * ONE COUPLING THIS FILE CANNOT NAMESPACE AWAY, stated rather than hidden:
 * rail 5 counts operators BOX-WIDE (`role in (owner, admin) AND
 * directoryStatus = ACTIVE`), because that is the real invariant — "is anyone
 * left who can manage access". So a foreign ACTIVE owner/admin row, seeded by
 * a migration or minted by a future parallel suite, would satisfy the
 * invariant and silently turn every refusal case below into a false PASS
 * (200 where 409 is expected) — the worst failure mode a guard-rail suite can
 * have. `expectNoForeignOperators()` therefore asserts the premise explicitly
 * before those cases, so the day it breaks the suite says WHY instead of
 * quietly going green. Other pg suites DO now create ACTIVE operator rows
 * (tx-isolation, team-chat, team-chat-meetings), so two things hold the
 * premise rather than luck: the pg lane runs --no-file-parallelism (see
 * scripts/test-orchestrator-pg.sh and the pg-integration job), so no other
 * suite's rows are live while this one runs; and every other operator-creating
 * suite deletes its rows in an afterAll, so none persist into this suite. No
 * migration inserts a User.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// The DB-less lane's global setup mocks @prisma/client; this file needs the
// real driver (access-role.pg.test.ts precedent).
vi.unmock("@prisma/client");

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/nextcloud.client.js", () => {
  class NextcloudOcsError extends Error {
    public readonly ocsStatus: number;
    constructor(message: string, ocsStatus: number) {
      super(message);
      this.name = "NextcloudOcsError";
      this.ocsStatus = ocsStatus;
    }
  }
  class NextcloudUserExistsError extends NextcloudOcsError {
    constructor(message = "User already exists") {
      super(message, 102);
      this.name = "NextcloudUserExistsError";
    }
  }
  return {
    ncCheckSetupRequired: vi.fn(),
    ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
    ncLoginWithCredentials: vi.fn(),
    ncDeleteAppPassword: vi.fn().mockResolvedValue(undefined),
    ncGetCurrentUser: vi.fn(),
    ncCreateUser: vi.fn().mockResolvedValue(undefined),
    ncDeleteUser: vi.fn().mockResolvedValue(undefined),
    ncListUsers: vi.fn(),
    ncUpdateUser: vi.fn().mockResolvedValue(undefined),
    ncSetUserEnabled: vi.fn().mockResolvedValue(undefined),
    ncGetUserQuotaAdmin: vi.fn().mockResolvedValue(null),
    ncOAuth2AuthorizeUrl: vi.fn(),
    ncOAuth2ExchangeCode: vi.fn(),
    ncOAuth2RefreshToken: vi.fn(),
    NextcloudOcsError,
    NextcloudUserExistsError,
  };
});

vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("test-nc-token"),
}));

vi.mock("../services/password.service.js", () => ({
  hashPassword: vi.fn(async () => "$argon2id$stub"),
  verifyPassword: vi.fn().mockResolvedValue(true),
  verifyDummyPassword: vi.fn().mockResolvedValue(false),
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

const { revokeAllSessionsMock } = vi.hoisted(() => ({
  revokeAllSessionsMock: vi.fn(async (_userId: string) => 1),
}));

// Leaf EFFECTS are mocked; every DECISION is real. Mocking revoke/NC/activity
// keeps the suite off Redis and Nextcloud without touching a single rail.
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({ kind: "ok", record: {} })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: (...args: unknown[]) => revokeAllSessionsMock(...(args as [string])),
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  denylistUser: vi.fn().mockResolvedValue(undefined),
  isUserDenied: vi.fn().mockResolvedValue(false),
}));
vi.mock("../services/department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic-token"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
}));
vi.mock("../services/nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/department-reconciler.service.js", () => ({
  kickReconcile: vi.fn(),
}));

import { createPeopleRouter } from "../routes/people.js";
import { createAccessRouter } from "../routes/access.js";
import { createProtectedAuthRouter } from "../routes/auth.js";
import {
  _setEffectiveAccessForTests,
  resolveEffectiveAccess,
} from "../services/effective-access.service.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

/**
 * Module AVAILABILITY is config-derived, not DB-derived (module-registry's
 * `available(cfg)`), so varying it is how this suite moves a module in and out
 * of the workspace-effective set WITHOUT writing `ModuleSetting` — the one
 * table in play that cannot be namespaced (its PK is the module id, box-wide).
 * A parallel suite's rows can never be disturbed this way.
 */
function availabilityConfig(overrides: Partial<AvailabilityConfig> = {}): AvailabilityConfig {
  return {
    AI_GATEWAY_URL: "http://ai-gateway.test",
    FILE_INDEXER_URL: "http://file-indexer.test",
    NEXTCLOUD_URL: "http://nextcloud.test",
    DOCS_ENABLED: "1",
    DOCS_INTERNAL_URL: "http://docs.test",
    SERVICE_TOKEN_EMAIL: "email-token",
    SERVICE_TOKEN_VOICE: "voice-token",
    FRIGATE_URL: "http://frigate.test",
    DROPLET_MATTER_SERVICE_URL: "http://matter.test",
    ROUTING_SERVICE_URL: "http://routing.test",
    SWITCH_SERVICE_URL: "http://switch.test",
    ...overrides,
  };
}

describe.skipIf(!RUN)("RBAC v2 guard rails — real Postgres (WARP-1534)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    _setEffectiveAccessForTests(null, null);
    await prisma.$disconnect();
  });

  const OURS = { startsWith: "warp1534-" } as const;

  beforeEach(async () => {
    vi.clearAllMocks();
    revokeAllSessionsMock.mockResolvedValue(1);
    // FK-ordered, prefix-scoped cleanup — never an unscoped deleteMany and
    // never a TRUNCATE ... CASCADE (access-role.pg.test.ts's rule).
    await prisma.userAccessException.deleteMany({ where: { user: { username: OURS } } });
    await prisma.userUsagePolicy.deleteMany({ where: { user: { username: OURS } } });
    await prisma.scopeBinding.deleteMany({ where: { user: { username: OURS } } });
    await prisma.user.updateMany({ where: { username: OURS }, data: { accessRoleId: null } });
    await prisma.userInvite.deleteMany({ where: { username: OURS } });
    await prisma.accessRole.deleteMany({ where: { slug: OURS } }); // grants cascade
    await prisma.user.deleteMany({ where: { username: OURS } });
    // Default binding for the resolver singleton; individual tests rebind.
    _setEffectiveAccessForTests(prisma, availabilityConfig());
  });

  // ── fixtures ─────────────────────────────────────────────────────

  type Tier = "owner" | "admin" | "family" | "guest";

  async function mkUser(
    suffix: string,
    role: Tier,
    extra: { directoryStatus?: "ACTIVE" | "DEACTIVATED" } = {},
  ) {
    const username = `warp1534-${suffix}`;
    return prisma.user.create({
      data: {
        username,
        displayName: username,
        nextcloudUsername: username,
        role,
        directoryStatus: extra.directoryStatus ?? "ACTIVE",
      },
    });
  }

  /** Mount all three routers over the REAL client, with a synthetic actor. */
  function buildApp(actor: { id: string; username: string; role: Tier }) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).user = { ...actor, displayName: actor.username };
      next();
    });
    app.use("/api", createPeopleRouter(prisma, async () => new Set()));
    app.use("/api", createAccessRouter(prisma));
    app.use("/api", createProtectedAuthRouter(prisma));
    return app;
  }

  const asActor = (u: { id: string; username: string; role: string }) => ({
    id: u.id,
    username: u.username,
    role: u.role as Tier,
  });

  /**
   * Guard the one premise this suite cannot namespace (see the module header):
   * rail 5's count is box-wide, so any ACTIVE owner/admin row outside the
   * `warp1534-` prefix would make a refusal case pass for the wrong reason.
   */
  async function expectNoForeignOperators(): Promise<void> {
    const foreign = await prisma.user.findMany({
      where: {
        role: { in: ["owner", "admin"] },
        directoryStatus: "ACTIVE",
        NOT: { username: OURS },
      },
      select: { username: true, role: true },
    });
    expect(
      foreign,
      "a foreign ACTIVE operator row would satisfy rail 5 and turn the refusal cases below into false passes — namespace that suite's fixtures",
    ).toEqual([]);
  }

  // ── rails 4 + 5 — the in-transaction invariants, on real COUNTs ──

  describe("rail 5 (LAST_OPERATOR_INVARIANT) — real counts inside the real transaction", () => {
    /**
     * The two-operator control runs FIRST in each case and is what makes the
     * refusal meaningful: same code path, same fixtures, one extra ACTIVE
     * admin row is the ONLY difference. Without it a refusal could equally be
     * rail 1, rail 3, or a broken route.
     */
    it("demotion: refused for the last operator, ALLOWED with a second one", async () => {
      await expectNoForeignOperators();
      const owner = await mkUser("r5-owner", "owner");
      const soleAdmin = await mkUser("r5-sole-admin", "admin");

      // Control: owner + admin are both ACTIVE operators, so demoting the
      // admin leaves one behind and must succeed.
      const ok = await request(buildApp(asActor(owner)))
        .patch(`/api/people/${soleAdmin.id}/role`)
        .send({ role: "family" });
      expect(ok.status).toBe(200);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: soleAdmin.id } })).role,
      ).toBe("family");

      // Now remove the other operator's ACTIVE-ness by deactivating the owner
      // row (rail 1 forbids demoting it, so this is the only honest way to
      // reach a one-operator directory). Promote the family row back to admin
      // and it becomes the final operator.
      await prisma.user.update({
        where: { id: owner.id },
        data: { directoryStatus: "DEACTIVATED" },
      });
      await prisma.user.update({ where: { id: soleAdmin.id }, data: { role: "admin" } });

      const refused = await request(buildApp(asActor(owner)))
        .patch(`/api/people/${soleAdmin.id}/role`)
        .send({ role: "family" });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: "LAST_OPERATOR_INVARIANT",
        error:
          "This is the last person who can manage access — give someone else an admin role first.",
      });
      // The transaction rolled back: the row is untouched in the DB, not just
      // in the response body.
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: soleAdmin.id } })).role,
      ).toBe("admin");
    });

    it("removal: refused for the last operator (DELETE /api/people/:id)", async () => {
      await expectNoForeignOperators();
      const owner = await mkUser("r5-del-owner", "owner");
      const admin = await mkUser("r5-del-admin", "admin");
      const second = await mkUser("r5-del-admin2", "admin");

      const ok = await request(buildApp(asActor(owner))).delete(`/api/people/${second.id}`);
      expect(ok.status).toBe(200);

      await prisma.user.update({
        where: { id: owner.id },
        data: { directoryStatus: "DEACTIVATED" },
      });

      const refused = await request(buildApp(asActor(owner))).delete(`/api/people/${admin.id}`);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "LAST_OPERATOR_INVARIANT" });
      // Still there — the delete was inside the rolled-back transaction.
      expect(await prisma.user.findUnique({ where: { id: admin.id } })).not.toBeNull();
    });

    it("disable: refused for the last operator, on the AUTH surface", async () => {
      // The same invariant reached through /api/auth/users/:username/disable —
      // the surface that had NO operator check at all before WARP-1526.
      await expectNoForeignOperators();
      const owner = await mkUser("r5-dis-owner", "owner");
      const admin = await mkUser("r5-dis-admin", "admin");
      const second = await mkUser("r5-dis-admin2", "admin");

      const ok = await request(buildApp(asActor(owner))).post(
        `/api/auth/users/${second.username}/disable`,
      );
      expect(ok.status).toBe(200);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: second.id } })).directoryStatus,
      ).toBe("DEACTIVATED");

      await prisma.user.update({
        where: { id: owner.id },
        data: { directoryStatus: "DEACTIVATED" },
      });

      const refused = await request(buildApp(asActor(owner))).post(
        `/api/auth/users/${admin.username}/disable`,
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "LAST_OPERATOR_INVARIANT" });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).directoryStatus,
      ).toBe("ACTIVE");
    });

    it("an ALREADY-DEACTIVATED sole admin stays demotable (never a stuck row)", async () => {
      // pr-reviewer #1229 N2: a disabled person holds no live access, so they
      // are never "the last operator". Refusing here would strand the ROW with
      // no route-level exit — the regression this case exists to catch.
      const owner = await mkUser("r5-stuck-owner", "owner");
      await prisma.user.update({
        where: { id: owner.id },
        data: { directoryStatus: "DEACTIVATED" },
      });
      const disabledAdmin = await mkUser("r5-stuck-admin", "admin", {
        directoryStatus: "DEACTIVATED",
      });

      const res = await request(buildApp(asActor(owner)))
        .patch(`/api/people/${disabledAdmin.id}/role`)
        .send({ role: "guest" });

      expect(res.status).toBe(200);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: disabledAdmin.id } })).role,
      ).toBe("guest");
    });
  });

  // ── the §9 floor clamp, as PERSISTED ─────────────────────────────

  describe("§9 floor clamping — asserted against the grant rows, not the response", () => {
    async function createRole(
      actor: { id: string; username: string; role: Tier },
      body: Record<string, unknown>,
    ) {
      return request(buildApp(actor))
        .post("/api/access/roles")
        .send({
          description: null,
          storageQuotaBytes: null,
          maxUploadSizeMb: null,
          llmDailyMessageCap: null,
          cloudModelsAllowed: false,
          mayOperateLocks: false,
          featureGrants: [],
          toolGrants: [],
          connectorGrants: [],
          ...body,
        });
    }

    it("a grant can never exceed its starting point's ceiling", async () => {
      const owner = await mkUser("clamp-owner", "owner");

      const res = await createRole(asActor(owner), {
        name: "warp1534-Reception",
        startingPoint: "family",
        featureGrants: [
          // network act/manage floor at ADMIN — a family-based role clamps to view.
          { moduleId: "network", level: "manage" },
          // files manage floors at FAMILY — held as requested.
          { moduleId: "files", level: "manage" },
          // managed_switch offers no `act` level at all; a family role clamps
          // down the ladder to the nearest offered-and-held level.
          { moduleId: "managed_switch", level: "act" },
        ],
      });
      expect(res.status).toBe(200);

      const stored = await prisma.accessRoleFeatureGrant.findMany({
        where: { roleId: res.body.role.id },
        orderBy: { moduleId: "asc" },
      });
      const byModule = Object.fromEntries(stored.map((g) => [g.moduleId, g.level]));
      expect(byModule).toEqual({
        network: "view",
        files: "manage",
        managed_switch: "view",
      });
    });

    it("a guest-based role clamps even the family-floored levels", async () => {
      const owner = await mkUser("clamp-guest-owner", "owner");
      const res = await createRole(asActor(owner), {
        name: "warp1534-Visitor",
        startingPoint: "guest",
        featureGrants: [
          { moduleId: "files", level: "manage" },
          // voice `act` is deliberately UN-floored — guests may talk to the
          // assistant. Pinned so a future blanket floor is a visible change.
          { moduleId: "voice", level: "act" },
        ],
      });
      expect(res.status).toBe(200);

      const stored = await prisma.accessRoleFeatureGrant.findMany({
        where: { roleId: res.body.role.id },
      });
      expect(Object.fromEntries(stored.map((g) => [g.moduleId, g.level]))).toEqual({
        files: "view",
        voice: "act",
      });
    });

    it("O-2: connector read_write clamps to read on a non-admin starting point", async () => {
      const owner = await mkUser("clamp-conn-owner", "owner");
      const res = await createRole(asActor(owner), {
        name: "warp1534-FrontDesk",
        startingPoint: "family",
        connectorGrants: [{ provider: "eaglesoft", level: "read_write" }],
      });
      expect(res.status).toBe(200);

      const stored = await prisma.accessRoleConnectorGrant.findMany({
        where: { roleId: res.body.role.id },
      });
      expect(stored).toEqual([
        expect.objectContaining({ provider: "eaglesoft", level: "read" }),
      ]);
    });

    it("moving a starting point DOWN re-floors the STORED rows, not just new ones", async () => {
      // The nastier half of the clamp: an Admin-based role legitimately holds
      // `network: manage` and a `read_write` connector grant. Re-basing it to
      // family must rewrite BOTH stored axes — otherwise the role keeps
      // admin-tier reach while its people sit on the family enum floor.
      const owner = await mkUser("refloor-owner", "owner");
      const created = await createRole(asActor(owner), {
        name: "warp1534-OpsLead",
        startingPoint: "admin",
        featureGrants: [{ moduleId: "network", level: "manage" }],
        connectorGrants: [{ provider: "eaglesoft", level: "read_write" }],
      });
      expect(created.status).toBe(200);
      expect(
        await prisma.accessRoleFeatureGrant.findMany({ where: { roleId: created.body.role.id } }),
      ).toEqual([expect.objectContaining({ moduleId: "network", level: "manage" })]);

      const patched = await request(buildApp(asActor(owner)))
        .patch(`/api/access/roles/${created.body.role.id}`)
        .send({ startingPoint: "family" });
      expect(patched.status).toBe(200);

      expect(
        await prisma.accessRoleFeatureGrant.findMany({ where: { roleId: created.body.role.id } }),
      ).toEqual([expect.objectContaining({ moduleId: "network", level: "view" })]);
      expect(
        await prisma.accessRoleConnectorGrant.findMany({
          where: { roleId: created.body.role.id },
        }),
      ).toEqual([expect.objectContaining({ provider: "eaglesoft", level: "read" })]);
    });

    it("mayOperateLocks is forced false without a smart_home grant", async () => {
      const owner = await mkUser("locks-owner", "owner");
      const res = await createRole(asActor(owner), {
        name: "warp1534-NoLocks",
        startingPoint: "family",
        mayOperateLocks: true,
        featureGrants: [{ moduleId: "files", level: "view" }],
      });
      expect(res.status).toBe(200);
      expect(
        (await prisma.accessRole.findUniqueOrThrow({ where: { id: res.body.role.id } }))
          .mayOperateLocks,
      ).toBe(false);
    });
  });

  // ── the resolver composition over real rows ──────────────────────

  describe("§3 resolver — exceptions compose against real rows", () => {
    it("an `allow` exception cannot resurrect a module the WORKSPACE does not have", async () => {
      const owner = await mkUser("exc-owner", "owner");
      const person = await mkUser("exc-person", "family");
      const created = await request(buildApp(asActor(owner)))
        .post("/api/access/roles")
        .send({
          name: "warp1534-Narrow",
          description: null,
          startingPoint: "family",
          storageQuotaBytes: null,
          maxUploadSizeMb: null,
          llmDailyMessageCap: null,
          cloudModelsAllowed: false,
          mayOperateLocks: false,
          featureGrants: [{ moduleId: "files", level: "view" }],
          toolGrants: [],
          connectorGrants: [],
        });
      expect(created.status).toBe(200);

      await request(buildApp(asActor(owner)))
        .patch(`/api/people/${person.id}/access`)
        .send({ accessRoleId: created.body.role.id })
        .expect(200);

      const exceptions = await request(buildApp(asActor(owner)))
        .put(`/api/people/${person.id}/access-exceptions`)
        .send({ exceptions: [{ moduleId: "network", effect: "allow", level: "view" }] });
      expect(exceptions.status).toBe(200);

      // Premise check, stated loudly: `network` is defaultEnabled, so with a
      // ROUTING_SERVICE_URL it IS in the workspace-effective set. If a future
      // suite writes a ModuleSetting row disabling it, this assertion fails
      // with a message that names the coupling instead of failing mysteriously
      // two lines below.
      _setEffectiveAccessForTests(prisma, availabilityConfig());
      const withNetwork = await resolveEffectiveAccess(person.id);
      expect(
        withNetwork?.features.map((f) => f.moduleId),
        "premise: `network` must be workspace-effective for this case to mean anything",
      ).toContain("network");

      // Now take the module away from the WORKSPACE (availability axis, no
      // shared-row write). The exception is unchanged and still says `allow`.
      _setEffectiveAccessForTests(prisma, availabilityConfig({ ROUTING_SERVICE_URL: "" }));
      const withoutNetwork = await resolveEffectiveAccess(person.id);
      expect(withoutNetwork?.features.map((f) => f.moduleId)).not.toContain("network");
      // ...and the exception row is still on file — the resolver refuses it at
      // COMPOSE time rather than the write path having silently dropped it.
      expect(withoutNetwork?.exceptions.map((x) => x.moduleId)).toContain("network");
    });

    it("an `allow` exception clamps to the tier ceiling, it does not exceed it", async () => {
      const owner = await mkUser("exc-clamp-owner", "owner");
      const guest = await mkUser("exc-clamp-guest", "guest");
      const created = await request(buildApp(asActor(owner)))
        .post("/api/access/roles")
        .send({
          name: "warp1534-GuestRole",
          description: null,
          startingPoint: "guest",
          storageQuotaBytes: null,
          maxUploadSizeMb: null,
          llmDailyMessageCap: null,
          cloudModelsAllowed: false,
          mayOperateLocks: false,
          featureGrants: [],
          toolGrants: [],
          connectorGrants: [],
        });
      expect(created.status).toBe(200);
      await request(buildApp(asActor(owner)))
        .patch(`/api/people/${guest.id}/access`)
        .send({ accessRoleId: created.body.role.id })
        .expect(200);

      await request(buildApp(asActor(owner)))
        .put(`/api/people/${guest.id}/access-exceptions`)
        .send({ exceptions: [{ moduleId: "files", effect: "allow", level: "manage" }] })
        .expect(200);

      const access = await resolveEffectiveAccess(guest.id);
      // `manage` floors at FAMILY; the person is on the guest tier, so the
      // exception buys them `view` and nothing more. An un-clamped exception
      // would be a privilege-escalation primitive available to any admin.
      expect(access?.features).toContainEqual({ moduleId: "files", level: "view" });
    });

    it("a `deny` exception removes a module the role granted", async () => {
      const owner = await mkUser("exc-deny-owner", "owner");
      const person = await mkUser("exc-deny-person", "family");
      const created = await request(buildApp(asActor(owner)))
        .post("/api/access/roles")
        .send({
          name: "warp1534-DenyRole",
          description: null,
          startingPoint: "family",
          storageQuotaBytes: null,
          maxUploadSizeMb: null,
          llmDailyMessageCap: null,
          cloudModelsAllowed: false,
          mayOperateLocks: false,
          featureGrants: [{ moduleId: "files", level: "act" }],
          toolGrants: [],
          connectorGrants: [],
        });
      expect(created.status).toBe(200);
      await request(buildApp(asActor(owner)))
        .patch(`/api/people/${person.id}/access`)
        .send({ accessRoleId: created.body.role.id })
        .expect(200);

      const before = await resolveEffectiveAccess(person.id);
      expect(before?.features).toContainEqual({ moduleId: "files", level: "act" });

      await request(buildApp(asActor(owner)))
        .put(`/api/people/${person.id}/access-exceptions`)
        .send({ exceptions: [{ moduleId: "files", effect: "deny" }] })
        .expect(200);

      const after = await resolveEffectiveAccess(person.id);
      expect(after?.features.map((f) => f.moduleId)).not.toContain("files");
      // The always-on floor is exception-IMMUNE — `chat` survives regardless.
      expect(after?.features).toContainEqual({ moduleId: "chat", level: "act" });
    });
  });

  // ── the built-in-tier path is not a side door ────────────────────

  describe("the built-in-tier path ({accessRoleId: null, tier}) on real rows", () => {
    it("runs rail 5 exactly like a custom-role assignment", async () => {
      await expectNoForeignOperators();
      const owner = await mkUser("bt-owner", "owner");
      const admin = await mkUser("bt-admin", "admin");
      await prisma.user.update({
        where: { id: owner.id },
        data: { directoryStatus: "DEACTIVATED" },
      });

      const res = await request(buildApp(asActor(owner)))
        .patch(`/api/people/${admin.id}/access`)
        .send({ accessRoleId: null, tier: "guest" });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "LAST_OPERATOR_INVARIANT" });
      const still = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(still.role).toBe("admin");
      expect(still.accessRoleId).toBeNull();
    });

    it("clears the role pointer and re-tiers in ONE committed write", async () => {
      const owner = await mkUser("bt2-owner", "owner");
      const person = await mkUser("bt2-person", "family");
      const created = await request(buildApp(asActor(owner)))
        .post("/api/access/roles")
        .send({
          name: "warp1534-Swappable",
          description: null,
          startingPoint: "admin",
          storageQuotaBytes: null,
          maxUploadSizeMb: null,
          llmDailyMessageCap: null,
          cloudModelsAllowed: false,
          mayOperateLocks: false,
          featureGrants: [],
          toolGrants: [],
          connectorGrants: [],
        });
      expect(created.status).toBe(200);

      await request(buildApp(asActor(owner)))
        .patch(`/api/people/${person.id}/access`)
        .send({ accessRoleId: created.body.role.id })
        .expect(200);
      const assigned = await prisma.user.findUniqueOrThrow({ where: { id: person.id } });
      // §2: assignment sets BOTH the pointer and the enum tier — the enum
      // floor stays authoritative at layer 1.
      expect(assigned.accessRoleId).toBe(created.body.role.id);
      expect(assigned.role).toBe("admin");

      await request(buildApp(asActor(owner)))
        .patch(`/api/people/${person.id}/access`)
        .send({ accessRoleId: null, tier: "guest" })
        .expect(200);
      const cleared = await prisma.user.findUniqueOrThrow({ where: { id: person.id } });
      expect(cleared.accessRoleId).toBeNull();
      expect(cleared.role).toBe("guest");
      // Rail 6 — the person's reach changed, so their sessions are gone.
      expect(revokeAllSessionsMock).toHaveBeenCalledWith(person.id);
    });

    it("assignment via POST /api/access/roles/:id/assign refuses an OWNER target", async () => {
      const owner = await mkUser("assign-owner", "owner");
      const admin = await mkUser("assign-admin", "admin");
      // A third row as the innocent co-target. The ACTOR must never appear in
      // its own `userIds`: rail 2 runs before rail 1 in the composite, so an
      // actor-in-batch would answer SELF_ACTION_NOT_ALLOWED and this case
      // would pass while proving nothing about rail 1.
      const bystander = await mkUser("assign-bystander", "family");
      const created = await request(buildApp(asActor(owner)))
        .post("/api/access/roles")
        .send({
          name: "warp1534-Bulk",
          description: null,
          startingPoint: "family",
          storageQuotaBytes: null,
          maxUploadSizeMb: null,
          llmDailyMessageCap: null,
          cloudModelsAllowed: false,
          mayOperateLocks: false,
          featureGrants: [],
          toolGrants: [],
          connectorGrants: [],
        });
      expect(created.status).toBe(200);

      // All-or-nothing: the owner in the batch must roll the WHOLE assignment
      // back, leaving the admin untouched too.
      const res = await request(buildApp(asActor(admin)))
        .post(`/api/access/roles/${created.body.role.id}/assign`)
        .send({ userIds: [bystander.id, owner.id] });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
      // All-or-nothing: the bystander who WOULD have passed every rail is
      // untouched, because the refusal rolled the whole transaction back.
      const untouched = await prisma.user.findUniqueOrThrow({ where: { id: bystander.id } });
      expect(untouched.accessRoleId).toBeNull();
      expect(untouched.role).toBe("family");
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).role,
      ).toBe("owner");
    });
  });

  // ── rail 1 on real rows, on the paths that WRITE ─────────────────

  describe("rail 1 (OWNER_IMMUTABLE) — nothing reaches the owner's row in Postgres", () => {
    it("a usage-policy write against the owner creates no row", async () => {
      const owner = await mkUser("usage-owner", "owner");
      const admin = await mkUser("usage-admin", "admin");

      const res = await request(buildApp(asActor(admin)))
        .put(`/api/people/${owner.id}/usage`)
        .send({ storageQuotaBytes: "1024" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
      expect(
        await prisma.userUsagePolicy.findUnique({ where: { userId: owner.id } }),
      ).toBeNull();
    });

    it("an exception write against the owner persists nothing", async () => {
      const owner = await mkUser("exc-owner-immutable", "owner");
      const admin = await mkUser("exc-admin", "admin");

      const res = await request(buildApp(asActor(admin)))
        .put(`/api/people/${owner.id}/access-exceptions`)
        .send({ exceptions: [{ moduleId: "files", effect: "deny" }] });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "OWNER_IMMUTABLE" });
      expect(await prisma.userAccessException.count({ where: { userId: owner.id } })).toBe(0);
    });

    it("the owner still resolves to the FULL catalog (bypass is inside the resolver)", async () => {
      const owner = await mkUser("resolve-owner", "owner");
      const access = await resolveEffectiveAccess(owner.id);
      expect(access?.tier).toBe("owner");
      expect(access?.features).toContainEqual({ moduleId: "network", level: "manage" });
      expect(access?.locks).toBe(true);
    });
  });
});
