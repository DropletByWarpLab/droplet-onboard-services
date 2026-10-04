import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

vi.mock("../services/nextcloud-session.service.js", () => ({ resolveNcToken: vi.fn(async () => null) }));
vi.mock("../services/nextcloud.client.js", () => ({ ncGetUserQuota: vi.fn() }));

import { createStorageRouter } from "../routes/storage.js";
import { setRecordingsAllocator } from "../services/recordings-allocator.singleton.js";
import { evaluateStorageCommand } from "../services/storage-safety.service.js";

const overview = { status: "active", mode: "full", warnings: [], cameras: [] };

function allocator() {
  return {
    getOverview: vi.fn(async () => overview),
    setAllocation: vi.fn(async () => ({ accepted: true as const })),
    deleteOldFootage: vi.fn(async () => ({ accepted: true as const })),
  };
}

function appFor(prisma: unknown, role = "owner", userId = "user-1") {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: userId, role } as never;
    next();
  });
  app.use("/api", createStorageRouter(prisma as never));
  return app;
}

function prismaStub() {
  return { commandAuditLog: { create: vi.fn(async () => ({})) } };
}

describe("recordings storage routes (WARP-3514 / ADR-070)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRecordingsAllocator(null);
  });

  afterEach(() => {
    setRecordingsAllocator(null);
  });

  it("serves the contract payload only to owner and admin", async () => {
    const service = allocator();
    setRecordingsAllocator(service as never);
    const prisma = prismaStub();
    const owner = await request(appFor(prisma)).get("/api/storage/recordings");
    const admin = await request(appFor(prisma, "admin")).get("/api/storage/recordings");
    const member = await request(appFor(prisma, "member")).get("/api/storage/recordings");

    expect(owner.status).toBe(200);
    expect(owner.body).toEqual(overview);
    expect(admin.status).toBe(200);
    expect(member.status).toBe(403);
    expect(service.getOverview).toHaveBeenCalledTimes(2);
    expect(prisma.commandAuditLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.commandAuditLog.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        entityId: "storage.recordings",
        domain: "storage",
        service: "recordings_get",
        data: undefined,
        tier: 1,
        confirmed: true,
        blocked: false,
        reason: null,
      },
    });
  });

  it("does not fail the read when the successful-read audit cannot be written", async () => {
    setRecordingsAllocator(allocator() as never);
    const prisma = prismaStub();
    prisma.commandAuditLog.create.mockRejectedValueOnce(new Error("audit down"));
    const response = await request(appFor(prisma)).get("/api/storage/recordings");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(overview);
    expect(prisma.commandAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it("validates and confirms a Tier-2 mode change before dispatch", async () => {
    const service = allocator();
    setRecordingsAllocator(service as never);
    const prisma = prismaStub();
    const app = appFor(prisma, "admin");
    expect((await request(app).put("/api/storage/recordings").send({})).status).toBe(400);
    expect((await request(app).put("/api/storage/recordings").send({ mode: "full", device: "md0" })).status).toBe(400);
    expect((await request(app).put("/api/storage/recordings").send({ fsUuid: "../../etc" })).status).toBe(400);

    const pending = await request(app).put("/api/storage/recordings").send({ mode: "full" });
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ service: "recordings_set", resourceId: "recordings", tier: 2 });
    expect(service.setAllocation).not.toHaveBeenCalled();

    const confirmed = await request(app).post("/api/storage/command/confirm").send({
      confirmationToken: pending.body.confirmationToken,
      service: pending.body.service,
      resourceId: pending.body.resourceId,
    });
    expect(confirmed.status).toBe(202);
    expect(service.setAllocation).toHaveBeenCalledWith({ mode: "full" }, { type: "user", id: "user-1" });
    expect(prisma.commandAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tier: 2, confirmed: true }) }),
    );
  });

  it("keeps old-footage deletion Tier 3 and owner-only through confirmation", async () => {
    const service = allocator();
    setRecordingsAllocator(service as never);
    const prisma = prismaStub();
    const owner = appFor(prisma, "owner");
    const pending = await request(owner).post("/api/storage/recordings/old-footage/delete").send({});
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ service: "recordings_old_footage_delete", resourceId: "recordings", tier: 3 });

    const admin = await request(appFor(prisma, "admin")).post("/api/storage/command/confirm").send({
      confirmationToken: pending.body.confirmationToken,
      service: pending.body.service,
      resourceId: pending.body.resourceId,
    });
    expect(admin.status).toBe(403);
    expect(service.deleteOldFootage).not.toHaveBeenCalled();

    const confirmed = await request(owner).post("/api/storage/command/confirm").send({
      confirmationToken: pending.body.confirmationToken,
      service: pending.body.service,
      resourceId: pending.body.resourceId,
    });
    expect(confirmed.status).toBe(202);
    expect(service.deleteOldFootage).toHaveBeenCalledWith({ type: "user", id: "user-1" });
  });

  it("rejects admin deletion even when the service echo is omitted", async () => {
    const service = allocator();
    setRecordingsAllocator(service as never);
    const prisma = prismaStub();
    const pending = await request(appFor(prisma)).post("/api/storage/recordings/old-footage/delete");
    const response = await request(appFor(prisma, "admin")).post("/api/storage/command/confirm").send({
      confirmationToken: pending.body.confirmationToken,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("TOKEN_ENDPOINT_MISMATCH");
    expect(service.deleteOldFootage).not.toHaveBeenCalled();
  });

  it("preserves a token attempted by a different user and dispatches only its stored params", async () => {
    const service = allocator();
    setRecordingsAllocator(service as never);
    const prisma = prismaStub();
    const owner = appFor(prisma);
    const pending = await request(owner).put("/api/storage/recordings").send({ mode: "full" });
    const token = pending.body.confirmationToken;
    const differentUser = await request(appFor(prisma, "admin", "user-2"))
      .post("/api/storage/command/confirm").send({ confirmationToken: token });
    expect(differentUser.body.code).toBe("TOKEN_USER_MISMATCH");
    expect(service.setAllocation).not.toHaveBeenCalled();
    const confirmed = await request(owner).post("/api/storage/command/confirm").send({
      confirmationToken: token,
      params: { mode: "auto_reserved", fsUuid: "deadbeef" },
    });
    expect(confirmed.status).toBe(202);
    expect(service.setAllocation).toHaveBeenCalledWith({ mode: "full" }, { type: "user", id: "user-1" });
  });

  it("rejects a changed confirmation resource and consumes the mismatched token", async () => {
    const service = allocator();
    setRecordingsAllocator(service as never);
    const prisma = prismaStub();
    const app = appFor(prisma);
    const pending = await request(app).put("/api/storage/recordings").send({ mode: "full" });
    const token = pending.body.confirmationToken;
    const mismatch = await request(app).post("/api/storage/command/confirm").send({
      confirmationToken: token, service: "recordings_set", resourceId: "deadbeef",
    });
    expect(mismatch.body.code).toBe("TOKEN_OPERATION_MISMATCH");
    const retry = await request(app).post("/api/storage/command/confirm").send({ confirmationToken: token });
    expect(retry.body.code).toBe("TOKEN_MISSING");
    expect(service.setAllocation).not.toHaveBeenCalled();
  });

  it("refuses a token minted for an invalid allocation resource even without a client echo", async () => {
    const service = allocator();
    setRecordingsAllocator(service as never);
    const prisma = prismaStub();
    const minted = await evaluateStorageCommand(prisma as never, "recordings_set", "deadbeef", { mode: "full" }, "user-1");
    if (!("confirmationToken" in minted)) throw new Error("Expected pending confirmation");
    const response = await request(appFor(prisma)).post("/api/storage/command/confirm").send({
      confirmationToken: minted.confirmationToken,
    });
    expect(response.status).toBe(400);
    expect(service.setAllocation).not.toHaveBeenCalled();
  });
});
