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
import {
  PM_API_TOKENS_ENABLED_KEY,
  resolvePmApiTokenPrincipal,
  bindPmApiTokenPrisma,
  createPmApiToken,
  listPmApiTokens,
  recordPmApiTokenUse,
  resetPmApiTokenUseMemo,
  revokePmApiToken,
  revokePmApiTokensForUser,
  setPmApiTokensEnabled,
} from "../services/pm/pm-api-token.service.js";
import {
  getFeedTokenStatus,
  listActivePmFeedLinks,
  resolveFeedToken,
  revokeFeedTokens,
  rotateFeedToken,
} from "../services/calendar-feed-token.service.js";

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

  it("rejects a row with no scopes value at all: a NULL cannot slip past the CHECK (PmApiToken_scopes_valid)", async () => {
    // Prisma cannot write a NULL list, so this goes in as SQL. A CHECK passes when its expression is
    // NULL, and cardinality(NULL) is NULL: the constraint has to say IS NOT NULL itself.
    const insert = (scopesSql: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "PmApiToken" ("id", "userId", "name", "prefix", "hash", "scopes", "issuedRole")
         VALUES ($1, $2, 'ci', 'abcd1234', $3, ${scopesSql}, 'family'::"Role")`,
        `warp3533-null-${Date.now()}-${++n}`,
        userId,
        `warp3533-null-hash-${Date.now()}-${++n}`,
      );
    await expect(insert("NULL")).rejects.toThrow(/PmApiToken_scopes_valid/);
    await expect(insert("ARRAY[NULL]::text[]")).rejects.toThrow(/PmApiToken_scopes_valid/);
    await expect(insert("ARRAY['pm:read', NULL]::text[]")).rejects.toThrow(/PmApiToken_scopes_valid/);
    // the control: the same statement with a real scope list is accepted
    await expect(insert("ARRAY['pm:read']::text[]")).resolves.toBe(1);
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

// ── The services, against the real database ─────────────────────────────────
//
// The CHECK constraints above are only half of the risk: the other half is that
// every WRITE the services make satisfies them. A violation inside the auth path
// would be a 500 on a request that should be a 401, and a fake database cannot
// tell. So the lifecycle is driven here through the real services and the real
// constraints, with the rows read back.
describe.skipIf(!RUN)("the token and feed-link services over real Postgres (WARP-3533)", () => {
  let prisma: PrismaClient;
  const OURS = { startsWith: "warp3533s-" } as const;
  let user: { id: string; username: string };
  let projectId = "";
  let otherProjectId = "";
  let n = 0;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    bindPmApiTokenPrisma(prisma);
    await setPmApiTokensEnabled(prisma, true);
  });

  async function wipe() {
    await prisma.user.deleteMany({ where: { username: OURS } });
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
  }

  afterAll(async () => {
    await wipe();
    // Leave the switch as a fresh box has it: no row until someone writes one.
    await prisma.workspaceSetting.deleteMany({ where: { key: PM_API_TOKENS_ENABLED_KEY } });
    bindPmApiTokenPrisma(null);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await wipe();
    resetPmApiTokenUseMemo();
    const u = await prisma.user.create({
      data: { username: `warp3533s-${Date.now()}-${++n}`, displayName: "warp3533s person", role: "family", directoryStatus: "ACTIVE" },
    });
    user = { id: u.id, username: u.username };
    const ws = await prisma.pmWorkspace.create({ data: { slug: `warp3533s-ws-${Date.now()}`, name: "warp3533s-ws" } });
    projectId = (await prisma.pmProject.create({ data: { workspaceId: ws.id, name: "warp3533s-a", identifier: "S33A" } })).id;
    otherProjectId = (await prisma.pmProject.create({ data: { workspaceId: ws.id, name: "warp3533s-b", identifier: "S33B" } })).id;
  });

  const mint = (scopes = ["pm:read"], expiresAt: Date | null = null) =>
    createPmApiToken(prisma, { id: user.id, role: "family" }, { name: "ci", scopes, expiresAt });
  const rowOf = (id: string) => prisma.pmApiToken.findUniqueOrThrow({ where: { id } });

  it("a minted token authenticates as its holder, carrying its scopes and the holder's current role", async () => {
    const { token, row } = await mint(["pm:write", "pm:read"]);
    const auth = await resolvePmApiTokenPrincipal(prisma, token);
    expect(auth).toMatchObject({ ok: true, tokenId: row.id, scopes: ["pm:read", "pm:write"] });
    if (auth.ok) expect(auth.principal).toMatchObject({ id: user.id, username: user.username, role: "family" });
    expect((await rowOf(row.id)).hash).not.toContain(token.slice(4));
  });

  it("every lazy stamp the auth path writes satisfies the CHECKs: role change, deactivation, expiry", async () => {
    // role change
    const a = await mint();
    await prisma.user.update({ where: { id: user.id }, data: { role: "admin" } });
    expect(await resolvePmApiTokenPrincipal(prisma, a.token)).toEqual({ ok: false, code: "TOKEN_REVOKED" });
    expect(await rowOf(a.row.id)).toMatchObject({ status: "revoked", revokedReason: "role_changed" });
    expect((await rowOf(a.row.id)).revokedAt).toBeInstanceOf(Date);
    await prisma.user.update({ where: { id: user.id }, data: { role: "family" } });
    // back to the role it was issued under: still dead
    expect(await resolvePmApiTokenPrincipal(prisma, a.token)).toEqual({ ok: false, code: "TOKEN_REVOKED" });

    // deactivation
    const b = await mint();
    await prisma.user.update({ where: { id: user.id }, data: { directoryStatus: "DEACTIVATED" } });
    expect(await resolvePmApiTokenPrincipal(prisma, b.token)).toEqual({ ok: false, code: "TOKEN_REVOKED" });
    expect(await rowOf(b.row.id)).toMatchObject({ status: "revoked", revokedReason: "user_deactivated" });
    await prisma.user.update({ where: { id: user.id }, data: { directoryStatus: "ACTIVE" } });

    // expiry
    const c = await mint(["pm:read"], new Date(Date.now() + 60_000));
    await prisma.pmApiToken.update({ where: { id: c.row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolvePmApiTokenPrincipal(prisma, c.token)).toEqual({ ok: false, code: "TOKEN_EXPIRED" });
    expect(await rowOf(c.row.id)).toMatchObject({ status: "expired", revokedAt: null, revokedReason: null });
  });

  it("a refused use is audited once an hour: the claim is one conditional write", async () => {
    const { token, row } = await mint();
    await prisma.pmApiToken.update({ where: { id: row.id }, data: { status: "revoked", revokedAt: new Date(), revokedReason: "manual" } });
    await resolvePmApiTokenPrincipal(prisma, token);
    const first = (await rowOf(row.id)).refusalAuditedAt;
    expect(first).toBeInstanceOf(Date);
    await resolvePmApiTokenPrincipal(prisma, token);
    expect((await rowOf(row.id)).refusalAuditedAt).toEqual(first);
  });

  it("manual revoke and the lifecycle hook leave coherent rows, and are idempotent", async () => {
    const a = await mint();
    const b = await mint();
    expect(await revokePmApiToken(prisma, a.row.id, { userId: user.id, isAdmin: false })).toMatchObject({ userId: user.id });
    expect(await rowOf(a.row.id)).toMatchObject({ status: "revoked", revokedReason: "manual", revokedById: user.id });
    expect(await revokePmApiToken(prisma, a.row.id, { userId: user.id, isAdmin: false })).toBe("already");

    await revokePmApiTokensForUser(user.id, "role_changed", { type: "system", id: null });
    expect(await rowOf(b.row.id)).toMatchObject({ status: "revoked", revokedReason: "role_changed", revokedById: null });
    // the manual one keeps its own reason
    expect(await rowOf(a.row.id)).toMatchObject({ revokedReason: "manual" });
  });

  it("lastUsedAt is one write a minute, even across a restart (the statement itself is conditional)", async () => {
    const { row } = await mint();
    const t0 = new Date();
    await recordPmApiTokenUse(prisma, row.id, t0);
    const first = (await rowOf(row.id)).lastUsedAt;
    expect(first?.getTime()).toBe(t0.getTime());
    resetPmApiTokenUseMemo(); // a new process
    await recordPmApiTokenUse(prisma, row.id, new Date(t0.getTime() + 5_000));
    expect((await rowOf(row.id)).lastUsedAt?.getTime()).toBe(t0.getTime());
    resetPmApiTokenUseMemo();
    await recordPmApiTokenUse(prisma, row.id, new Date(t0.getTime() + 61_000));
    expect((await rowOf(row.id)).lastUsedAt?.getTime()).toBe(t0.getTime() + 61_000);
  });

  it("a listing stamps an overdue active token expired and returns newest first", async () => {
    const old = await mint(["pm:read"], new Date(Date.now() + 60_000));
    await prisma.pmApiToken.update({ where: { id: old.row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const fresh = await mint();
    const rows = await listPmApiTokens(prisma, user.id);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [fresh.row.id, "active"],
      [old.row.id, "expired"],
    ]);
  });

  it("feed links: each feed has its own link, resolved for its own feed only, and the writes satisfy the CHECK", async () => {
    const calendar = await rotateFeedToken(prisma, user.id);
    const mine = await rotateFeedToken(prisma, user.id, { scope: "pm_my_work" });
    const projA = await rotateFeedToken(prisma, user.id, { scope: "pm_project", projectId });
    const projB = await rotateFeedToken(prisma, user.id, { scope: "pm_project", projectId: otherProjectId });

    const ok = (token: string, target?: Parameters<typeof resolveFeedToken>[3]) => resolveFeedToken(prisma, token, user.username, target);
    expect(await ok(calendar.token)).toMatchObject({ userId: user.id, username: user.username, role: "family" });
    expect(await ok(mine.token, { scope: "pm_my_work" })).not.toBeNull();
    expect(await ok(projA.token, { scope: "pm_project", projectId })).not.toBeNull();
    // every wrong pairing is null
    expect(await ok(calendar.token, { scope: "pm_my_work" })).toBeNull();
    expect(await ok(mine.token)).toBeNull();
    expect(await ok(projA.token, { scope: "pm_project", projectId: otherProjectId })).toBeNull();
    expect(await ok(projB.token, { scope: "pm_project", projectId })).toBeNull();
    expect(await ok(projA.token)).toBeNull();

    // rotating one feed ends only that feed's link
    const mineAgain = await rotateFeedToken(prisma, user.id, { scope: "pm_my_work" });
    expect(mineAgain.rotated).toBe(1);
    expect(await ok(mine.token, { scope: "pm_my_work" })).toBeNull();
    expect(await ok(mineAgain.token, { scope: "pm_my_work" })).not.toBeNull();
    expect(await ok(calendar.token)).not.toBeNull();
    expect(await ok(projA.token, { scope: "pm_project", projectId })).not.toBeNull();

    // the list is the live PM links only, once per feed
    const byKey = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
    const live = await listActivePmFeedLinks(prisma, user.id);
    expect(live.map((l) => l.target).sort(byKey)).toEqual(
      [{ scope: "pm_my_work" }, { scope: "pm_project", projectId }, { scope: "pm_project", projectId: otherProjectId }].sort(byKey),
    );

    expect(await revokeFeedTokens(prisma, user.id, { scope: "pm_project", projectId })).toBe(1);
    expect((await getFeedTokenStatus(prisma, user.id, { scope: "pm_project", projectId })).state).toBe("none");
    expect((await getFeedTokenStatus(prisma, user.id, { scope: "pm_project", projectId: otherProjectId })).state).toBe("active");
    expect((await getFeedTokenStatus(prisma, user.id)).state).toBe("active");
  });
});
