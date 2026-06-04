import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

// Mock the config module to enable OAuth2
vi.mock("../config.js", () => ({
  config: {
    AUTH_MODE: "oauth2",
    AUTH_ENABLED: true,
    OAUTH2_CLIENT_ID: "test-client-id",
    OAUTH2_CLIENT_SECRET: "test-secret",
    DATABASE_URL: "postgresql://droplet:droplet@localhost:5432/droplet",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    NEXTCLOUD_URL: "http://localhost:8080",
    PORT: 3000,
    NODE_ENV: "test",
    FILES_ROOT: ".data/files",
    MAX_UPLOAD_SIZE_MB: 100,
    STORAGE_BACKEND: "legacy",
    AI_GATEWAY_GRPC_URL: "localhost:50051",
    JWT_SECRET: "test-jwt-secret-for-oauth2-tests",
    FRIGATE_URL: "http://localhost:5000",
    DROPLET_PM_WEB_URL: "https://droplet-ai.local/pm",
    // PR #486 finding 2: getRedirectUri now resolves the host via the shared
    // trusted-origin resolver. ROUTING_MODE=disabled keeps that resolver from
    // dialing the DuckDNS sidecar; the redirect_uri falls back to the box's
    // trusted origin (corsAllowedOrigins[0]).
    ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
  },
}));

// Mock the auth middleware to skip authentication for protected routes
vi.mock("../middleware/auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../middleware/auth.js")>();
  return {
    ...original,
    authMiddleware: (_req: any, _res: any, next: any) => {
      _req.user = { id: "test-user", username: "test-user", displayName: "Test User", role: "owner" };
      next();
    },
  };
});

// Mock the Nextcloud client functions used by OAuth2 routes
const mockNcOAuth2AuthorizeUrl = vi.fn();
const mockNcOAuth2ExchangeCode = vi.fn();
const mockNcOAuth2RefreshToken = vi.fn();
const mockNcGetCurrentUser = vi.fn();

vi.mock("../services/nextcloud.client.js", () => ({
  ncOAuth2AuthorizeUrl: (...args: any[]) => mockNcOAuth2AuthorizeUrl(...args),
  ncOAuth2ExchangeCode: (...args: any[]) => mockNcOAuth2ExchangeCode(...args),
  ncOAuth2RefreshToken: (...args: any[]) => mockNcOAuth2RefreshToken(...args),
  ncGetCurrentUser: (...args: any[]) => mockNcGetCurrentUser(...args),
  ncCheckSetupRequired: vi.fn().mockResolvedValue(false),
  ncInstallAndCreateAdmin: vi.fn(),
  ncLoginWithCredentials: vi.fn(),
  ncDeleteAppPassword: vi.fn(),
  ncCreateUser: vi.fn(),
  ncDeleteUser: vi.fn(),
  ncListUsers: vi.fn().mockResolvedValue([]),
}));

// Mock the ai-gateway client
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

// Mock cache service
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  // WARP-90: passthrough stubs so downstream services that now pull
  // withSwrCache/invalidatePrefix don't break under this mock.
  withSwrCache: vi.fn(
    async (_k: string, _ttl: number, producer: () => Promise<unknown>) =>
      producer(),
  ),
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));

describe("OAuth2 endpoints", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /api/auth/authorize ──

  describe("GET /api/auth/authorize", () => {
    it("should redirect to Nextcloud OAuth2 authorize URL when AUTH_MODE=oauth2", async () => {
      const expectedUrl = "http://localhost:8080/index.php/apps/oauth2/authorize?response_type=code&client_id=test-client-id&redirect_uri=http%3A%2F%2F127.0.0.1%2Fapi%2Fauth%2Fcallback&state=abc123";
      mockNcOAuth2AuthorizeUrl.mockReturnValue(expectedUrl);

      const res = await request(app).get("/api/auth/authorize");

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(expectedUrl);
      expect(mockNcOAuth2AuthorizeUrl).toHaveBeenCalledWith(
        "test-client-id",
        expect.stringContaining("/api/auth/callback"),
        expect.any(String)
      );
    });

    it("should set an oauth2_state cookie for CSRF protection", async () => {
      mockNcOAuth2AuthorizeUrl.mockReturnValue("http://localhost:8080/authorize");

      const res = await request(app).get("/api/auth/authorize");

      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const stateCookie = (Array.isArray(cookies) ? cookies : [cookies]).find(
        (c: string) => c.startsWith("oauth2_state=")
      );
      expect(stateCookie).toBeDefined();
      expect(stateCookie).toContain("HttpOnly");
    });

    it("should return 400 when AUTH_MODE is not oauth2", async () => {
      // Temporarily override AUTH_MODE
      const { config } = await import("../config.js");
      const originalMode = config.AUTH_MODE;
      (config as any).AUTH_MODE = "legacy";

      const res = await request(app).get("/api/auth/authorize");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("OAuth2 is not configured");

      // Restore
      (config as any).AUTH_MODE = originalMode;
    });
  });

  // ── GET /api/auth/callback ──

  describe("GET /api/auth/callback", () => {
    it("should exchange code for tokens and set cookies", async () => {
      mockNcOAuth2ExchangeCode.mockResolvedValue({
        accessToken: "access-token-123",
        refreshToken: "refresh-token-456",
        expiresIn: 3600,
      });
      mockNcGetCurrentUser.mockResolvedValue({
        id: "testuser",
        displayName: "Test User",
        email: "test@example.com",
        groups: [],
      });

      const state = "valid-state-token";

      const res = await request(app)
        .get(`/api/auth/callback?code=auth-code-789&state=${state}`)
        .set("Cookie", `oauth2_state=${state}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBe("testuser");

      // Verify cookies are set
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies;
      expect(cookieStr).toContain("droplet_session=access-token-123");
      expect(cookieStr).toContain("droplet_refresh=refresh-token-456");

      // Verify the exchange function was called with correct args
      expect(mockNcOAuth2ExchangeCode).toHaveBeenCalledWith(
        "auth-code-789",
        "test-client-id",
        "test-secret",
        expect.stringContaining("/api/auth/callback")
      );
    });

    it("should reject invalid state (CSRF protection)", async () => {
      const res = await request(app)
        .get("/api/auth/callback?code=auth-code&state=wrong-state")
        .set("Cookie", "oauth2_state=correct-state");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid OAuth2 state");
    });

    it("should reject when no state cookie is present", async () => {
      const res = await request(app)
        .get("/api/auth/callback?code=auth-code&state=some-state");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid OAuth2 state");
    });

    it("should reject missing code", async () => {
      const state = "valid-state";

      const res = await request(app)
        .get(`/api/auth/callback?state=${state}`)
        .set("Cookie", `oauth2_state=${state}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing authorization code");
    });
  });

  // ── POST /api/auth/refresh ──

  describe("POST /api/auth/refresh", () => {
    it("should refresh tokens using refresh token cookie", async () => {
      mockNcOAuth2RefreshToken.mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresIn: 3600,
      });

      const res = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", "droplet_refresh=old-refresh-token");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.expiresIn).toBe(3600);

      // Verify new cookies are set
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies;
      expect(cookieStr).toContain("droplet_session=new-access-token");
      expect(cookieStr).toContain("droplet_refresh=new-refresh-token");

      // Verify the refresh function was called correctly
      expect(mockNcOAuth2RefreshToken).toHaveBeenCalledWith(
        "old-refresh-token",
        "test-client-id",
        "test-secret"
      );
    });

    it("should return 401 when no refresh token cookie is present", async () => {
      const res = await request(app).post("/api/auth/refresh");

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("No refresh token");
    });

    it("should clear cookies and return 401 when refresh fails", async () => {
      mockNcOAuth2RefreshToken.mockResolvedValue(null);

      const res = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", "droplet_refresh=expired-token");

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("Failed to refresh token");
    });
  });
});
