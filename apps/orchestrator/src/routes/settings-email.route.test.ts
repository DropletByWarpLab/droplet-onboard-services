/**
 * BUG-11 — route tests for the SMTP outbound-channel config surface + the
 * failed-invite retry endpoint.
 *
 *   GET   /api/settings/email                 — owner+admin+family read.
 *                                               Returns the REDACTED config
 *                                               (hasPassword boolean, never the
 *                                               password).
 *   PUT   /api/settings/email                 — owner+admin only. Upserts the
 *                                               singleton; password is
 *                                               write-only (omit to keep).
 *   POST  /api/people/invites/:id/resend       — owner+admin only. Re-sends a
 *                                               failed/pending invite.
 *
 * Strategy mirrors people-invite.route.test.ts: a minimal Express app +
 * supertest with a synthetic auth middleware that stuffs req.user, plus an
 * in-memory Prisma mock. The mailer's transport is injected so no relay is
 * dialed; secret round-trips use the encryption.service test key.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    // PR #486 finding 2: fields the shared invite-url helper reads. Routing
    // disabled so the DuckDNS sidecar is never dialed in this unit test.
    ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createSettingsEmailRouter } from "./settings-email.js";
import {
  EMAIL_CHANNEL_SINGLETON_ID,
  type EmailChannelConfig,
} from "../services/email-channel.service.js";
import {
  __setEncryptionKeyForTest,
  decryptSecret,
} from "../services/encryption.service.js";

const TEST_KEY = Buffer.alloc(32, 9).toString("base64");

function seedConfig(overrides: Partial<EmailChannelConfig> = {}): EmailChannelConfig {
  return {
    id: EMAIL_CHANNEL_SINGLETON_ID,
    enabled: false,
    host: "",
    port: 587,
    username: "",
    passwordEnc: "",
    fromAddress: "",
    fromName: "Droplet",
    security: "starttls",
    lastError: null,
    lastTestedAt: null,
    updatedAt: new Date(),
    updatedBy: null,
    ...overrides,
  };
}

function createPrismaMock(initial: EmailChannelConfig | null) {
  let channel = initial;
  const invites = new Map<string, Record<string, unknown>>();
  return {
    _channel: () => channel,
    _invites: invites,
    emailChannelSetting: {
      findUnique: vi.fn(async () => channel),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          channel = channel
            ? ({ ...channel, ...update, updatedAt: new Date() } as EmailChannelConfig)
            : ({ ...seedConfig(), ...create, updatedAt: new Date() } as EmailChannelConfig);
          return channel;
        },
      ),
    },
    userInvite: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        invites.get(where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const prev = invites.get(where.id) ?? { id: where.id, sendAttempts: 0 };
          const next = {
            ...prev,
            ...data,
            sendAttempts:
              typeof (data as any).sendAttempts === "object" &&
              (data as any).sendAttempts?.increment != null
                ? ((prev as any).sendAttempts ?? 0) + (data as any).sendAttempts.increment
                : (data as any).sendAttempts ?? (prev as any).sendAttempts,
          };
          invites.set(where.id, next);
          return next;
        },
      ),
    },
  };
}

function buildApp(
  prismaMock: any,
  user: { id: string; username: string; role: string } = {
    id: "owner-id",
    username: "stefan",
    role: "owner",
  },
  sendMail = vi.fn().mockResolvedValue({ accepted: ["x@acme.co"] }),
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { ...user };
    next();
  });
  app.use(
    "/api",
    createSettingsEmailRouter(prismaMock, {
      transportFactory: () => ({ sendMail }) as never,
    }),
  );
  return { app, sendMail };
}

beforeEach(() => {
  recordActivityMock.mockClear();
  __setEncryptionKeyForTest(TEST_KEY);
});

describe("GET /api/settings/email", () => {
  it("returns the redacted config (hasPassword, never the password)", async () => {
    const prisma = createPrismaMock(
      seedConfig({ host: "smtp.acme.co", username: "u", passwordEnc: "c2VjcmV0LWJsb2I=" }),
    );
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/settings/email");

    expect(res.status).toBe(200);
    expect(res.body.host).toBe("smtp.acme.co");
    expect(res.body.hasPassword).toBe(true);
    // The encrypted blob and the word "password" must never appear.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("c2VjcmV0LWJsb2I=");
    expect(serialized).not.toContain("passwordEnc");
  });

  it("returns a sane default shape when no row exists yet", async () => {
    const prisma = createPrismaMock(null);
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/settings/email");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.hasPassword).toBe(false);
  });

  it("403s a guest (household config is not for short-lived guests)", async () => {
    const prisma = createPrismaMock(seedConfig());
    const { app } = buildApp(prisma, { id: "g", username: "guest1", role: "guest" });
    const res = await request(app).get("/api/settings/email");
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/settings/email", () => {
  it("persists config and encrypts the password at rest (owner)", async () => {
    const prisma = createPrismaMock(seedConfig());
    const { app } = buildApp(prisma);

    const res = await request(app).put("/api/settings/email").send({
      enabled: true,
      host: "smtp.acme.co",
      port: 587,
      username: "postmaster@acme.co",
      password: "hunter2",
      fromAddress: "droplet@acme.co",
      fromName: "Acme Droplet",
      security: "starttls",
    });

    expect(res.status).toBe(200);
    // Response is redacted — no plaintext password echoed back.
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    expect(res.body.hasPassword).toBe(true);

    // The stored blob must decrypt back to the plaintext (encrypted at rest).
    const stored = prisma._channel()!;
    expect(stored.host).toBe("smtp.acme.co");
    expect(stored.passwordEnc).not.toBe("hunter2");
    expect(stored.passwordEnc.length).toBeGreaterThan(0);
    expect(decryptSecret(stored.passwordEnc)).toBe("hunter2");
  });

  it("treats an omitted password as keep-existing (write-only field)", async () => {
    const prisma = createPrismaMock(
      seedConfig({ host: "old.acme.co", passwordEnc: "existing-blob" }),
    );
    const { app } = buildApp(prisma);

    const res = await request(app)
      .put("/api/settings/email")
      .send({ enabled: true, host: "new.acme.co", fromAddress: "d@acme.co" });

    expect(res.status).toBe(200);
    const stored = prisma._channel()!;
    expect(stored.host).toBe("new.acme.co");
    // Password untouched because the body omitted it.
    expect(stored.passwordEnc).toBe("existing-blob");
  });

  it("clears the password when an explicit empty string is sent", async () => {
    const prisma = createPrismaMock(
      seedConfig({ host: "x", passwordEnc: "existing-blob" }),
    );
    const { app } = buildApp(prisma);
    const res = await request(app)
      .put("/api/settings/email")
      .send({ enabled: true, host: "x", fromAddress: "d@acme.co", password: "" });
    expect(res.status).toBe(200);
    expect(prisma._channel()!.passwordEnc).toBe("");
  });

  it("400s an invalid security mode", async () => {
    const prisma = createPrismaMock(seedConfig());
    const { app } = buildApp(prisma);
    const res = await request(app)
      .put("/api/settings/email")
      .send({ enabled: true, host: "x", fromAddress: "d@acme.co", security: "ssl-v2" });
    expect(res.status).toBe(400);
  });

  it("400s a non-email fromAddress", async () => {
    const prisma = createPrismaMock(seedConfig());
    const { app } = buildApp(prisma);
    const res = await request(app)
      .put("/api/settings/email")
      .send({ enabled: true, host: "x", fromAddress: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("403s a family-role writer (writes are owner+admin only)", async () => {
    const prisma = createPrismaMock(seedConfig());
    const { app } = buildApp(prisma, { id: "f", username: "fam", role: "family" });
    const res = await request(app)
      .put("/api/settings/email")
      .send({ enabled: true, host: "x", fromAddress: "d@acme.co" });
    expect(res.status).toBe(403);
  });

  it("emits an audit row on a successful write that never contains the password", async () => {
    const prisma = createPrismaMock(seedConfig());
    const { app } = buildApp(prisma);
    await request(app).put("/api/settings/email").send({
      enabled: true,
      host: "smtp.acme.co",
      fromAddress: "d@acme.co",
      password: "topsecret",
    });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const arg = recordActivityMock.mock.calls[0][0];
    expect(JSON.stringify(arg)).not.toContain("topsecret");
  });
});

describe("POST /api/people/invites/:id/resend", () => {
  it("re-sends a failed invite and flips it to sent", async () => {
    const prisma = createPrismaMock(
      seedConfig({ enabled: true, host: "smtp.acme.co", fromAddress: "d@acme.co" }),
    );
    prisma._invites.set("inv-1", {
      id: "inv-1",
      token: "TOK-RESEND",
      email: "person@acme.co",
      role: "family",
      sendStatus: "failed",
      sendAttempts: 1,
      revokedAt: null,
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { app, sendMail } = buildApp(prisma);

    const res = await request(app).post("/api/people/invites/inv-1/resend");

    expect(res.status).toBe(200);
    expect(res.body.sendStatus).toBe("sent");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(prisma._invites.get("inv-1")!.sendStatus).toBe("sent");
  });

  it("excludes a forged X-Forwarded-Host from the resent accept link (PR #486 finding 2)", async () => {
    const prisma = createPrismaMock(
      seedConfig({ enabled: true, host: "smtp.acme.co", fromAddress: "d@acme.co" }),
    );
    prisma._invites.set("inv-1", {
      id: "inv-1",
      token: "TOK-FORGE",
      email: "victim@acme.co",
      role: "family",
      sendStatus: "failed",
      sendAttempts: 1,
      revokedAt: null,
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { app, sendMail } = buildApp(prisma);

    const res = await request(app)
      .post("/api/people/invites/inv-1/resend")
      .set("Host", "droplet-ai.local")
      .set("X-Forwarded-Host", "evil.example")
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    const msg = sendMail.mock.calls[0][0];
    expect(msg.text).not.toContain("evil.example");
    expect(msg.html).not.toContain("evil.example");
    expect(msg.text).toContain("https://droplet-ai.local/invite/TOK-FORGE");
  });

  it("410s a resend on an expired invite — the accept link would 410 on click (onboard#486)", async () => {
    const prisma = createPrismaMock(
      seedConfig({ enabled: true, host: "smtp.acme.co", fromAddress: "d@acme.co" }),
    );
    prisma._invites.set("inv-exp", {
      id: "inv-exp",
      token: "TOK-EXP",
      email: "old@acme.co",
      role: "family",
      sendStatus: "failed",
      sendAttempts: 1,
      revokedAt: null,
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 1_000), // already past
    });
    const { app, sendMail } = buildApp(prisma);

    const res = await request(app).post("/api/people/invites/inv-exp/resend");

    expect(res.status).toBe(410);
    expect(res.body.code).toBe("INVITE_EXPIRED");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("404s an unknown invite", async () => {
    const prisma = createPrismaMock(seedConfig({ enabled: true, host: "h", fromAddress: "d@acme.co" }));
    const { app } = buildApp(prisma);
    const res = await request(app).post("/api/people/invites/nope/resend");
    expect(res.status).toBe(404);
  });

  it("409s a resend on an already-accepted invite", async () => {
    const prisma = createPrismaMock(seedConfig({ enabled: true, host: "h", fromAddress: "d@acme.co" }));
    prisma._invites.set("inv-acc", {
      id: "inv-acc",
      token: "T",
      email: "a@acme.co",
      role: "family",
      sendStatus: "sent",
      acceptedAt: new Date(),
      revokedAt: null,
    });
    const { app } = buildApp(prisma);
    const res = await request(app).post("/api/people/invites/inv-acc/resend");
    expect(res.status).toBe(409);
  });

  it("returns 200 with failed status (not 500) when the transport errors", async () => {
    const prisma = createPrismaMock(
      seedConfig({ enabled: true, host: "smtp.acme.co", fromAddress: "d@acme.co" }),
    );
    prisma._invites.set("inv-2", {
      id: "inv-2",
      token: "T2",
      email: "b@acme.co",
      role: "guest",
      sendStatus: "failed",
      sendAttempts: 1,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const failingSend = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const { app } = buildApp(prisma, undefined, failingSend);

    const res = await request(app).post("/api/people/invites/inv-2/resend");

    // The retry surfaces the failure explicitly but does NOT 500.
    expect(res.status).toBe(200);
    expect(res.body.sendStatus).toBe("failed");
    expect(prisma._invites.get("inv-2")!.sendStatus).toBe("failed");
  });

  it("403s a family-role caller (invites are admin-only)", async () => {
    const prisma = createPrismaMock(seedConfig({ enabled: true, host: "h", fromAddress: "d@acme.co" }));
    const { app } = buildApp(prisma, { id: "f", username: "fam", role: "family" });
    const res = await request(app).post("/api/people/invites/whatever/resend");
    expect(res.status).toBe(403);
  });
});
