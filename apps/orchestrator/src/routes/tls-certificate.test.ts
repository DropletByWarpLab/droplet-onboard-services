import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: { DROPLET_PUBLIC_FQDN: "", HQ_ISSUANCE_URL: "https://hq.example" },
}));

// The gate is exercised in full in middleware/auth.test.ts; here it is a
// faithful stand-in — it admits exactly the roles the route registers and
// answers 403 to everyone else, like the real one — so the route's own
// allowlist is what the role-split cases below actually test. The mount
// itself is checked too: a route that forgot its requireRole would be an
// unauthenticated owner surface.
const requireRoleSpy = vi.fn(
  (...roles: string[]) =>
    (
      req: { user?: { role?: string } },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) =>
      roles.includes(String(req.user?.role))
        ? next()
        : res.status(403).json({ error: "Forbidden: role not permitted" }),
);
vi.mock("../middleware/auth.js", () => ({
  requireRole: (...roles: string[]) => requireRoleSpy(...roles),
}));

// WARP-3414: the served certificate's key fingerprint comes from the leaf on
// disk (lib/served-cert-pin.ts, tested on its own); a fixed value here.
const FINGERPRINT =
  "F017 AFA8 6AD7 8BED 4ABD E646 90F0 5B7B 8DBB E36B 26E9 C8F4 10E5 36A6 1E3D F25C";
vi.mock("../lib/served-cert-pin.js", () => ({
  servedCertFingerprint: () => FINGERPRINT,
}));

import { certificateView, createTlsCertificateRouter } from "./tls-certificate.js";

const NOW = new Date("2026-09-20T12:00:00Z");
const day = 86_400_000;

// `role: null` is an anonymous request (an explicit `undefined` would take the default).
function appWith(row: unknown, role: string | null = "owner") {
  const prisma = { tlsCert: { findFirst: async () => row } } as never;
  const app = express();
  app.use((req, _res, next) => {
    if (role) (req as unknown as { user: { role: string } }).user = { role };
    next();
  });
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

  // WARP-3414: the key fingerprint is public data, but it is shown only over
  // the box's authenticated, owner/admin surface — never to a member or an
  // external guest, and never by an anonymous request.
  it("carries the served key fingerprint to an owner and an admin", async () => {
    for (const role of ["owner", "admin"]) {
      const res = await request(appWith(null, role)).get("/api/tls/certificate");
      expect(res.status).toBe(200);
      expect(res.body.fingerprint).toBe(FINGERPRINT);
    }
  });

  it("gives a member (family), an external guest and an anonymous request no fingerprint", async () => {
    for (const role of ["family", "guest", null]) {
      const res = await request(appWith(null, role)).get("/api/tls/certificate");
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain("F017");
      expect(res.body.fingerprint).toBeUndefined();
    }
  });
});

describe("certificateView — fingerprint", () => {
  it("is null unless the caller supplies one (an unreadable leaf shows nothing, not a placeholder)", () => {
    expect(certificateView(null, NOW).fingerprint).toBeNull();
    expect(certificateView(null, NOW, FINGERPRINT).fingerprint).toBe(FINGERPRINT);
  });
});
