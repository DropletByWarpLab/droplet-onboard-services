/** WARP-237 — signed-daily-roots read surface. Owner/admin only. */
import { describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { createAuditRootsRouter } from "./audit-roots.js";

const ROOT = {
  id: 1n,
  date: "2026-07-05",
  firstRowId: 1n,
  lastRowId: 42n,
  rowCount: 42,
  tailSignatureHash: "tail",
  prevRootHash: "",
  rootHash: "root",
  signature: Buffer.from([1, 2, 3, 4]).toString("base64"),
  algorithm: "ECDSA-P256-SHA256",
  createdAt: new Date("2026-07-06T03:35:00Z"),
};

function makeApp(role: string | undefined): Express {
  const prisma = {
    activityDailyRoot: {
      async findMany() {
        return [ROOT];
      },
      async findUnique(args: { where: { date: string } }) {
        return args.where.date === ROOT.date ? ROOT : null;
      },
    },
  };
  const app = express();
  app.use((req, _res, next) => {
    if (role) {
      (req as { user?: unknown }).user = { id: "u1", role };
    }
    next();
  });
  app.use("/api", createAuditRootsRouter(prisma as never));
  return app;
}

describe("audit roots routes", () => {
  let app: Express;
  beforeEach(() => {
    app = makeApp("admin");
  });

  it("lists roots newest-first with string ids", async () => {
    const res = await request(app).get("/api/audit/roots");
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      date: "2026-07-05",
      firstRowId: "1",
      lastRowId: "42",
      rowCount: 42,
      rootHash: "root",
      algorithm: "ECDSA-P256-SHA256",
    });
  });

  it("serves a single root and 404s unsigned days", async () => {
    const ok = await request(app).get("/api/audit/roots/2026-07-05");
    expect(ok.status).toBe(200);
    expect(ok.body.signature).toBe(ROOT.signature);
    const miss = await request(app).get("/api/audit/roots/2026-07-04");
    expect(miss.status).toBe(404);
  });

  it("serves the raw signature at /:date.sig", async () => {
    const res = await request(app)
      .get("/api/audit/roots/2026-07-05.sig")
      .responseType("blob");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    expect(Buffer.from(res.body)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("403s non-admin roles and rejects malformed dates", async () => {
    const guest = makeApp("guest");
    expect((await request(guest).get("/api/audit/roots")).status).toBe(403);
    expect((await request(app).get("/api/audit/roots/not-a-date")).status).toBe(
      400,
    );
  });
});
