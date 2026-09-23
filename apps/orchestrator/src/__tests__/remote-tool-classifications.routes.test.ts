/**
 * WARP-2426 — the operator's surface over the classification record.
 *
 *   - GET lists (owner/admin); family is 403.
 *   - PATCH is OWNER-ONLY; `reviewedBy` is the signed-in owner, never a body
 *     field; the policy cache is refreshed in the same request so the next
 *     dispatch sees the decision; a signed activity row is written.
 *   - PATCH refuses: an unseen tool (404), a write without confirmation
 *     (400), a malformed body (400), a malformed id (400).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { createRemoteToolClassificationsRouter } from "../routes/remote-tool-classifications.js";
import {
  RemoteToolClassificationCache,
  recordDiscoveredRemoteTools,
  type ClassificationPrisma,
  type RemoteToolClassificationRow,
} from "../services/remote-tool-classification.service.js";
import type { AuthUser } from "../middleware/auth.js";

const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "stefan", displayName: "stefan", role: "admin" };
const family: AuthUser = { id: "u-family", username: "kid", displayName: "kid", role: "family" };

function fakePrisma() {
  const rows = new Map<string, RemoteToolClassificationRow>();
  const k = (s: string, t: string) => `${s}|${t}`;
  const model = {
    findUnique: async ({ where }: { where: { serverId_toolName: { serverId: string; toolName: string } } }) =>
      rows.get(k(where.serverId_toolName.serverId, where.serverId_toolName.toolName)) ?? null,
    upsert: async ({ where, create, update }: { where: { serverId_toolName: { serverId: string; toolName: string } }; create: Omit<RemoteToolClassificationRow, "reviewedBy" | "reviewedAt">; update: Partial<RemoteToolClassificationRow> }) => {
      const key = k(where.serverId_toolName.serverId, where.serverId_toolName.toolName);
      const next: RemoteToolClassificationRow = rows.has(key) ? { ...rows.get(key)!, ...update } : { reviewedBy: null, reviewedAt: null, ...create };
      rows.set(key, next);
      return next;
    },
    update: async ({ where, data }: { where: { serverId_toolName: { serverId: string; toolName: string } }; data: Partial<RemoteToolClassificationRow> }) => {
      const key = k(where.serverId_toolName.serverId, where.serverId_toolName.toolName);
      const next = { ...rows.get(key)!, ...data };
      rows.set(key, next);
      return next;
    },
    updateMany: async ({ where, data }: { where: { serverId: string; toolName: string; inputSchemaHash?: string | null }; data: Partial<RemoteToolClassificationRow> }) => {
      const key = k(where.serverId, where.toolName);
      const row = rows.get(key);
      if (!row || ("inputSchemaHash" in where && (row.inputSchemaHash ?? null) !== where.inputSchemaHash)) return { count: 0 };
      rows.set(key, { ...row, ...data });
      return { count: 1 };
    },
    findMany: async ({ where }: { where?: { serverId?: string } } = {}) =>
      [...rows.values()].filter((r) => !where?.serverId || r.serverId === where.serverId),
  };
  return { prisma: { remoteToolClassification: model } as unknown as ClassificationPrisma, rows };
}

function buildApp(prisma: ClassificationPrisma, user: AuthUser, cache: RemoteToolClassificationCache) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createRemoteToolClassificationsRouter(prisma as never, { cache }));
  return app;
}

const BASE = "/api/admin/remote-tools/classifications";

beforeEach(() => recordActivityMock.mockClear());

describe("GET /api/admin/remote-tools/classifications", () => {
  it("lists for owner and admin, filtered by server; family is 403", async () => {
    const { prisma } = fakePrisma();
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "getConfluencePage" }, { wireName: "createJiraIssue" }]);
    await recordDiscoveredRemoteTools(prisma, "vendor2", [{ wireName: "list" }]);
    const cache = new RemoteToolClassificationCache();

    const asAdmin = await request(buildApp(prisma, admin, cache)).get(`${BASE}?serverId=atlassian`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.classifications.map((r: { toolName: string }) => r.toolName).sort()).toEqual(["createJiraIssue", "getConfluencePage"]);
    expect(asAdmin.body.classifications[0]).toMatchObject({ requiresWrite: true, requiresConfirmation: true, denied: false });

    const all = await request(buildApp(prisma, owner, cache)).get(BASE);
    expect(all.body.classifications).toHaveLength(3);

    expect((await request(buildApp(prisma, family, cache)).get(BASE)).status).toBe(403);
    expect((await request(buildApp(prisma, owner, cache)).get(`${BASE}?serverId=Not%20Valid`)).status).toBe(400);
  });
});

describe("PATCH /api/admin/remote-tools/classifications/:serverId/:toolName", () => {
  it("is owner-only: admin is 403", async () => {
    const { prisma } = fakePrisma();
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "getConfluencePage" }]);
    const res = await request(buildApp(prisma, admin, new RemoteToolClassificationCache()))
      .patch(`${BASE}/atlassian/getConfluencePage`)
      .send({ requiresWrite: false, requiresConfirmation: false, denied: false });
    expect(res.status).toBe(403);
  });

  it("demotes to a read as the signed-in owner, refreshes the policy cache, and writes an activity row", async () => {
    const { prisma } = fakePrisma();
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "getConfluencePage" }]);
    const cache = new RemoteToolClassificationCache();
    expect(cache.lookup("atlassian", "getConfluencePage")).toBeUndefined();

    const res = await request(buildApp(prisma, owner, cache))
      .patch(`${BASE}/atlassian/getConfluencePage`)
      // A body `reviewedBy` is not a field; the owner's identity is.
      .send({ requiresWrite: false, requiresConfirmation: false, denied: false, reviewedBy: "somebody-else" });
    expect(res.status).toBe(200);
    expect(res.body.classification).toMatchObject({ requiresWrite: false, requiresConfirmation: false, denied: false, reviewedBy: "romain" });
    expect(res.body.classification.reviewedAt).toBeTruthy();

    // MUTATION: drop the `cache.refresh` call from the route and this goes
    // red — the decision would wait for the next attach or reboot.
    expect(cache.lookup("atlassian", "getConfluencePage")).toMatchObject({ requiresWrite: false, reviewedBy: "romain" });

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({
      kind: "system",
      what: "Remote tool classified: read",
      sub: "atlassian · getConfluencePage",
      refs: { serverId: "atlassian", toolName: "getConfluencePage", requiresWrite: false, denied: false },
    });
  });

  it("blocks a tool", async () => {
    const { prisma } = fakePrisma();
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "createJiraIssue" }]);
    const cache = new RemoteToolClassificationCache();
    const res = await request(buildApp(prisma, owner, cache))
      .patch(`${BASE}/atlassian/createJiraIssue`)
      .send({ requiresWrite: true, requiresConfirmation: true, denied: true });
    expect(res.status).toBe(200);
    expect(cache.lookup("atlassian", "createJiraIssue")?.denied).toBe(true);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({ what: "Remote tool classified: blocked" });
  });

  it("a review of a schema that has since changed is a 409 and changes nothing", async () => {
    // MUTATION: map STALE_REVIEW to 200 / drop the hash from the body parse → red.
    const { prisma, rows } = fakePrisma();
    const h1 = "a".repeat(64);
    const h2 = "b".repeat(64);
    await recordDiscoveredRemoteTools(prisma, "ext-wc", [{ wireName: "word_count", inputSchemaHash: h1 }]);
    await recordDiscoveredRemoteTools(prisma, "ext-wc", [{ wireName: "word_count", inputSchemaHash: h2 }]);
    const cache = new RemoteToolClassificationCache();
    const app = buildApp(prisma, owner, cache);
    const asRead = { requiresWrite: false, requiresConfirmation: false, denied: false };
    const stale = await request(app).patch(`${BASE}/ext-wc/word_count`).send({ ...asRead, inputSchemaHash: h1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("STALE_REVIEW");
    expect(rows.get("ext-wc|word_count")).toMatchObject({ requiresWrite: true, reviewedBy: null });
    expect(cache.lookup("ext-wc", "word_count")).toBeUndefined();
    expect(recordActivityMock).not.toHaveBeenCalled();
    expect((await request(app).patch(`${BASE}/ext-wc/word_count`).send({ ...asRead, inputSchemaHash: "not-a-hash" })).status).toBe(400);
    const fresh = await request(app).patch(`${BASE}/ext-wc/word_count`).send({ ...asRead, inputSchemaHash: h2 });
    expect(fresh.status).toBe(200);
    expect(cache.lookup("ext-wc", "word_count")?.requiresWrite).toBe(false);
  });

  it("refuses an unseen tool (404), a write without confirmation (400), a malformed body and a malformed id (400)", async () => {
    const { prisma } = fakePrisma();
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "createJiraIssue" }]);
    const app = buildApp(prisma, owner, new RemoteToolClassificationCache());
    expect((await request(app).patch(`${BASE}/atlassian/ghost`).send({ requiresWrite: false, requiresConfirmation: false, denied: false })).status).toBe(404);
    const unconfirmed = await request(app).patch(`${BASE}/atlassian/createJiraIssue`).send({ requiresWrite: true, requiresConfirmation: false, denied: false });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toBe("UNCONFIRMED_WRITE");
    expect((await request(app).patch(`${BASE}/atlassian/createJiraIssue`).send({ requiresWrite: "yes" })).status).toBe(400);
    expect((await request(app).patch(`${BASE}/Bad_Id/createJiraIssue`).send({ requiresWrite: false, requiresConfirmation: false, denied: false })).status).toBe(400);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
