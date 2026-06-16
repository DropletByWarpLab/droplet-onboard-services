import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import type http from "node:http";
import { startHttp } from "../src/transports/http.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";
import {
  assertFipsAtBoot,
  FipsSelfTestError,
} from "@droplet/fips-selftest";

// WARP-229 — mcp-server FIPS integration tests:
//   - boot self-test positive + negative paths
//   - HTTP `/_/fips` endpoint returns the same shape as the orchestrator's

const SECRET = "test-secret-fips";

function buildDeps(): ContextDeps {
  return {
    prisma: {} as never,
    matter: {} as never,
    httpFactory: () => ({
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    }) as never,
  };
}

function installFipsMock() {
  const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
  const realCreateHash = crypto.createHash.bind(crypto);
  const createHashSpy = vi
    .spyOn(crypto, "createHash")
    .mockImplementation((alg: any) => {
      if (alg === "md5") throw new Error("disabled for FIPS");
      return realCreateHash(alg);
    });
  return () => {
    getFipsSpy.mockRestore();
    createHashSpy.mockRestore();
  };
}

describe("mcp-server FIPS boot self-test", () => {
  it("succeeds when FIPS is enforcing", () => {
    const restore = installFipsMock();
    try {
      const result = assertFipsAtBoot("mcp-server", { log: () => {} });
      expect(result.fips).toBe(true);
      expect(result.service).toBe("mcp-server");
    } finally {
      restore();
    }
  });

  it("throws when FIPS is loaded but MD5 succeeds (not enforcing)", () => {
    const getFipsSpy = vi.spyOn(crypto, "getFips").mockReturnValue(1 as any);
    try {
      // No MD5 mock — MD5 will succeed on the dev runner.
      expect(() => assertFipsAtBoot("mcp-server", { log: () => {} })).toThrow(
        FipsSelfTestError,
      );
    } finally {
      getFipsSpy.mockRestore();
    }
  });
});

describe("mcp-server /_/fips HTTP endpoint", () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    const deps = buildDeps();
    server = startHttp({
      port: 0,
      jwtSecret: SECRET,
      buildServer: (claims) => createServer(deps, { kind: "authenticated", claims }),
    });
    await new Promise<void>((resolve) =>
      server.once("listening", () => resolve()),
    );
    const addr = server.address();
    port =
      typeof addr === "object" && addr !== null ? (addr as any).port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 503 + {fips:false} when FIPS is not enabled (dev runner)", async () => {
    // Don't mock — this is the actual dev-runner state.
    const res = await fetch(`http://127.0.0.1:${port}/_/fips`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.event).toBe("fips_self_test");
    expect(body.service).toBe("mcp-server");
    expect(body.fips).toBe(false);
  });

  it("returns 200 + {fips:true} when both probes pass", async () => {
    const restore = installFipsMock();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_/fips`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.fips).toBe(true);
      expect(body.service).toBe("mcp-server");
      expect(body.provider).toBe("OpenSSL 3 FIPS");
    } finally {
      restore();
    }
  });

  it("the endpoint does NOT require auth (operator probe)", async () => {
    // Same call without Authorization header — must still get a body
    // back, not a 401.
    const res = await fetch(`http://127.0.0.1:${port}/_/fips`);
    expect([200, 503]).toContain(res.status);
  });
});
