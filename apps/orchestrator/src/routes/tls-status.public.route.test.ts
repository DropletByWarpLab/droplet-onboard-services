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
  it("reports LE_ISSUED with a redirect target", async () => {
    const res = await request(
      appWith({ fqdn: "mybox.droplet-us.com", state: "LE_ISSUED", notAfter: new Date() }),
    ).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("LE_ISSUED");
    expect(res.body.fqdn).toBe("mybox.droplet-us.com");
    expect(res.body.redirectTo).toBe("https://mybox.droplet-us.com/");
  });

  it("reports bootstrap state with NO redirect target", async () => {
    const res = await request(
      appWith({ fqdn: "d-abc.devices.warp-lab.ai", state: "BOOTSTRAP_SELF_SIGNED", notAfter: null }),
    ).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("BOOTSTRAP_SELF_SIGNED");
    expect(res.body.redirectTo).toBeNull();
  });

  it("handles a box with no TlsCert row yet", async () => {
    const res = await request(appWith(null)).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("BOOTSTRAP_SELF_SIGNED");
    expect(res.body.redirectTo).toBeNull();
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
      redirectTo: null,
      hqConfigured: false,
    });
  });
});
