/**
 * WARP-3193 QUAL-14 — /api/contacts route contract (the HTTP layer only; the
 * service has its own tests). Pins the owner scope, the write-role wall, body
 * validation, and the service-error → status mapping the dashboard branches on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
}));

const svc = vi.hoisted(() => ({
  listContacts: vi.fn(),
  getContact: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  setContactArchived: vi.fn(),
  deleteContact: vi.fn(),
}));
vi.mock("../services/contacts/contacts.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/contacts/contacts.service.js")>()),
  ...svc,
}));

import { createContactsRouter } from "./contacts.js";
import type { AuthUser } from "../middleware/auth.js";
import type { Role } from "../services/jwt.service.js";

function mkUser(role: Role, id = `user-${role}`): AuthUser {
  return { id, username: id, displayName: id, role };
}

function buildApp(as: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = as;
    next();
  });
  app.use("/api", createContactsRouter({} as PrismaClient));
  return app;
}

beforeEach(() => {
  Object.values(svc).forEach((f) => f.mockReset());
});

describe("/api/contacts", () => {
  it("scopes reads to the caller's own id", async () => {
    svc.getContact.mockResolvedValue({ id: "c1" });
    const res = await request(buildApp(mkUser("family", "u-1"))).get("/api/contacts/c1");
    expect(res.status).toBe(200);
    expect(svc.getContact).toHaveBeenCalledWith(expect.anything(), "u-1", "c1");
  });

  it("refuses a service principal — it has no address book", async () => {
    const res = await request(buildApp(mkUser("service", "_service:mcp"))).get("/api/contacts");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("contacts_require_a_user");
    expect(svc.listContacts).not.toHaveBeenCalled();
  });

  it("a guest cannot write", async () => {
    const res = await request(buildApp(mkUser("guest")))
      .post("/api/contacts")
      .send({ displayName: "Ada" });
    expect(res.status).toBe(403);
    expect(svc.createContact).not.toHaveBeenCalled();
  });

  it("rejects an invalid body with 400 before the service runs", async () => {
    const res = await request(buildApp(mkUser("owner")))
      .post("/api/contacts")
      .send({ emails: [{ address: "not-an-email" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(svc.createContact).not.toHaveBeenCalled();
  });

  it("maps a missing contact to 404", async () => {
    svc.getContact.mockRejectedValue(new Error("contact_not_found"));
    const res = await request(buildApp(mkUser("owner"))).get("/api/contacts/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("contact_not_found");
  });

  it("maps deleting a synced contact to 409 with the archive remediation", async () => {
    svc.deleteContact.mockRejectedValue(new Error("contact_is_external_archive_instead"));
    const res = await request(buildApp(mkUser("owner"))).delete("/api/contacts/c1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "contact_is_external_archive_instead",
      remediation: "archive",
    });
  });
});
