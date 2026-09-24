/**
 * WARP-2981 (ADR-059 §7.1) — /api/me/active-department is REACHABLE in the
 * real app, and only through authMiddleware.
 *
 * The route tests drive the router alone. This drives `createApp`, so a
 * router that was built but never mounted, mounted before authMiddleware, or
 * shadowed by an earlier `/me/...` route fails here rather than on a box.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../services/ai-gateway.client.js", () => ({
  aiGatewayClient: { health: vi.fn().mockResolvedValue({ ok: true }) },
}));

import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { signAccessToken } from "../services/jwt.service.js";

const PATH = "/api/me/active-department";

describe("/api/me/active-department is mounted behind authMiddleware", () => {
  let app: ReturnType<typeof createApp>;
  const findUnique = vi.fn().mockResolvedValue(null);

  beforeAll(() => {
    const prisma = new PrismaClient();
    // The global test double has no delegate for the new model; give it the
    // one read GET makes.
    (prisma as unknown as { activeDepartmentChoice: unknown }).activeDepartmentChoice = { findUnique };
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  it("without a credential it is a 401 — the router never runs", async () => {
    const res = await request(app).get(PATH);
    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("a signed-in person reaches the router and reads their own row", async () => {
    const token = signAccessToken({
      id: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918",
      username: "maria",
      displayName: "Maria",
      role: "family",
    });
    const res = await request(app).get(PATH).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ department: null });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918" } }),
    );
  });
});
