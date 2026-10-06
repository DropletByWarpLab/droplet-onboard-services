import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { servedMetadataMock } = vi.hoisted(() => ({ servedMetadataMock: vi.fn() }));
vi.mock("../lib/served-cert-pin.js", () => ({ servedCertMetadata: servedMetadataMock }));
vi.mock("../config.js", () => ({ config: { DROPLET_LAN_HOSTNAME: "droplet-ai.lan" } }));
import { createTlsStatusPublicRouter } from "./tls-status.public.route.js";

const historicalRead = vi.fn(async () => ({
  state: "LE_RENEW_FAILED", fqdn: "old.droplet-us.com", notAfter: new Date(0),
}));
function app() {
  const prisma = { tlsCert: { findFirst: historicalRead } } as never;
  const instance = express();
  instance.use("/api", createTlsStatusPublicRouter(prisma));
  return instance;
}

beforeEach(() => {
  servedMetadataMock.mockReset().mockReturnValue(null);
  historicalRead.mockClear();
});

describe("GET /api/tls/status (public)", () => {
  it("uses the installed leaf instead of expired fleet metadata, without a pin or redirect", async () => {
    servedMetadataMock.mockReturnValue({
      state: "LOCAL_CERTIFICATE", fqdn: "droplet-ai.lan",
      notAfter: new Date(Date.now() + 5.5 * 86_400_000), coversInternalHostname: true,
    });
    const res = await request(app()).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: "LOCAL_CERTIFICATE", fqdn: "droplet-ai.lan", daysLeft: 5,
      internalHostname: "droplet-ai.lan", hqConfigured: false, coversInternalHostname: true,
    });
    expect(servedMetadataMock).toHaveBeenCalledWith("droplet-ai.lan");
    expect(historicalRead).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty("fingerprint");
    expect(res.body).not.toHaveProperty("redirectTo");
  });

  it("keeps internal DNS available and reports unknown expiry when the leaf is unreadable", async () => {
    const res = await request(app()).get("/api/tls/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: "UNKNOWN", fqdn: null, daysLeft: null, internalHostname: "droplet-ai.lan",
      hqConfigured: false, coversInternalHostname: null,
    });
    expect(historicalRead).not.toHaveBeenCalled();
  });

  it("reports internal hostname mismatch without exposing the certificate or key", async () => {
    servedMetadataMock.mockReturnValue({
      state: "LOCAL_CERTIFICATE", fqdn: "droplet-ai.lan", notAfter: new Date(0),
      coversInternalHostname: false,
    });
    const res = await request(app()).get("/api/tls/status");
    expect(res.body.coversInternalHostname).toBe(false);
    expect(res.body.daysLeft).toBeLessThan(0);
    expect(Object.keys(res.body).sort()).toEqual([
      "coversInternalHostname", "daysLeft", "fqdn", "hqConfigured", "internalHostname", "state",
    ]);
  });

  it("degrades to 503 without leaking an unexpected metadata error", async () => {
    servedMetadataMock.mockImplementation(() => { throw new Error("secret path"); });
    const res = await request(app()).get("/api/tls/status");
    expect(res.status).toBe(503);
    expect(res.body.state).toBe("UNKNOWN");
    expect(res.body.internalHostname).toBe("droplet-ai.lan");
    expect(res.body.fingerprint).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("secret path");
  });
});
