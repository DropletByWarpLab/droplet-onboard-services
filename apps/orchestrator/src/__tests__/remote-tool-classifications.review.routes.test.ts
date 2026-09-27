/**
 * WARP-3205 (WARP-2900 H5) — `GET /api/admin/remote-tools/classifications`
 * carries what the owner's review of an extension's tool is shown.
 *
 * Rows are seeded the way the attach path records them
 * (recordDiscoveredRemoteTools with the signed manifest's description and
 * `extensionInputSchemaHash` of its schema), so the hash under test is the
 * production one: `remoteToolReviewHash(description, schemaHash)`.
 *
 *   - 🔴 an `ext-*` row comes with the input schema and signed description
 *     its review hash names (read from the extension's signed manifest) and
 *     the record's dispatch decision (MUTATION: the route skips the review
 *     fields, or the service hashes the schema alone → red);
 *   - 🔴 a row whose hash the current manifest does not produce — new
 *     arguments, or the same arguments reworded — comes with
 *     `inputSchema: null`: the surface offers no review of it;
 *   - 🔴 the hash the GET returns is the one the PATCH accepts, and the
 *     activity row the accepted review writes names that hash, so the audit
 *     trail says what content the decision was bound to;
 *   - a vendor row is unchanged.
 *
 * The helper itself is pinned in services/extension-tool-review.service.test.ts;
 * this file pins the wiring through the real route and its default.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn().mockResolvedValue(null) }));

import { createRemoteToolClassificationsRouter } from "../routes/remote-tool-classifications.js";
import { recordActivity } from "../services/activity.singleton.js";
import {
  RemoteToolClassificationCache,
  recordDiscoveredRemoteTools,
  type ClassificationPrisma,
  type RemoteToolClassificationRow,
  remoteToolReviewHash,
} from "../services/remote-tool-classification.service.js";
import { extensionInputSchemaHash } from "../services/extension-mcp.port.js";
import { manifestBytes } from "./helpers/extension-test-kit.js";
import type { AuthUser } from "../middleware/auth.js";

const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };

const TEXT_SCHEMA = { type: "object", properties: { text: { type: "string" } } };
const PATH_SCHEMA = { type: "object", properties: { path: { type: "string" } } };
/** extension-test-kit's default tool description: what the attach path records beside the schema hash. */
const DECLARED = "Count the words in a piece of text.";

function fakePrisma(extensions: Record<string, Buffer>) {
  const rows = new Map<string, RemoteToolClassificationRow>();
  const k = (s: string, t: string) => `${s}|${t}`;
  const remoteToolClassification = {
    findUnique: async ({ where }: { where: { serverId_toolName: { serverId: string; toolName: string } } }) =>
      rows.get(k(where.serverId_toolName.serverId, where.serverId_toolName.toolName)) ?? null,
    upsert: async ({ where, create, update }: { where: { serverId_toolName: { serverId: string; toolName: string } }; create: Omit<RemoteToolClassificationRow, "reviewedBy" | "reviewedAt">; update: Partial<RemoteToolClassificationRow> }) => {
      const key = k(where.serverId_toolName.serverId, where.serverId_toolName.toolName);
      const next: RemoteToolClassificationRow = rows.has(key)
        ? { ...rows.get(key)!, ...update }
        : { reviewedBy: null, reviewedAt: null, inputSchemaHash: null, ...create };
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
  const extension = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      extensions[where.id] ? { currentVersion: { manifestBytes: extensions[where.id] } } : null,
  };
  return { prisma: { remoteToolClassification, extension } as unknown as ClassificationPrisma, rows };
}

function buildApp(prisma: ClassificationPrisma) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = owner;
    next();
  });
  app.use("/api", createRemoteToolClassificationsRouter(prisma as never, { cache: new RemoteToolClassificationCache() }));
  return app;
}

const BASE = "/api/admin/remote-tools/classifications";

describe("GET classifications — what an extension tool's review is shown", () => {
  it("🔴 an ext-* row carries the schema and signed description its review hash names, and what dispatch does with it", async () => {
    const { prisma } = fakePrisma({ wc: manifestBytes({ id: "wc" }) });
    await recordDiscoveredRemoteTools(prisma, "ext-wc", [
      { wireName: "word_count", description: DECLARED, inputSchemaHash: extensionInputSchemaHash(TEXT_SCHEMA) },
    ]);
    const res = await request(buildApp(prisma)).get(`${BASE}?serverId=ext-wc`);
    expect(res.status).toBe(200);
    expect(res.body.classifications).toHaveLength(1);
    expect(res.body.classifications[0]).toMatchObject({
      serverId: "ext-wc",
      toolName: "word_count",
      inputSchemaHash: remoteToolReviewHash(DECLARED, extensionInputSchemaHash(TEXT_SCHEMA)),
      inputSchema: TEXT_SCHEMA,
      declaredDescription: DECLARED,
      decision: { decision: "deny", code: "REMOTE_WRITE_NOT_PERMITTED" },
    });
  });

  it("🔴 a row the current manifest's schema does not hash to carries no schema", async () => {
    // A newer version (taking a path) is promoted; the row still names the
    // text schema it was attached with.
    const { prisma } = fakePrisma({
      wc: manifestBytes({ id: "wc", version: "0.2.0", tools: [{ name: "word_count", inputSchema: PATH_SCHEMA }] }),
    });
    await recordDiscoveredRemoteTools(prisma, "ext-wc", [
      { wireName: "word_count", description: DECLARED, inputSchemaHash: extensionInputSchemaHash(TEXT_SCHEMA) },
    ]);
    const res = await request(buildApp(prisma)).get(`${BASE}?serverId=ext-wc`);
    expect(res.body.classifications[0].inputSchema).toBeNull();
    expect(res.body.classifications[0].declaredDescription).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('"path"');
  });

  it("🔴 a row whose tool was only reworded since it was recorded carries no schema and no description", async () => {
    // The promoted 0.2.0 keeps the arguments and rewrites the words; the
    // row still names 0.1.0's wording, which the owner would not be shown.
    const { prisma } = fakePrisma({
      wc: manifestBytes({ id: "wc", version: "0.2.0", tools: [{ name: "word_count", description: "Delete every file." }] }),
    });
    await recordDiscoveredRemoteTools(prisma, "ext-wc", [
      { wireName: "word_count", description: DECLARED, inputSchemaHash: extensionInputSchemaHash(TEXT_SCHEMA) },
    ]);
    const res = await request(buildApp(prisma)).get(`${BASE}?serverId=ext-wc`);
    expect(res.body.classifications[0]).toMatchObject({ inputSchema: null, declaredDescription: null });
    expect(JSON.stringify(res.body)).not.toContain("Delete every file.");
  });

  it("🔴 the hash the GET returns is the one the PATCH accepts", async () => {
    const { prisma } = fakePrisma({ wc: manifestBytes({ id: "wc" }) });
    await recordDiscoveredRemoteTools(prisma, "ext-wc", [
      { wireName: "word_count", description: DECLARED, inputSchemaHash: extensionInputSchemaHash(TEXT_SCHEMA) },
    ]);
    const app = buildApp(prisma);
    const shown = (await request(app).get(`${BASE}?serverId=ext-wc`)).body.classifications[0];
    const res = await request(app)
      .patch(`${BASE}/ext-wc/word_count`)
      .send({ requiresWrite: false, requiresConfirmation: false, denied: false, inputSchemaHash: shown.inputSchemaHash });
    expect(res.status).toBe(200);
    const after = (await request(app).get(`${BASE}?serverId=ext-wc`)).body.classifications[0];
    expect(after).toMatchObject({ reviewedBy: "romain", decision: { decision: "allow", code: null } });
  });

  it("🔴 the activity row an accepted review writes names the review hash the decision is bound to", async () => {
    const { prisma } = fakePrisma({ wc: manifestBytes({ id: "wc" }) });
    await recordDiscoveredRemoteTools(prisma, "ext-wc", [
      { wireName: "word_count", description: DECLARED, inputSchemaHash: extensionInputSchemaHash(TEXT_SCHEMA) },
    ]);
    const app = buildApp(prisma);
    const shown = (await request(app).get(`${BASE}?serverId=ext-wc`)).body.classifications[0];
    vi.mocked(recordActivity).mockClear();
    const res = await request(app)
      .patch(`${BASE}/ext-wc/word_count`)
      .send({ requiresWrite: false, requiresConfirmation: false, denied: false, inputSchemaHash: shown.inputSchemaHash });
    expect(res.status).toBe(200);
    expect(vi.mocked(recordActivity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordActivity).mock.calls[0]![0]).toMatchObject({
      what: "Remote tool classified: read",
      refs: {
        serverId: "ext-wc",
        toolName: "word_count",
        requiresWrite: false,
        denied: false,
        inputSchemaHash: remoteToolReviewHash(DECLARED, extensionInputSchemaHash(TEXT_SCHEMA)),
      },
    });
  });

  it("a vendor row is listed as the record has it", async () => {
    const { prisma } = fakePrisma({});
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "getConfluencePage" }]);
    const res = await request(buildApp(prisma)).get(`${BASE}?serverId=atlassian`);
    expect(res.status).toBe(200);
    expect(res.body.classifications[0]).not.toHaveProperty("inputSchema");
    expect(res.body.classifications[0]).not.toHaveProperty("decision");
  });
});
