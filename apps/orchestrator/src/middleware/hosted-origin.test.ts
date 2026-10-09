import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { hostedOriginGuard } from "./hosted-origin.js";

vi.mock("../config.js", () => ({ config: {
  corsAllowedOrigins: [] as string[], DROPLET_LAN_HOSTNAME: "droplet-ai.lan",
} }));

function app() {
  const a = express();
  a.use("/api", hostedOriginGuard);
  a.post("/api/auth/login", (_req, res) => res.status(204).end());
  return a;
}

describe("hostedOriginGuard same-origin acceptance (WARP-3931)", () => {
  it("accepts the canonical host origin", async () => {
    expect((await request(app()).post("/api/auth/login").set("Origin", "https://droplet-ai.lan")).status).toBe(204);
  });
  it("accepts a same-origin request by IP (Origin host == Host)", async () => {
    const res = await request(app()).post("/api/auth/login").set("Host", "192.168.9.195").set("X-Forwarded-Proto", "https")
      .set("Origin", "https://192.168.9.195");
    expect(res.status).toBe(204);
  });
  it("accepts a same-origin request by mDNS name via X-Forwarded-Host", async () => {
    const res = await request(app()).post("/api/auth/login").set("X-Forwarded-Host", "droplet.local").set("X-Forwarded-Proto", "https")
      .set("Origin", "https://droplet.local");
    expect(res.status).toBe(204);
  });
  it("still refuses a foreign origin even when Host is the box IP", async () => {
    const res = await request(app()).post("/api/auth/login").set("Host", "192.168.9.195").set("X-Forwarded-Proto", "https")
      .set("Origin", "https://evil.example");
    expect(res.status).toBe(403); expect(res.body).toEqual({ error: "foreign_origin_refused" });
  });
  it("still refuses the 8443 app listener origin even if it matches Host", async () => {
    const res = await request(app()).post("/api/auth/login").set("Host", "192.168.9.195:8443").set("X-Forwarded-Proto", "https")
      .set("Origin", "https://192.168.9.195:8443");
    expect(res.status).toBe(403);
  });
  it("refuses an http Origin on an https request even with a matching host", async () => {
    const res = await request(app()).post("/api/auth/login").set("Host", "192.168.9.195").set("X-Forwarded-Proto", "https")
      .set("Origin", "http://192.168.9.195");
    expect(res.status).toBe(403);
  });
  it("accepts an http Origin on a plain-http request with a matching host", async () => {
    const res = await request(app()).post("/api/auth/login").set("Host", "192.168.9.195").set("Origin", "http://192.168.9.195");
    expect(res.status).toBe(204);
  });
  it("refuses a different host on the same IP-less request", async () => {
    const res = await request(app()).post("/api/auth/login").set("Host", "192.168.9.195").set("X-Forwarded-Proto", "https")
      .set("Origin", "https://192.168.9.196");
    expect(res.status).toBe(403);
  });
});

describe("hostedOriginGuard configured origins", () => {
  it("accepts a corsAllowedOrigins entry that differs from Host", async () => {
    const { config } = await import("../config.js");
    (config as unknown as { corsAllowedOrigins: string[] }).corsAllowedOrigins = ["https://dash.example.com"];
    try {
      const res = await request(app()).post("/api/auth/login").set("Host", "192.168.9.195").set("X-Forwarded-Proto", "https")
        .set("Origin", "https://dash.example.com");
      expect(res.status).toBe(204);
    } finally {
      (config as unknown as { corsAllowedOrigins: string[] }).corsAllowedOrigins = [];
    }
  });
});
