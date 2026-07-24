/**
 * WARP-1525 / ADR-032 — real-Postgres constraint tests for the RBAC v2 T1
 * schema (AccessRole + grant tables + accessRoleId columns).
 *
 * The schema-text suite (access-role.schema.test.ts) locks the declared
 * contract; only a real Postgres proves the migration actually enforces it:
 * column defaults materialize on INSERT, composite PKs and the
 * (userId, moduleId) unique reject duplicates, RESTRICT blocks deleting an
 * in-use role, and CASCADE removes grant/exception rows with their
 * role/user.
 *
 * Gated behind RUN_PG_INTEGRATION=1 + DATABASE_URL so the default
 * `npm run test:orchestrator` lane (no DB) skips. Run locally via
 * scripts/test-orchestrator-pg.sh; in CI via the `pg-integration` job in
 * .github/workflows/orchestrator-tests.yml (both lanes `prisma migrate
 * deploy` the full migration set first — which is itself the apply-clean
 * check for the warp_1525 migration).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup (src/__tests__/setup.ts) mocks @prisma/client so
// the DB-less lane never needs Postgres. This file must talk to a REAL
// Postgres, so undo the mock and pull the real client in at runtime.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)(
  "AccessRole schema — real-Postgres constraints (WARP-1525)",
  () => {
    let prisma: PrismaClient;

    beforeAll(async () => {
      const { PrismaClient: RealPrismaClient } = await vi.importActual<
        typeof import("@prisma/client")
      >("@prisma/client");
      prisma = new RealPrismaClient();
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      // FK-ordered cleanup, scoped to the tables this suite touches (other
      // pg-gated suites share the throwaway DB — never TRUNCATE ... CASCADE
      // here, it would reach across FKs into their tables).
      await prisma.userAccessException.deleteMany();
      await prisma.user.updateMany({ data: { accessRoleId: null } });
      await prisma.userInvite.deleteMany();
      await prisma.accessRole.deleteMany(); // grant rows cascade
      await prisma.user.deleteMany();
    });

    const mkUser = (username: string) =>
      prisma.user.create({
        data: { username, displayName: username },
      });

    const mkRole = (slug: string, extra: object = {}) =>
      prisma.accessRole.create({
        data: {
          name: `Role ${slug}`,
          slug,
          startingPoint: "family",
          createdBy: "00000000-0000-4000-8000-00000000adm1",
          ...extra,
        },
      });

    it("creates a role with grants + exceptions; defaults round-trip from the DB", async () => {
      const admin = await mkUser("warp1525-admin");
      const role = await prisma.accessRole.create({
        data: {
          name: "Reception",
          slug: "reception",
          startingPoint: "family",
          createdBy: admin.id,
          storageQuotaBytes: 10n * 1024n * 1024n * 1024n,
          featureGrants: {
            create: [
              { moduleId: "cameras", level: "view" },
              { moduleId: "files", level: "act" },
            ],
          },
          toolGrants: { create: [{ domain: "smart_home", level: "use" }] },
          connectorGrants: {
            create: [{ provider: "eaglesoft", level: "read" }],
          },
        },
        include: {
          featureGrants: true,
          toolGrants: true,
          connectorGrants: true,
        },
      });

      // DB-materialized defaults (the AC trio).
      expect(role.state).toBe("active");
      expect(role.cloudModelsAllowed).toBe(false);
      expect(role.mayOperateLocks).toBe(false);
      // Axis-c: set BigInt round-trips; unset defaults stay null.
      expect(role.storageQuotaBytes).toBe(10n * 1024n * 1024n * 1024n);
      expect(role.maxUploadSizeMb).toBeNull();
      expect(role.llmDailyMessageCap).toBeNull();
      expect(role.featureGrants).toHaveLength(2);
      expect(role.toolGrants).toEqual([
        expect.objectContaining({ domain: "smart_home", level: "use" }),
      ]);
      expect(role.connectorGrants).toEqual([
        expect.objectContaining({ provider: "eaglesoft", level: "read" }),
      ]);

      // Exceptions attach to the USER (feature-axis only in v1) and the
      // relation round-trips both ways.
      const person = await mkUser("warp1525-person");
      await prisma.userAccessException.create({
        data: {
          userId: person.id,
          moduleId: "email",
          effect: "allow",
          level: "view",
          grantedBy: admin.id,
        },
      });
      const withExceptions = await prisma.user.findUniqueOrThrow({
        where: { id: person.id },
        include: { accessExceptions: true },
      });
      expect(withExceptions.accessExceptions).toEqual([
        expect.objectContaining({
          moduleId: "email",
          effect: "allow",
          level: "view",
        }),
      ]);
    });

    it("composite PKs reject a duplicate grant per (role, moduleId/domain/provider)", async () => {
      const role = await mkRole("dupes");
      await prisma.accessRoleFeatureGrant.create({
        data: { roleId: role.id, moduleId: "cameras", level: "view" },
      });
      await expect(
        prisma.accessRoleFeatureGrant.create({
          data: { roleId: role.id, moduleId: "cameras", level: "manage" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      await prisma.accessRoleToolGrant.create({
        data: { roleId: role.id, domain: "files", level: "view" },
      });
      await expect(
        prisma.accessRoleToolGrant.create({
          data: { roleId: role.id, domain: "files", level: "use" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });

      await prisma.accessRoleConnectorGrant.create({
        data: { roleId: role.id, provider: "eaglesoft", level: "read" },
      });
      await expect(
        prisma.accessRoleConnectorGrant.create({
          data: { roleId: role.id, provider: "eaglesoft", level: "read_write" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("rejects a second exception for the same (userId, moduleId)", async () => {
      const person = await mkUser("warp1525-unique");
      await prisma.userAccessException.create({
        data: {
          userId: person.id,
          moduleId: "docs",
          effect: "deny",
          grantedBy: "admin",
        },
      });
      await expect(
        prisma.userAccessException.create({
          data: {
            userId: person.id,
            moduleId: "docs",
            effect: "allow",
            level: "act",
            grantedBy: "admin",
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("User.accessRoleId is nullable (today's world) and assignable", async () => {
      const person = await mkUser("warp1525-nullable");
      expect(person.accessRoleId).toBeNull();

      const role = await mkRole("assignable");
      const updated = await prisma.user.update({
        where: { id: person.id },
        data: { accessRoleId: role.id },
        include: { accessRole: true },
      });
      expect(updated.accessRole?.slug).toBe("assignable");

      const roster = await prisma.accessRole.findUniqueOrThrow({
        where: { id: role.id },
        include: { users: true },
      });
      expect(roster.users.map((u) => u.id)).toEqual([person.id]);
    });

    it("RESTRICT: deleting a role with assigned users fails (never silently strips assignment)", async () => {
      const person = await mkUser("warp1525-restrict");
      const role = await mkRole("in-use");
      await prisma.user.update({
        where: { id: person.id },
        data: { accessRoleId: role.id },
      });

      await expect(
        prisma.accessRole.delete({ where: { id: role.id } }),
      ).rejects.toMatchObject({ code: "P2003" });

      // The assignment survives the failed delete.
      const still = await prisma.user.findUniqueOrThrow({
        where: { id: person.id },
      });
      expect(still.accessRoleId).toBe(role.id);
    });

    it("RESTRICT: deleting a role referenced by a pending invite fails", async () => {
      const role = await mkRole("invited");
      const invite = await prisma.userInvite.create({
        data: {
          token: "warp1525-invite-token",
          username: "warp1525-invitee",
          createdBy: "admin",
          expiresAt: new Date(Date.now() + 86_400_000),
          accessRoleId: role.id,
        },
      });
      expect(invite.accessRoleId).toBe(role.id);

      await expect(
        prisma.accessRole.delete({ where: { id: role.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("CASCADE: deleting an unassigned role removes its grant rows", async () => {
      const role = await mkRole("cascades", {
        featureGrants: { create: [{ moduleId: "files", level: "manage" }] },
        toolGrants: { create: [{ domain: "network", level: "view" }] },
        connectorGrants: { create: [{ provider: "eaglesoft", level: "read" }] },
      });

      await prisma.accessRole.delete({ where: { id: role.id } });

      expect(await prisma.accessRoleFeatureGrant.count()).toBe(0);
      expect(await prisma.accessRoleToolGrant.count()).toBe(0);
      expect(await prisma.accessRoleConnectorGrant.count()).toBe(0);
    });

    it("CASCADE: deleting a user removes their exception rows", async () => {
      const person = await mkUser("warp1525-cascade-user");
      await prisma.userAccessException.create({
        data: {
          userId: person.id,
          moduleId: "voice",
          effect: "deny",
          grantedBy: "admin",
        },
      });

      await prisma.user.delete({ where: { id: person.id } });

      expect(await prisma.userAccessException.count()).toBe(0);
    });
  },
);
