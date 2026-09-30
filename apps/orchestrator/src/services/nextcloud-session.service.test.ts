/**
 * resolveNcToken — which Nextcloud credential an outbound OCS/WebDAV call
 * uses for this request.
 *
 * The defect this pins: a service principal (voice-io, mcp-server, the rack
 * panel, ...) authenticates with a static `SERVICE_TOKEN_*` Bearer. That is
 * not a JWT, so resolveNcToken fell into the legacy path and returned the
 * service secret itself as the caller's Nextcloud credential. /api/llm/chat
 * then put SERVICE_TOKEN_VOICE into `_meta.ncToken` for every voice turn, and
 * GET /api/storage sent SERVICE_TOKEN_DISPLAY to Nextcloud's OCS on every
 * panel poll. A service principal has no Nextcloud account: it gets no
 * credential, and every ncToken-gated caller fails closed on that.
 *
 * The service-principal cases go through the real authMiddleware, so they
 * pin the representation on `req.user` rather than a hand-built guess of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// Every principal authMiddleware registers from config (SERVICE_PRINCIPALS).
const { SERVICE_TOKENS, redisGet } = vi.hoisted(() => ({
  SERVICE_TOKENS: {
    SERVICE_TOKEN_VOICE: "voice-bearer-0123456789abcdef",
    SERVICE_TOKEN_MCP: "mcp-bearer-0123456789abcdef",
    SERVICE_TOKEN_EMAIL: "email-bearer-0123456789abcdef",
    ORCHESTRATOR_SAMPLER_TOKEN: "sampler-bearer-0123456789abcdef",
    AI_GATEWAY_SAMPLER_TOKEN: "aigw-bearer-0123456789abcdef",
    SERVICE_TOKEN_EGRESS_AUDIT: "egress-bearer-0123456789abcdef",
    SERVICE_TOKEN_RAG_EVAL: "rageval-bearer-0123456789abcdef",
    SERVICE_TOKEN_DISPLAY: "display-bearer-0123456789abcdef",
  } as const,
  redisGet: vi.fn<(key: string) => Promise<string | null>>(),
}));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    config: { ...actual.config, AUTH_ENABLED: true, ...SERVICE_TOKENS },
  };
});

vi.mock("./cache.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cache.service.js")>();
  return { ...actual, getRedis: () => ({ get: redisGet }) };
});

import { resolveNcToken } from "./nextcloud-session.service.js";
import { signAccessToken } from "./jwt.service.js";
import { authMiddleware, SESSION_COOKIE_NAME, type AuthUser } from "../middleware/auth.js";

function buildReq(opts: {
  bearer?: string;
  cookie?: string;
  user?: AuthUser;
}): Request {
  return {
    path: "/api/llm/chat",
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
    cookies: opts.cookie ? { [SESSION_COOKIE_NAME]: opts.cookie } : {},
    user: opts.user,
  } as unknown as Request;
}

/** Run the real authMiddleware and return the request it authenticated. */
function authenticate(bearer: string): Request {
  const req = buildReq({ bearer });
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as Response;
  const next = vi.fn();
  authMiddleware(req, res, next);
  // Service principals resolve synchronously; anything else would be a
  // test-setup error, not the behaviour under test.
  expect(next).toHaveBeenCalledTimes(1);
  return req;
}

const person = {
  id: "3f0c9a8e-0000-4000-8000-000000000001",
  username: "alice",
  displayName: "Alice",
  role: "family",
} as const satisfies AuthUser;

beforeEach(() => {
  redisGet.mockReset();
});

describe("resolveNcToken — service principals never yield a Nextcloud credential", () => {
  it("the voice principal's bearer is not returned as a Nextcloud token", async () => {
    const req = authenticate(SERVICE_TOKENS.SERVICE_TOKEN_VOICE);
    expect(req.user).toMatchObject({ id: "_service:voice", role: "service" });

    await expect(resolveNcToken(req)).resolves.toBeNull();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it.each(Object.entries(SERVICE_TOKENS))(
    "%s: the authenticated principal gets no Nextcloud token",
    async (_name, bearer) => {
      const req = authenticate(bearer);
      expect(req.user?.role).toBe("service");
      expect(req.user?.id.startsWith("_service:")).toBe(true);

      await expect(resolveNcToken(req)).resolves.toBeNull();
      expect(redisGet).not.toHaveBeenCalled();
    },
  );

  it("a person's session cookie riding along a service bearer is not borrowed", async () => {
    // authMiddleware lets the Bearer win (WARP-3038), so the request IS the
    // service principal; the cookie must not become its Nextcloud identity.
    const req = authenticate(SERVICE_TOKENS.SERVICE_TOKEN_VOICE);
    (req as { cookies: Record<string, string> }).cookies = {
      [SESSION_COOKIE_NAME]: signAccessToken(person),
    };
    redisGet.mockResolvedValue("alice-nc-app-password");

    await expect(resolveNcToken(req)).resolves.toBeNull();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it("an extension call-back principal (_service:ext:<slug>) gets no Nextcloud token", async () => {
    const req = buildReq({
      bearer: "dxt_0123456789abcdef",
      user: {
        id: "_service:ext:acme",
        username: "_service:ext:acme",
        displayName: "Extension acme",
        role: "service",
        extensionId: "acme",
      },
    });
    await expect(resolveNcToken(req)).resolves.toBeNull();
  });
});

describe("resolveNcToken — people and the auth-off path are unchanged", () => {
  it("a JWT session resolves the person's app-password from Redis by user id", async () => {
    redisGet.mockResolvedValue("alice-nc-app-password");
    const req = buildReq({ bearer: signAccessToken(person), user: person });

    await expect(resolveNcToken(req)).resolves.toBe("alice-nc-app-password");
    expect(redisGet).toHaveBeenCalledWith(`auth:nc-token:${person.id}`);
  });

  it("a JWT session cookie resolves the same way", async () => {
    redisGet.mockResolvedValue("alice-nc-app-password");
    const req = buildReq({ cookie: signAccessToken(person), user: person });

    await expect(resolveNcToken(req)).resolves.toBe("alice-nc-app-password");
  });

  it("a person's legacy (non-JWT) session token is forwarded unchanged", async () => {
    const req = buildReq({ bearer: "legacy-nc-session-token", user: person });

    await expect(resolveNcToken(req)).resolves.toBe("legacy-nc-session-token");
    expect(redisGet).not.toHaveBeenCalled();
  });

  it("AUTH_ENABLED=false: the synthetic dev user gets the placeholder", async () => {
    const req = buildReq({
      user: { id: "dev", username: "dev", displayName: "Developer", role: "owner" },
    });

    await expect(resolveNcToken(req)).resolves.toBe("dev-mode-token");
  });

  it("no token and no dev user resolves to null", async () => {
    await expect(resolveNcToken(buildReq({ user: person }))).resolves.toBeNull();
  });
});
