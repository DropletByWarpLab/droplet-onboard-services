/**
 * WARP-3535 — the invariants of PmDevRepository / PmDevRepositoryProject /
 * PmExternalLink that only a real database can prove.
 *
 * Seven CHECK constraints, the unique index and the cascade chain live in
 * migration SQL, not in TypeScript (Prisma has no syntax for CHECKs). A mocked
 * Prisma happily accepts every row they reject, so a green unit suite says
 * nothing about them. Gated like the other `*.pg.test.ts` files.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PmExternalLink and friends — the database's own guarantees (WARP-3535)", () => {
  let prisma: PrismaClient;
  // The pg-gated suites share one throwaway database: scope every fixture.
  const OURS = { startsWith: "warp3535-" } as const;
  let workspaceId = "";
  let projectId = "";
  let workItemId = "";
  let stateId = "";

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.pmDevRepository.deleteMany({ where: { externalId: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.pmDevRepository.deleteMany({ where: { externalId: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `warp3535-ws-${Date.now()}`, name: "warp3535-ws" },
    });
    const project = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3535-project", identifier: "W35" },
    });
    const state = await prisma.pmState.create({
      data: { projectId: project.id, name: "In review", group: "started" },
    });
    const item = await prisma.pmWorkItem.create({
      data: { projectId: project.id, sequenceId: 1, name: "warp3535-item" },
    });
    workspaceId = ws.id;
    projectId = project.id;
    stateId = state.id;
    workItemId = item.id;
  });

  let n = 0;
  const repo = (over: Record<string, unknown> = {}) =>
    prisma.pmDevRepository.create({
      data: {
        provider: "GITHUB",
        externalId: `warp3535-${(n += 1)}-${Date.now()}`,
        apiRef: "acme/widgets",
        fullName: "acme/widgets",
        webUrl: "https://github.com/acme/widgets",
        ...over,
      } as never,
    });

  const link = (repositoryId: string, over: Record<string, unknown> = {}) =>
    prisma.pmExternalLink.create({
      data: {
        workItemId,
        repositoryId,
        provider: "GITHUB",
        kind: "PULL_REQUEST",
        externalId: `pr-${(n += 1)}`,
        url: "https://github.com/acme/widgets/pull/42",
        title: "W35-1 fix the thing",
        state: "OPEN",
        externalUpdatedAt: new Date(),
        ...over,
      } as never,
    });

  // ── PmDevRepository ──────────────────────────────────────────────────────

  describe("PmDevRepository_apiRef_safe — an apiRef can never walk out of its path", () => {
    it.each([
      ["a parent segment", "acme/../admin"],
      ["a leading parent segment", "../acme"],
      ["a trailing parent segment", "acme/.."],
      ["a bare dot segment", "acme/./widgets"],
      ["a space", "acme/wid gets"],
      ["a query string", "acme/widgets?x=1"],
      ["a percent escape", "acme%2Fwidgets"],
      ["a backslash", "acme\\widgets"],
      ["an empty value", ""],
      ["a value over 200 characters", `a/${"b".repeat(200)}`],
    ])("rejects %s", async (_label, apiRef) => {
      await expect(repo({ apiRef })).rejects.toThrow(/PmDevRepository_apiRef_safe/);
    });

    it.each([
      ["owner/repo", "acme/widgets"],
      ["a numeric GitLab project id", "1234567"],
      ["dots, dashes and underscores", "my-org/my.repo_v2"],
      ["a dot-prefixed repository name (.github is real)", "acme/.github"],
    ])("accepts %s", async (_label, apiRef) => {
      await expect(repo({ apiRef })).resolves.toBeTruthy();
    });
  });

  describe("webUrl and url are http(s) only — a link is never a javascript: URL", () => {
    it.each(["javascript:alert(1)", "data:text/html,x", "ftp://example.com/x", "//example.com/x", "github.com/acme"])(
      "rejects the repository web URL %s",
      async (webUrl) => {
        await expect(repo({ webUrl })).rejects.toThrow(/PmDevRepository_webUrl_is_http/);
      },
    );

    it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:x", "/relative/path"])(
      "rejects the link URL %s",
      async (url) => {
        const r = await repo();
        await expect(link(r.id, { url })).rejects.toThrow(/PmExternalLink_url_is_http/);
      },
    );

    it("accepts https and http, in any case", async () => {
      const r = await repo({ webUrl: "HTTPS://gitlab.com/acme" });
      await expect(link(r.id, { url: "http://gitlab.lan/acme/x/-/merge_requests/3" })).resolves.toBeTruthy();
    });
  });

  describe("PmDevRepository_ok_has_sync_time — OK is a claim with a timestamp behind it", () => {
    it("rejects OK without a completed pass", async () => {
      await expect(repo({ status: "OK", lastSyncedAt: null })).rejects.toThrow(/PmDevRepository_ok_has_sync_time/);
    });

    it("accepts OK with one, and every other status without", async () => {
      await expect(repo({ status: "OK", lastSyncedAt: new Date() })).resolves.toBeTruthy();
      for (const status of [
        "PENDING", "RATE_LIMITED", "EGRESS_BLOCKED", "NEEDS_RECONNECT", "INACCESSIBLE", "ERROR", "DISCONNECTED",
      ]) {
        await expect(repo({ status }), status).resolves.toBeTruthy();
      }
    });

    it("holds on UPDATE too", async () => {
      const r = await repo();
      await expect(prisma.pmDevRepository.update({ where: { id: r.id }, data: { status: "OK" } })).rejects.toThrow(
        /PmDevRepository_ok_has_sync_time/,
      );
    });
  });

  it("refuses a negative failure count", async () => {
    await expect(repo({ consecutiveFailures: -1 })).rejects.toThrow(/PmDevRepository_consecutiveFailures_nonnegative/);
  });

  it("is unique per (provider, externalId), and the same id on the other provider is a different repository", async () => {
    const externalId = `warp3535-dup-${Date.now()}`;
    await repo({ externalId });
    await expect(repo({ externalId })).rejects.toThrow(/Unique constraint/);
    await expect(repo({ externalId, provider: "GITLAB", apiRef: "99" })).resolves.toBeTruthy();
  });

  // ── PmExternalLink ───────────────────────────────────────────────────────

  describe("PmExternalLink_state_matches_kind — a pill can only say something true", () => {
    it.each([
      ["COMMIT", "OPEN"],
      ["COMMIT", "CLOSED"],
      ["COMMIT", "DRAFT"],
      ["BRANCH", "MERGED"],
      ["BRANCH", "DRAFT"],
    ])("rejects a %s that is %s", async (kind, state) => {
      const r = await repo();
      await expect(link(r.id, { kind, state })).rejects.toThrow(/PmExternalLink_state_matches_kind/);
    });

    it.each([
      ["COMMIT", "MERGED"],
      ["BRANCH", "OPEN"],
      ["BRANCH", "CLOSED"],
      ["PULL_REQUEST", "OPEN"],
      ["PULL_REQUEST", "DRAFT"],
      ["PULL_REQUEST", "MERGED"],
      ["PULL_REQUEST", "CLOSED"],
    ])("accepts a %s that is %s", async (kind, state) => {
      const r = await repo();
      await expect(link(r.id, { kind, state })).resolves.toBeTruthy();
    });

    it("holds on UPDATE too", async () => {
      const r = await repo();
      const l = await link(r.id, { kind: "COMMIT", state: "MERGED" });
      await expect(prisma.pmExternalLink.update({ where: { id: l.id }, data: { state: "DRAFT" } })).rejects.toThrow(
        /PmExternalLink_state_matches_kind/,
      );
    });
  });

  it("refuses a pull request number of zero or below", async () => {
    const r = await repo();
    await expect(link(r.id, { number: 0 })).rejects.toThrow(/PmExternalLink_number_positive/);
    await expect(link(r.id, { number: -3 })).rejects.toThrow(/PmExternalLink_number_positive/);
    await expect(link(r.id, { number: 42 })).resolves.toBeTruthy();
    await expect(link(r.id, { number: null })).resolves.toBeTruthy();
  });

  describe("the unique index — a replayed sweep creates nothing twice", () => {
    it("refuses the same (provider, kind, externalId) on the same work item", async () => {
      const r = await repo();
      await link(r.id, { externalId: "pr-same" });
      await expect(link(r.id, { externalId: "pr-same" })).rejects.toThrow(/Unique constraint/);
    });

    it("allows it on another work item, in another kind and from the other provider", async () => {
      const r = await repo();
      const other = await prisma.pmWorkItem.create({
        data: { projectId, sequenceId: 2, name: "warp3535-other" },
      });
      await link(r.id, { externalId: "pr-shared" });
      await expect(link(r.id, { externalId: "pr-shared", workItemId: other.id })).resolves.toBeTruthy();
      await expect(link(r.id, { externalId: "pr-shared", kind: "BRANCH" })).resolves.toBeTruthy();
      await expect(link(r.id, { externalId: "pr-shared", provider: "GITLAB" })).resolves.toBeTruthy();
    });
  });

  // ── cascades ─────────────────────────────────────────────────────────────

  describe("what goes with what", () => {
    it("deleting the work item deletes its links, and only those", async () => {
      const r = await repo();
      const other = await prisma.pmWorkItem.create({ data: { projectId, sequenceId: 2, name: "warp3535-keep" } });
      await link(r.id);
      await link(r.id, { workItemId: other.id });
      await prisma.pmWorkItem.delete({ where: { id: workItemId } });
      expect(await prisma.pmExternalLink.count({ where: { repositoryId: r.id } })).toBe(1);
      expect(await prisma.pmExternalLink.count({ where: { workItemId: other.id } })).toBe(1);
    });

    it("deleting the repository deletes its links and its mappings, not the work item or the project", async () => {
      const r = await repo();
      await link(r.id);
      await prisma.pmDevRepositoryProject.create({ data: { repositoryId: r.id, projectId } });
      await prisma.pmDevRepository.delete({ where: { id: r.id } });
      expect(await prisma.pmExternalLink.count({ where: { workItemId } })).toBe(0);
      expect(await prisma.pmDevRepositoryProject.count({ where: { projectId } })).toBe(0);
      expect(await prisma.pmWorkItem.count({ where: { id: workItemId } })).toBe(1);
      expect(await prisma.pmProject.count({ where: { id: projectId } })).toBe(1);
    });

    it("deleting the project deletes its mappings but leaves the repository registered", async () => {
      const r = await repo();
      await prisma.pmDevRepositoryProject.create({ data: { repositoryId: r.id, projectId } });
      await prisma.pmProject.delete({ where: { id: projectId } });
      expect(await prisma.pmDevRepositoryProject.count({ where: { repositoryId: r.id } })).toBe(0);
      expect(await prisma.pmDevRepository.count({ where: { id: r.id } })).toBe(1);
    });

    it("deleting a state switches the rule off and keeps the mapping", async () => {
      const r = await repo();
      await prisma.pmDevRepositoryProject.create({
        data: { repositoryId: r.id, projectId, onOpenedStateId: stateId, onMergedStateId: stateId },
      });
      await prisma.pmState.delete({ where: { id: stateId } });
      const row = await prisma.pmDevRepositoryProject.findUniqueOrThrow({
        where: { repositoryId_projectId: { repositoryId: r.id, projectId } },
      });
      expect(row.onOpenedStateId).toBeNull();
      expect(row.onMergedStateId).toBeNull();
    });

    it("maps a repository to a project once", async () => {
      const r = await repo();
      await prisma.pmDevRepositoryProject.create({ data: { repositoryId: r.id, projectId } });
      await expect(
        prisma.pmDevRepositoryProject.create({ data: { repositoryId: r.id, projectId } }),
      ).rejects.toThrow(/Unique constraint/);
    });
  });

  it("accepts the external_link_added activity verb (the enum migration landed first)", async () => {
    await expect(
      prisma.pmActivity.create({
        data: { workItemId, verb: "external_link_added", field: "github", newValue: "pull_request:#42" },
      }),
    ).resolves.toBeTruthy();
    expect(workspaceId).not.toBe("");
  });
});
