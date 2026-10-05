/**
 * WARP-1505 (review) — the list, download and delete routes carry the standard
 * per-IP ceiling, like the other fs-touching handlers (routes/files.ts, the
 * CodeQL js/missing-rate-limiting sweep).
 *
 * Its own file on purpose: `standardRateLimit` is one process-wide counter, so
 * saturating it here must not be able to 429 an unrelated test in the same
 * module registry. (The upload ceiling is per router and is tested beside the
 * other upload cases in attachments.test.ts.)
 */
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthUser } from "../../middleware/auth.js";
import { createPmAttachmentsRouter } from "./attachments.js";
import { makeAttachmentFake } from "../../__tests__/helpers/pm-attachment-fake.js";

describe("list, download and delete share the standard per-IP ceiling", () => {
  it("answers 429 past 300 requests a minute, on every one of the three routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pm-attach-rl-"));
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: "u-alice", username: "alice", displayName: "alice", role: "family" } as AuthUser;
      next();
    });
    app.use("/api", createPmAttachmentsRouter(makeAttachmentFake().prisma, { root, maxBytes: 1000 }));
    const server = app.listen(0);
    try {
      const agent = request(server);
      for (let i = 0; i < 300; i += 1) {
        const res = await agent.get("/api/pm/work-items/wi-1/attachments");
        if (res.status !== 200) throw new Error(`request ${i + 1} was ${res.status}, expected 200`);
      }
      const list = await agent.get("/api/pm/work-items/wi-1/attachments");
      expect(list.status).toBe(429);
      expect(list.body).toEqual({ error: "Too many requests, slow down" });
      expect(list.headers.ratelimit).toBeTruthy();
      // the same bucket: a download and a delete are refused too
      expect((await agent.get("/api/pm/attachments/anything")).status).toBe(429);
      expect((await agent.delete("/api/pm/attachments/anything")).status).toBe(429);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
