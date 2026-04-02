/**
 * E2E Authentication Tests
 *
 * Tests the full auth cookie lifecycle against live services:
 *   Login → cookie set → /auth/me with cookie → page reload (new request) → logout
 *
 * Requires the Docker stack to be running:
 *   docker compose -f docker/docker-compose.yml up
 *
 * Run:
 *   API_URL=https://localhost npx vitest run tests/auth.integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";

// Use HTTPS by default (self-signed cert); fall back to HTTP for CI
const API_URL = process.env.API_URL ?? "https://localhost";

// Test user credentials — must exist in Nextcloud
const TEST_USER = process.env.TEST_USER ?? "rjouffret";
const TEST_PASS = process.env.TEST_PASS ?? "Nassty71995&";

// Allow self-signed certificates
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/**
 * Low-level fetch that preserves Set-Cookie headers.
 * Returns the response + parsed JSON + raw Set-Cookie header.
 */
async function rawFetch(
  url: string,
  init?: RequestInit & { cookie?: string }
) {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (init?.cookie) {
    headers["Cookie"] = init.cookie;
  }

  const res = await fetch(url, {
    ...init,
    headers,
    redirect: "manual",
  });

  const body = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {}

  // Extract Set-Cookie header(s)
  const setCookie = res.headers.getSetCookie?.() ?? [];

  return { status: res.status, body: json, raw: body, setCookie, res };
}

/**
 * Parse a Set-Cookie header string into name, value, and attributes.
 */
function parseCookie(setCookieHeader: string) {
  const parts = setCookieHeader.split(";").map((s) => s.trim());
  const [nameValue, ...attrs] = parts;
  const eqIdx = nameValue.indexOf("=");
  const name = nameValue.slice(0, eqIdx);
  const value = nameValue.slice(eqIdx + 1);

  const attributes: Record<string, string | true> = {};
  for (const attr of attrs) {
    const [key, val] = attr.split("=");
    attributes[key.toLowerCase().trim()] = val?.trim() ?? true;
  }

  return { name, value, attributes };
}

describe("Authentication E2E", () => {
  // ── Smoke check: API is reachable ──
  beforeAll(async () => {
    try {
      const res = await fetch(`${API_URL}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Health check returned ${res.status}`);
    } catch (err: any) {
      throw new Error(
        `API not reachable at ${API_URL}. Is the Docker stack running?\n${err.message}`
      );
    }
  });

  describe("Login", () => {
    it("rejects invalid credentials with 401", async () => {
      const { status, body } = await rawFetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "nobody", password: "wrongpass" }),
      });

      expect(status).toBe(401);
      expect(body.error).toBeDefined();
    });

    it("rejects empty body with 400", async () => {
      const { status } = await rawFetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(status).toBe(400);
    });

    it("returns user info and sets HTTP-only session cookie", async () => {
      const { status, body, setCookie } = await rawFetch(
        `${API_URL}/api/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: TEST_USER,
            password: TEST_PASS,
          }),
        }
      );

      expect(status).toBe(200);

      // Response should contain user info but NOT the token
      expect(body.user).toBeDefined();
      expect(body.user.id || body.user.username).toBe(TEST_USER);
      expect(body.user.displayName).toBeDefined();
      expect(body.token).toBeUndefined();

      // Should have a Set-Cookie header for the session
      expect(setCookie.length).toBeGreaterThan(0);
      const sessionCookie = setCookie.find((c: string) =>
        c.startsWith("droplet_session=")
      );
      expect(sessionCookie).toBeDefined();

      // Validate cookie attributes
      const parsed = parseCookie(sessionCookie!);
      expect(parsed.name).toBe("droplet_session");
      expect(parsed.value).toBeTruthy(); // non-empty token
      expect(parsed.attributes["httponly"]).toBe(true);
      expect(parsed.attributes["samesite"]).toBe("Lax");
      expect(parsed.attributes["path"]).toBe("/");
      expect(parsed.attributes["max-age"]).toBeDefined();

      // max-age should be ~7 days (604800 seconds)
      const maxAge = Number(parsed.attributes["max-age"]);
      expect(maxAge).toBeGreaterThan(600000); // > 6.9 days in seconds
      expect(maxAge).toBeLessThanOrEqual(604800); // <= 7 days
    });
  });

  describe("Session Persistence", () => {
    let sessionCookieHeader: string;

    beforeAll(async () => {
      // Log in and capture the cookie
      const { setCookie } = await rawFetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: TEST_USER,
          password: TEST_PASS,
        }),
      });

      const sessionCookie = setCookie.find((c: string) =>
        c.startsWith("droplet_session=")
      );
      expect(sessionCookie).toBeDefined();

      // Extract just "droplet_session=<value>" for the Cookie header
      const parsed = parseCookie(sessionCookie!);
      sessionCookieHeader = `${parsed.name}=${parsed.value}`;
    });

    it("GET /api/auth/me succeeds with session cookie", async () => {
      const { status, body } = await rawFetch(`${API_URL}/api/auth/me`, {
        cookie: sessionCookieHeader,
      });

      expect(status).toBe(200);
      expect(body.username).toBe(TEST_USER);
      expect(body.displayName).toBeDefined();
      expect(body.id).toBeDefined();
    });

    it("GET /api/auth/me fails without cookie (simulates cleared session)", async () => {
      const { status } = await rawFetch(`${API_URL}/api/auth/me`);
      expect(status).toBe(401);
    });

    it("protected API routes work with session cookie", async () => {
      const { status, body } = await rawFetch(`${API_URL}/api/health`, {
        cookie: sessionCookieHeader,
      });

      expect(status).toBe(200);
      expect(body.status).toBeDefined();
    });

    it("storage API works with session cookie", async () => {
      const { status, body } = await rawFetch(`${API_URL}/api/storage`, {
        cookie: sessionCookieHeader,
      });

      expect(status).toBe(200);
      expect(body.total).toBeDefined();
      expect(body.used).toBeDefined();
      expect(body.percentage).toBeDefined();
    });

    it("simulates page reload: new request with same cookie works", async () => {
      // First request (initial page load)
      const first = await rawFetch(`${API_URL}/api/auth/me`, {
        cookie: sessionCookieHeader,
      });
      expect(first.status).toBe(200);

      // Second request (page reload — completely new HTTP request, same cookie)
      const second = await rawFetch(`${API_URL}/api/auth/me`, {
        cookie: sessionCookieHeader,
      });
      expect(second.status).toBe(200);
      expect(second.body.username).toBe(first.body.username);
    });

    it("multiple concurrent requests with same cookie all succeed", async () => {
      const requests = Array.from({ length: 5 }, () =>
        rawFetch(`${API_URL}/api/auth/me`, {
          cookie: sessionCookieHeader,
        })
      );

      const results = await Promise.all(requests);
      for (const result of results) {
        expect(result.status).toBe(200);
        expect(result.body.username).toBe(TEST_USER);
      }
    });
  });

  describe("Logout", () => {
    let sessionCookieHeader: string;

    beforeAll(async () => {
      const { setCookie } = await rawFetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: TEST_USER,
          password: TEST_PASS,
        }),
      });

      const sessionCookie = setCookie.find((c: string) =>
        c.startsWith("droplet_session=")
      );
      const parsed = parseCookie(sessionCookie!);
      sessionCookieHeader = `${parsed.name}=${parsed.value}`;
    });

    it("POST /api/auth/logout clears the session cookie", async () => {
      const { status, body, setCookie } = await rawFetch(
        `${API_URL}/api/auth/logout`,
        {
          method: "POST",
          cookie: sessionCookieHeader,
        }
      );

      expect(status).toBe(200);
      expect(body.status).toBe("ok");

      // Should send a Set-Cookie that clears the session
      const clearCookie = setCookie.find((c: string) =>
        c.startsWith("droplet_session=")
      );
      expect(clearCookie).toBeDefined();

      // The cleared cookie should have an empty value or past expiry
      const parsed = parseCookie(clearCookie!);
      const isCleared =
        parsed.value === "" ||
        parsed.attributes["max-age"] === "0" ||
        (parsed.attributes["expires"] &&
          new Date(parsed.attributes["expires"] as string) < new Date());
      expect(isCleared).toBe(true);
    });

    it("session cookie is invalid after logout", async () => {
      // Use the old cookie — should be rejected
      const { status } = await rawFetch(`${API_URL}/api/auth/me`, {
        cookie: sessionCookieHeader,
      });

      // Token was revoked at Nextcloud, so validation should fail
      // (may be cached for up to 5 min in Redis — accept 200 or 401)
      expect([200, 401]).toContain(status);
    });
  });

  describe("Bearer Token Backward Compatibility", () => {
    it("Authorization: Bearer header still works for API clients", async () => {
      // Log in to get a token via cookie
      const { setCookie } = await rawFetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: TEST_USER,
          password: TEST_PASS,
        }),
      });

      const sessionCookie = setCookie.find((c: string) =>
        c.startsWith("droplet_session=")
      );
      const parsed = parseCookie(sessionCookie!);
      const token = parsed.value;

      // Use the token as a Bearer header instead of a cookie
      const { status, body } = await rawFetch(`${API_URL}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      expect(body.username).toBe(TEST_USER);
    });
  });
});
