import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createTlsStatusPublicRouter } from "./tls-status.public.route.js";

function appWith(row: unknown, findFirst?: () => Promise<unknown>) {
  const prisma = {
    tlsCert: { findFirst: findFirst ?? (async () => row) },
  } as never;
  const app = express();
  app.use("/api", createTlsStatusPublicRouter(prisma));
  return app;
}

describe("GET /api/tls/status (public)", () => {
  it("reports LE_ISSUED WITHOUT a navigation target (WARP-1302)", async () => {
    // The orchestrator has no DROPLET_LAN_DNS_AUTHORITY knowledge (compose
    // wires it to the gateway only). On authority=0 shapes the FQDN is
    // publicly-NXDOMAIN, so a redirectTo here would send LAN clients to a
    // DNS dead-end. Navigation is nginx's job: the authority-gated 307
    // (opaqueredirect to the status page's poll) is the ONLY advance signal.
    const res = await request(
      appWith({ fqdn: "mybox.droplet-us.com", state: "LE_ISSUED", notAfter: new Date() }),
    ).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("LE_ISSUED");
    expect(res.body.fqdn).toBe("mybox.droplet-us.com");
    expect(res.body).not.toHaveProperty("redirectTo");
  });

  it("reports bootstrap state, also without a navigation target", async () => {
    const res = await request(
      appWith({ fqdn: "d-abc.devices.warp-lab.ai", state: "BOOTSTRAP_SELF_SIGNED", notAfter: null }),
    ).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("BOOTSTRAP_SELF_SIGNED");
    expect(res.body).not.toHaveProperty("redirectTo");
  });

  it("handles a box with no TlsCert row yet", async () => {
    const res = await request(appWith(null)).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("BOOTSTRAP_SELF_SIGNED");
    expect(res.body).not.toHaveProperty("redirectTo");
    expect(typeof res.body.hqConfigured).toBe("boolean");
  });

  it("keeps the air-gap branch fields (state + hqConfigured) in the payload", async () => {
    const res = await request(
      appWith({ fqdn: null, state: "LE_RENEW_FAILED", notAfter: null }),
    ).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("LE_RENEW_FAILED");
    expect(typeof res.body.hqConfigured).toBe("boolean");
  });

  it("degrades to 503 without leaking when the DB read throws", async () => {
    const res = await request(
      appWith(null, async () => {
        throw new Error("db down");
      }),
    ).get("/api/tls/status");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      state: "UNKNOWN",
      fqdn: null,
      hqConfigured: false,
    });
  });
});
