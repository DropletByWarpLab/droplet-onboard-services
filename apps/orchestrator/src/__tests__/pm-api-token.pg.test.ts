/**
 * WARP-3533 — the invariants of the personal API token and scoped feed link
 * tables that only a real database can prove.
 *
 * Five guarantees live in migration SQL and nowhere in TypeScript:
 *
 *   * `PmApiToken_scopes_valid`     — a token has at least one scope and only
 *     the four in the vocabulary;
 *   * `PmApiToken_role_may_hold`    — an external guest or a service principal
 *     never holds a token;
 *   * `PmApiToken_revoked_coherent` — `revoked` and its time and reason travel
 *     together;
 *   * `CalendarFeedToken_project_scope_coherent` — a project feed names its
 *     project and no other feed does;
 *   * the cascades: a user takes their tokens and links with them, a project
 *     takes only its own feed links.
 *
 * A mocked Prisma accepts every row these reject, so a green unit suite says
 * nothing about them. Gated the same way the other *.pg.test.ts files are.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PmApiToken + scoped CalendarFeedToken — the database's own guarantees (WARP-3533)", () => {
  let prisma: PrismaClient;

  // Every fixture is namespaced `warp3533-`: the pg-gated suites share one
  // throwaway database and run in the same lane.
  const OURS = { startsWith: "warp3533-" } as const;

  let userId = "";
  let projectId = "";
  let n = 0;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  async function wipe() {
    await prisma.user.deleteMany({ where: { username: OURS } });
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
  }

  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await wipe();
    const user = await prisma.user.create({
      data: {
        username: `warp3533-${Date.now()}-${++n}`,
        displayName: "warp3533 person",
        role: "family",
        directoryStatus: "ACTIVE",
      },
    });
    userId = user.id;
    const ws = await prisma.pmWorkspace.create({ data: { slug: `warp3533-ws-${Date.now()}`, name: "warp3533-ws" } });
    const project = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3533-project", identifier: "W33" },
    });
    projectId = project.id;
  });

  const token = (over: Record<string, unknown> = {}) =>
    prisma.pmApiToken.create({
      data: {
        userId,
        name: "ci",
        prefix: "abcd1234",
        hash: `warp3533-${Date.now()}-${++n}`,
        scopes: ["pm:read"],
        issuedRole: "family",
        ...over,
      } as never,
    });

  // ── PmApiToken_scopes_valid ──────────────────────────────────────────────

  it("accepts every scope in the vocabulary, alone and together", async () => {
    await expect(token({ scopes: ["pm:read"] })).resolves.toBeTruthy();
    await expect(token({ scopes: ["pm:read", "pm:write"] })).resolves.toBeTruthy();
    await expect(
      token({ scopes: ["pm:read", "pm:write", "support:read", "support:write"] }),
    ).resolves.toBeTruthy();
  });

  it("rejects a token with no scope (PmApiToken_scopes_valid)", async () => {
    await expect(token({ scopes: [] })).rejects.toThrow(/PmApiToken_scopes_valid/);
  });

  it("rejects a scope outside the vocabulary (PmApiToken_scopes_valid)", async () => {
    await expect(token({ scopes: ["pm:read", "admin:all"] })).rejects.toThrow(/PmApiToken_scopes_valid/);
    await expect(token({ scopes: ["PM:READ"] })).rejects.toThrow(/PmApiToken_scopes_valid/);
  });

  // ── PmApiToken_role_may_hold ─────────────────────────────────────────────

  it("holds a token for owner, admin and family only (PmApiToken_role_may_hold)", async () => {
    for (const issuedRole of ["owner", "admin", "family"]) {
      await expect(token({ issuedRole })).resolves.toBeTruthy();
    }
    for (const issuedRole of ["guest", "service"]) {
      await expect(token({ issuedRole })).rejects.toThrow(/PmApiToken_role_may_hold/);
    }
  });

  // ── PmApiToken_revoked_coherent ──────────────────────────────────────────

  it("keeps revoked, its time and its reason together (PmApiToken_revoked_coherent)", async () => {
    const t = await token();
    const revokedAt = new Date();

    // revoked with no reason / no time
    await expect(prisma.pmApiToken.update({ where: { id: t.id }, data: { status: "revoked", revokedAt } })).rejects.toThrow(
      /PmApiToken_revoked_coherent/,
    );
    await expect(
      prisma.pmApiToken.update({ where: { id: t.id }, data: { status: "revoked", revokedReason: "manual" } }),
    ).rejects.toThrow(/PmApiToken_revoked_coherent/);

    // a time or a reason on a row that is not revoked
    await expect(prisma.pmApiToken.update({ where: { id: t.id }, data: { revokedAt } })).rejects.toThrow(
      /PmApiToken_revoked_coherent/,
    );
    await expect(
      prisma.pmApiToken.update({ where: { id: t.id }, data: { status: "expired", revokedReason: "manual" } }),
    ).rejects.toThrow(/PmApiToken_revoked_coherent/);
    await expect(
      prisma.pmApiToken.update({ where: { id: t.id }, data: { revokedById: "someone" } }),
    ).rejects.toThrow(/PmApiToken_revoked_coherent/);

    // the coherent shapes
    await expect(
      prisma.pmApiToken.update({
        where: { id: t.id },
        data: { status: "revoked", revokedAt, revokedReason: "role_changed" },
      }),
    ).resolves.toMatchObject({ status: "revoked", revokedReason: "role_changed" });
    const e = await token();
    await expect(prisma.pmApiToken.update({ where: { id: e.id }, data: { status: "expired" } })).resolves.toMatchObject({
      status: "expired",
    });
  });

  it("stores the hash once: a second token cannot reuse it", async () => {
    await token({ hash: "warp3533-dup" });
    await expect(token({ hash: "warp3533-dup" })).rejects.toThrow(/Unique constraint/);
  });

  it("allows no expiry, and defaults to active", async () => {
    const t = await token({ expiresAt: null });
    expect(t.expiresAt).toBeNull();
    expect(t.status).toBe("active");
  });

  it("goes with its user (ON DELETE CASCADE)", async () => {
    await token();
    await token();
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.pmApiToken.count({ where: { userId } })).toBe(0);
  });

  // ── CalendarFeedToken_project_scope_coherent ─────────────────────────────

  const link = (over: Record<string, unknown> = {}) =>
    prisma.calendarFeedToken.create({
      data: {
        userId,
        secretHash: `warp3533-${Date.now()}-${++n}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        ...over,
      } as never,
    });

  it("a link made the old way is a calendar link with no project (the column default)", async () => {
    const row = await link();
    expect(row.scope).toBe("calendar");
    expect(row.projectId).toBeNull();
  });

  it("a project feed names its project; no other feed does (CalendarFeedToken_project_scope_coherent)", async () => {
    await expect(link({ scope: "pm_project", projectId })).resolves.toBeTruthy();
    await expect(link({ scope: "pm_my_work" })).resolves.toBeTruthy();

    await expect(link({ scope: "pm_project" })).rejects.toThrow(/CalendarFeedToken_project_scope_coherent/);
    await expect(link({ scope: "calendar", projectId })).rejects.toThrow(/CalendarFeedToken_project_scope_coherent/);
    await expect(link({ scope: "pm_my_work", projectId })).rejects.toThrow(/CalendarFeedToken_project_scope_coherent/);
  });

  it("a deleted project takes its own feed links and no one else's", async () => {
    const calendar = await link();
    const mine = await link({ scope: "pm_my_work" });
    const project = await link({ scope: "pm_project", projectId });

    await prisma.pmProject.delete({ where: { id: projectId } });

    expect(await prisma.calendarFeedToken.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await prisma.calendarFeedToken.findUnique({ where: { id: calendar.id } })).not.toBeNull();
    expect(await prisma.calendarFeedToken.findUnique({ where: { id: mine.id } })).not.toBeNull();
  });

  it("goes with its user (ON DELETE CASCADE)", async () => {
    await link();
    await link({ scope: "pm_project", projectId });
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.calendarFeedToken.count({ where: { userId } })).toBe(0);
  });
});
