import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: { DROPLET_PUBLIC_FQDN: "", HQ_ISSUANCE_URL: "https://hq.example" },
}));

// The gate is exercised separately (middleware/auth.test.ts); here it is a
// pass-through so the view is what's under test. The mount itself is checked
// in the last case — a route that forgot its requireRole would be an
// unauthenticated owner surface.
const requireRoleSpy = vi.fn(
  (..._roles: string[]) =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
);
vi.mock("../middleware/auth.js", () => ({
  requireRole: (...roles: string[]) => requireRoleSpy(...roles),
}));

import { certificateView, createTlsCertificateRouter } from "./tls-certificate.js";

const NOW = new Date("2026-09-20T12:00:00Z");
const day = 86_400_000;

function appWith(row: unknown) {
  const prisma = { tlsCert: { findFirst: async () => row } } as never;
  const app = express();
  app.use("/api", createTlsCertificateRouter(prisma));
  return app;
}

describe("certificateView — the arithmetic the card and the screen share", () => {
  it("an issued certificate: days left, when the box renews, not yet expiring", () => {
    const v = certificateView(
      { state: "LE_ISSUED", fqdn: "mybox.droplet-us.com", notAfter: new Date(NOW.getTime() + 60 * day), updatedAt: NOW },
      NOW,
    );
    expect(v.state).toBe("LE_ISSUED");
    expect(v.fqdn).toBe("mybox.droplet-us.com");
    expect(v.daysLeft).toBe(60);
    // Renewal starts inside the last 30 days.
    expect(v.renewsInDays).toBe(30);
    expect(v.expiringSoon).toBe(false);
    expect(v.hqConfigured).toBe(true);
    expect(v.checkedAt).toBe(NOW.toISOString());
  });

  it("inside the renew window renewsInDays is 0, and inside the last week it is expiring", () => {
    const inWindow = certificateView(
      { state: "LE_RENEW_FAILED", fqdn: "mybox.droplet-us.com", notAfter: new Date(NOW.getTime() + 12 * day) },
      NOW,
    );
    expect(inWindow.daysLeft).toBe(12);
    expect(inWindow.renewsInDays).toBe(0);
    expect(inWindow.expiringSoon).toBe(false);

    const lastWeek = certificateView(
      { state: "LE_RENEW_FAILED", fqdn: "mybox.droplet-us.com", notAfter: new Date(NOW.getTime() + 6 * day + 3600_000) },
      NOW,
    );
    expect(lastWeek.daysLeft).toBe(6);
    expect(lastWeek.expiringSoon).toBe(true);

    // Past expiry: negative days, still expiring, never NaN.
    const expired = certificateView(
      { state: "LE_RENEW_FAILED", fqdn: "mybox.droplet-us.com", notAfter: new Date(NOW.getTime() - 2 * day) },
      NOW,
    );
    expect(expired.daysLeft).toBe(-2);
    expect(expired.renewsInDays).toBe(0);
    expect(expired.expiringSoon).toBe(true);
  });

  it("no row at all is the bootstrap self-signed certificate with nothing to count down", () => {
    const v = certificateView(null, NOW);
    expect(v.state).toBe("BOOTSTRAP_SELF_SIGNED");
    expect(v.fqdn).toBeNull();
    expect(v.daysLeft).toBeNull();
    expect(v.renewsInDays).toBeNull();
    expect(v.expiringSoon).toBe(false);
    expect(v.checkedAt).toBeNull();
  });
});

describe("GET /api/tls/certificate", () => {
  it("serves the view for the newest state row, owner/admin only", async () => {
    const res = await request(
      appWith({ state: "LE_ISSUED", fqdn: "mybox.droplet-us.com", notAfter: new Date(Date.now() + 45 * day), updatedAt: new Date() }),
    ).get("/api/tls/certificate");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("LE_ISSUED");
    expect(res.body.daysLeft).toBeGreaterThanOrEqual(44);
    expect(res.body.expiringSoon).toBe(false);
    // The gate: exactly owner + admin. A route that forgot it would be an
    // unauthenticated owner surface; one that widened it would show the
    // certificate's lifecycle to every family member.
    expect(requireRoleSpy).toHaveBeenCalledWith("owner", "admin");
  });
});
