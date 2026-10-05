/**
 * WARP-1505 — a full disk is the server's problem, and must read as one.
 *
 * ENOSPC out of the storage engine is mapped to 507 `attachment_storage_full`
 * (a message the dashboard turns into "free up some space"), not to a generic
 * 500 and not to a "your file is wrong" 4xx. The engine is replaced by one that
 * fails the way a full volume does; everything else is the real route.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import { makeAttachmentFake } from "../../__tests__/helpers/pm-attachment-fake.js";

vi.mock("../../services/pm/pm-attachment-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/pm/pm-attachment-storage.js")>();
  return {
    ...actual,
    createAttachmentStorage: () => ({
      _handleFile(_req: unknown, file: { stream: NodeJS.ReadableStream }, cb: (err: Error) => void) {
        // busboy's part must be drained or the parse stalls.
        file.stream.resume();
        cb(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
      },
      _removeFile(_req: unknown, _file: unknown, cb: (err: Error | null) => void) {
        cb(null);
      },
    }),
  };
});

import { createPmAttachmentsRouter } from "./attachments.js";

describe("POST /api/pm/work-items/:id/attachments on a full volume", () => {
  it("answers 507 attachment_storage_full and leaves no row behind", async () => {
    const fake = makeAttachmentFake();
    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: "u", username: "u", displayName: "u", role: "family" } as AuthUser;
      next();
    });
    app.use("/api", createPmAttachmentsRouter(fake.prisma, { root: "/unused", maxBytes: 1000 }));

    const res = await request(app)
      .post("/api/pm/work-items/wi-1/attachments")
      .attach("file", Buffer.from("hello"), "a.txt");

    expect(res.status).toBe(507);
    expect(res.body).toEqual({ error: "attachment_storage_full" });
    expect(fake.db.attachments).toEqual([]);
  });
});
