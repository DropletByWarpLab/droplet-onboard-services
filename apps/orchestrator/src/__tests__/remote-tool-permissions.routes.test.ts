/**
 * WARP-3962 — the tool-permission routes.
 *
 *   GET   /api/admin/remote-tools/classifications              (rows carry grade, permission, inputSchemaHash)
 *   PATCH /api/admin/remote-tools/permissions/:serverId/:toolName   { permission, inputSchemaHash? }
 *   PATCH /api/admin/remote-tools/permissions/:serverId             { group, permission }
 *
 * Owner sets any legal value, admin only tightens, members and guests are 403.
 * The contract is the validator: a destructive tool is block-only (400), a
 * write is never 'always' (400).
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
} from "../services/remote-tool-classification.service.js";
import { remoteToolGradeOf } from "../services/remote-tool-tables.js";
import type { AuthUser } from "../middleware/auth.js";
import { fakeClassificationPrisma } from "./helpers/remote-tool-fake-prisma.js";

const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "stefan", displayName: "stefan", role: "admin" };
const family: AuthUser = { id: "u-family", username: "kid", displayName: "kid", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "ext", displayName: "ext", role: "guest" };

const READ = "getJiraIssue";
const WRITE = "createJiraIssue";
const DESTRUCTIVE = "updateConfluencePage";
const P = "/api/admin/remote-tools/permissions";

async function setup(user: AuthUser) {
  const f = fakeClassificationPrisma();
  await recordDiscoveredRemoteTools(
    f.prisma,
    "atlassian",
    [READ, "getVisibleJiraProjects", WRITE, DESTRUCTIVE].map((wireName) => ({ wireName, description: `${wireName} desc`, inputSchemaHash: "c".repeat(64) })),
    new Date(0),
    { gradeOf: remoteToolGradeOf },
  );
  const cache = new RemoteToolClassificationCache();
  await cache.refresh(f.prisma);
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use(
    "/api",
    createRemoteToolClassificationsRouter(f.prisma as ClassificationPrisma as never, { cache, toolReview: async (rows) => rows }),
  );
  return { app, cache, ...f };
}

beforeEach(() => recordActivityMock.mockClear());

describe("GET carries grade, permission and the review hash", () => {
  it("lowercase grade and permission per row", async () => {
    const { app } = await setup(owner);
    const res = await request(app).get("/api/admin/remote-tools/classifications?serverId=atlassian");
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.classifications.map((r: { toolName: string }) => [r.toolName, r]));
    expect(by[READ]).toMatchObject({ grade: "read", permission: "always", inputSchemaHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(by[WRITE]).toMatchObject({ grade: "write", permission: "ask" });
    expect(by[DESTRUCTIVE]).toMatchObject({ grade: "destructive", permission: "block" });
  });
});

describe("PATCH one tool", () => {
  it("owner: read always → ask is 200 { tool }, live in the cache, and audited", async () => {
    const { app, cache } = await setup(owner);
    const res = await request(app).patch(`${P}/atlassian/${READ}`).send({ permission: "ask" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tool: { name: READ, grade: "read", permission: "ask", changed: true } });
    expect(cache.lookup("atlassian", READ)).toMatchObject({ requiresConfirmation: true, requiresWrite: false, reviewedBy: "romain" });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({ what: "Remote tool permission: asks first", refs: { toolName: READ, permission: "ask", previous: "always" } });
    // the same value again: accepted, changed:false
    const again = await request(app).patch(`${P}/atlassian/${READ}`).send({ permission: "ask" });
    expect(again.body.tool.changed).toBe(false);
  });

  it("a destructive tool cannot be set to ask or always (400), only block", async () => {
    const { app } = await setup(owner);
    for (const permission of ["ask", "always"]) {
      const res = await request(app).patch(`${P}/atlassian/${DESTRUCTIVE}`).send({ permission });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("permission_not_allowed_for_grade");
      expect(res.body.message).toContain("destructive");
    }
    expect((await request(app).patch(`${P}/atlassian/${DESTRUCTIVE}`).send({ permission: "block" })).status).toBe(200);
  });

  it("a write cannot be 'always' (400); ask and block are fine", async () => {
    const { app } = await setup(owner);
    const bad = await request(app).patch(`${P}/atlassian/${WRITE}`).send({ permission: "always" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("permission_not_allowed_for_grade");
    expect((await request(app).patch(`${P}/atlassian/${WRITE}`).send({ permission: "block" })).body.tool.permission).toBe("block");
    expect((await request(app).patch(`${P}/atlassian/${WRITE}`).send({ permission: "ask" })).body.tool.permission).toBe("ask");
  });

  it("admin may tighten (200) but loosening is 403 admin_can_only_tighten", async () => {
    const { app } = await setup(admin);
    expect((await request(app).patch(`${P}/atlassian/${READ}`).send({ permission: "block" })).status).toBe(200);
    const res = await request(app).patch(`${P}/atlassian/${READ}`).send({ permission: "always" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_can_only_tighten");
  });

  it("409 stale_review when the hash is no longer the row's; 404 for a tool never advertised", async () => {
    const { app, rows } = await setup(owner);
    const stale = await request(app).patch(`${P}/atlassian/${WRITE}`).send({ permission: "block", inputSchemaHash: "d".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale_review");
    expect(rows.get(`atlassian|${WRITE}`)).toMatchObject({ denied: false });
    const stored = rows.get(`atlassian|${WRITE}`)!.inputSchemaHash!;
    expect((await request(app).patch(`${P}/atlassian/${WRITE}`).send({ permission: "block", inputSchemaHash: stored })).status).toBe(200);
    const ghost = await request(app).patch(`${P}/atlassian/ghost`).send({ permission: "ask" });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe("not_found");
  });

  it("rejects an unknown permission, an extra key, and a malformed id (400)", async () => {
    const { app } = await setup(owner);
    expect((await request(app).patch(`${P}/atlassian/${READ}`).send({ permission: "sometimes" })).status).toBe(400);
    expect((await request(app).patch(`${P}/atlassian/${READ}`).send({ permission: "ask", denied: false })).status).toBe(400);
    expect((await request(app).patch(`${P}/atlassian/bad%20name`).send({ permission: "ask" })).status).toBe(400);
  });

  it("members and guests are 403 and change nothing", async () => {
    for (const user of [family, guest]) {
      const { app, rows } = await setup(user);
      const res = await request(app).patch(`${P}/atlassian/${READ}`).send({ permission: "block" });
      expect(res.status).toBe(403);
      expect(rows.get(`atlassian|${READ}`)).toMatchObject({ denied: false });
      expect((await request(app).get("/api/admin/remote-tools/classifications")).status).toBe(403);
    }
  });
});

describe("PATCH a group", () => {
  it("owner sets every read tool to ask in one request", async () => {
    const { app, rows } = await setup(owner);
    const res = await request(app).patch(`${P}/atlassian`).send({ group: "read", permission: "ask" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ group: "read", permission: "ask", skipped: [] });
    expect([...res.body.changed].sort()).toEqual([READ, "getVisibleJiraProjects"].sort());
    expect(rows.get(`atlassian|${WRITE}`)).toMatchObject({ requiresConfirmation: true, denied: false });
  });

  it("admin loosening is 403 for the whole group, a write group cannot be 'always' (400)", async () => {
    const { app } = await setup(admin);
    await request(app).patch(`${P}/atlassian`).send({ group: "read", permission: "block" });
    const loosen = await request(app).patch(`${P}/atlassian`).send({ group: "read", permission: "ask" });
    expect(loosen.status).toBe(403);
    expect(loosen.body.error).toBe("admin_can_only_tighten");
    const bad = await request(app).patch(`${P}/atlassian`).send({ group: "write", permission: "always" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("permission_not_allowed_for_grade");
  });

  it("a destructive group does not exist (400)", async () => {
    const { app } = await setup(owner);
    expect((await request(app).patch(`${P}/atlassian`).send({ group: "destructive", permission: "block" })).status).toBe(400);
  });
});

describe("the legacy owner classification PATCH is held to the same contract", () => {
  const LEGACY = "/api/admin/remote-tools/classifications/atlassian";

  it("a write cannot be marked requiresWrite:false (that would be 'always'): 400", async () => {
    const { app, rows } = await setup(owner);
    const res = await request(app).patch(`${LEGACY}/${WRITE}`).send({ requiresWrite: false, requiresConfirmation: false, denied: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("permission_not_allowed_for_grade");
    expect(rows.get(`atlassian|${WRITE}`)).toMatchObject({ requiresWrite: true, requiresConfirmation: true, denied: false });
    // nor an ask that lies about being a read
    const lie = await request(app).patch(`${LEGACY}/${WRITE}`).send({ requiresWrite: false, requiresConfirmation: true, denied: false });
    expect(lie.status).toBe(400);
  });

  it("a destructive tool cannot be un-denied: 400, and stays blocked", async () => {
    const { app, rows } = await setup(owner);
    for (const body of [
      { requiresWrite: true, requiresConfirmation: true, denied: false },
      { requiresWrite: false, requiresConfirmation: false, denied: false },
    ]) {
      const res = await request(app).patch(`${LEGACY}/${DESTRUCTIVE}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("permission_not_allowed_for_grade");
    }
    expect(rows.get(`atlassian|${DESTRUCTIVE}`)).toMatchObject({ denied: true, allowlisted: false });
  });

  it("legal changes still work and store the canonical columns (write -> block, read -> ask)", async () => {
    const { app, rows } = await setup(owner);
    expect((await request(app).patch(`${LEGACY}/${WRITE}`).send({ requiresWrite: true, requiresConfirmation: true, denied: true })).status).toBe(200);
    expect(rows.get(`atlassian|${WRITE}`)).toMatchObject({ denied: true, allowlisted: false });
    expect((await request(app).patch(`${LEGACY}/${READ}`).send({ requiresWrite: false, requiresConfirmation: true, denied: false })).status).toBe(200);
    expect(rows.get(`atlassian|${READ}`)).toMatchObject({ requiresWrite: false, requiresConfirmation: true, allowlisted: true });
  });

  it("an admin cannot allowlist a blocked tool through the allowlist route either", async () => {
    const { app, rows } = await setup(admin);
    await request(app).patch(`${P}/atlassian/${READ}`).send({ permission: "block" });
    const res = await request(app).put(`/api/admin/remote-tools/allowlist/atlassian/${READ}`).send({ allowlisted: true });
    expect(res.status).toBe(403);
    expect(rows.get(`atlassian|${READ}`)).toMatchObject({ allowlisted: false });
  });
});
