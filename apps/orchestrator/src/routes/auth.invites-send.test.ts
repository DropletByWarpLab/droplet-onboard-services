/**
 * BUG-11 — POST /api/auth/invites (WARP-217 admin invite path) must SEND the
 * invite email after creating the row, mirroring POST /api/people/invite.
 *
 * Focused harness: mounts only the protected auth router with a synthetic
 * owner middleware + an in-memory Prisma mock that includes the
 * emailChannelSetting + userInvite.update surfaces the send path needs. The
 * mailer transport is injected so no relay is dialed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "password",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    REDIS_URL: "redis://localhost:6379",
    // PR #486 finding 2: fields the shared invite-url helper reads. Routing
    // disabled so the DuckDNS sidecar is never dialed in this unit test.
    ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
  },
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncCreateUser: vi.fn().mockResolvedValue(undefined),
  ncGetCurrentUser: vi.fn().mockResolvedValue({ id: "a", displayName: "A", groups: [] }),
  ncListUsers: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("test-nc-token"),
  storeNcToken: vi.fn(),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn(),
  touchNcToken: vi.fn(),
}));

import { createProtectedAuthRouter } from "./auth.js";
import {
  EMAIL_CHANNEL_SINGLETON_ID,
  type EmailChannelConfig,
} from "../services/email-channel.service.js";
import { __setEncryptionKeyForTest } from "../services/encryption.service.js";

const TEST_KEY = Buffer.alloc(32, 5).toString("base64");

function readyChannel(): EmailChannelConfig {
  return {
    id: EMAIL_CHANNEL_SINGLETON_ID,
    enabled: true,
    host: "smtp.acme.co",
    port: 587,
    username: "u",
    passwordEnc: "",
    fromAddress: "droplet@acme.co",
    fromName: "Droplet",
    security: "starttls",
    lastError: null,
    lastTestedAt: null,
    updatedAt: new Date(),
    updatedBy: null,
  };
}

function createPrismaMock(channel: EmailChannelConfig | null) {
  const invites = new Map<string, any>();
  let counter = 0;
  return {
    _invites: invites,
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    emailChannelSetting: {
      findUnique: vi.fn(async () => channel),
    },
    userInvite: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `inv-${++counter}`, createdAt: new Date(), sendAttempts: 0, ...data };
        invites.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const prev = invites.get(where.id) ?? { id: where.id, sendAttempts: 0 };
        const next = {
          ...prev,
          ...data,
          sendAttempts:
            typeof data.sendAttempts === "object" && data.sendAttempts?.increment != null
              ? (prev.sendAttempts ?? 0) + data.sendAttempts.increment
              : data.sendAttempts ?? prev.sendAttempts,
        };
        invites.set(where.id, next);
        return next;
      }),
    },
  };
}

function buildApp(prisma: any, sendMail = vi.fn().mockResolvedValue({ accepted: ["x"] })) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: "owner", username: "admin-issuer", displayName: "Admin", role: "owner" };
    next();
  });
  app.use(
    "/api",
    createProtectedAuthRouter(prisma, { transportFactory: () => ({ sendMail }) as never }),
  );
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "internal" });
  });
  return { app, sendMail };
}

beforeEach(() => {
  vi.clearAllMocks();
  __setEncryptionKeyForTest(TEST_KEY);
});

describe("POST /api/auth/invites — email delivery (BUG-11)", () => {
  it("sends the invite email with the accept link and reports send_status=sent", async () => {
    const prisma = createPrismaMock(readyChannel());
    const { app, sendMail } = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/invites")
      .set("Host", "droplet-ai.local")
      .send({ email: "alice@warp.test", role: "family" });

    expect(res.status).toBe(200);
    // Existing contract preserved: token + url still returned.
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.body.url).toContain(`/invite/${res.body.token}`);
    // New: delivery outcome surfaced.
    expect(res.body.send_status).toBe("sent");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const msg = sendMail.mock.calls[0][0];
    expect(msg.to).toBe("alice@warp.test");
    expect(msg.text).toContain(`/invite/${res.body.token}`);
    const [row] = [...prisma._invites.values()];
    expect(row.sendStatus).toBe("sent");
  });

  it("excludes a forged X-Forwarded-Host from the issued URL + email (PR #486 finding 2)", async () => {
    const prisma = createPrismaMock(readyChannel());
    const { app, sendMail } = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/invites")
      .set("Host", "droplet-ai.local")
      .set("X-Forwarded-Host", "evil.example")
      .set("X-Forwarded-Proto", "https")
      .send({ email: "victim@warp.test", role: "family" });

    expect(res.status).toBe(200);
    // The forged host is in neither the response URL nor the emailed link.
    expect(res.body.url).not.toContain("evil.example");
    expect(res.body.url).toContain(`https://droplet-ai.local/invite/${res.body.token}`);
    const msg = sendMail.mock.calls[0][0];
    expect(msg.text).not.toContain("evil.example");
    expect(msg.html).not.toContain("evil.example");
  });

  it("still creates the invite (200) and reports failed when the transport errors", async () => {
    const prisma = createPrismaMock(readyChannel());
    const failing = vi.fn().mockRejectedValue(new Error("EHOSTUNREACH"));
    const { app } = buildApp(prisma, failing);

    const res = await request(app)
      .post("/api/auth/invites")
      .send({ email: "bob@warp.test", role: "family" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.send_status).toBe("failed");
    const [row] = [...prisma._invites.values()];
    expect(row.sendStatus).toBe("failed");
  });
});
