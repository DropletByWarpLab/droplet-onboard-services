import { describe, it, expect } from "vitest";
import { redisConnectionOptions, redisCaPath } from "../src/redis-tls.js";

// WARP-234 — the rerank-cache connection pins the internal CA for rediss://.
describe("redis-tls (WARP-234)", () => {
  it("returns no TLS options for a plaintext redis:// URL (dev compose)", () => {
    expect(redisConnectionOptions("redis://cache:6379", () => Buffer.from("x"))).toEqual({});
  });

  it("pins the internal CA for a rediss:// URL", () => {
    const ca = Buffer.from("---CA---");
    const opts = redisConnectionOptions("rediss://mcp-server:pw@cache:6380", () => ca);
    expect(opts.tls?.ca).toBe(ca);
  });

  it("honors the DROPLET_TLS_CA override with the WARP-236 bundle default", () => {
    const prev = process.env.DROPLET_TLS_CA;
    delete process.env.DROPLET_TLS_CA;
    expect(redisCaPath()).toBe("/data/service-tls/ca.pem");
    process.env.DROPLET_TLS_CA = "/custom/ca.pem";
    expect(redisCaPath()).toBe("/custom/ca.pem");
    if (prev === undefined) delete process.env.DROPLET_TLS_CA;
    else process.env.DROPLET_TLS_CA = prev;
  });
});
