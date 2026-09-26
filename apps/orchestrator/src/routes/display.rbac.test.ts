/**
 * WARP-3193 SEC-AUTH-11 — the front-panel display is a trusted physical
 * surface (claim codes, boot/shutdown status). Writing to it is an operator
 * action: owner + admin only. The status read stays open to every
 * authenticated principal. Mounts the REAL router so the guard wiring — not
 * a synthetic stand-in — is what is asserted.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../services/display.client.js", () => ({
  getDisplayStatus: vi.fn().mockResolvedValue({ mode: "stats" }),
  showStats: vi.fn().mockResolvedValue(true),
  showLogo: vi.fn().mockResolvedValue(true),
  showMessage: vi.fn().mockResolvedValue(true),
  setBrightness: vi.fn().mockResolvedValue(true),
  resumeCycle: vi.fn().mockResolvedValue(true),
  stopCycle: vi.fn().mockResolvedValue(true),
  connectWifi: vi.fn().mockResolvedValue({ ok: true }),
}));

import { createDisplayRouter } from "./display.js";

type Role = "owner" | "admin" | "family" | "guest" | "service";

function appAs(role: Role | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as Request & { user: unknown }).user = {
        id: `user-${role}`,
        username: `user-${role}`,
        displayName: role,
        role,
      };
    }
    next();
  });
  app.use("/api", createDisplayRouter({} as never));
  return app;
}

const WRITES: Array<{ path: string; body: Record<string, unknown> }> = [
  { path: "/api/display/stats", body: {} },
  { path: "/api/display/logo", body: {} },
  { path: "/api/display/message", body: { title: "Re-claim", lines: ["enter code"] } },
  { path: "/api/display/brightness", body: { value: 10 } },
  { path: "/api/display/cycle/resume", body: {} },
  { path: "/api/display/cycle/stop", body: {} },
];

describe("display router RBAC (WARP-3193 SEC-AUTH-11)", () => {
  for (const { path, body } of WRITES) {
    for (const role of ["guest", "family", "service"] as const) {
      it(`POST ${path}: ${role} → 403`, async () => {
        const res = await request(appAs(role)).post(path).send(body);
        expect(res.status).toBe(403);
      });
    }
    it(`POST ${path}: no session → 403`, async () => {
      const res = await request(appAs(null)).post(path).send(body);
      expect(res.status).toBe(403);
    });
    for (const role of ["owner", "admin"] as const) {
      it(`POST ${path}: ${role} → 200`, async () => {
        const res = await request(appAs(role)).post(path).send(body);
        expect(res.status).toBe(200);
      });
    }
  }

  it("GET /api/display/status stays open to a guest", async () => {
    const res = await request(appAs("guest")).get("/api/display/status");
    expect(res.status).toBe(200);
  });
});
