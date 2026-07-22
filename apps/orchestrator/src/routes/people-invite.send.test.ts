/**
 * BUG-11 — POST /api/people/invite must SEND the invite email after creating
 * the row, and reflect the send outcome without ever 500ing.
 *
 * The pre-existing people-invite.route.test.ts pins the row-creation contract;
 * this file pins the NEW delivery wiring:
 *   - a configured channel → the transport is dialed with the accept link, and
 *     the response carries sendStatus.
 *   - a transport failure → the invite is still created (200), sendStatus is
 *     "failed", and the request does NOT 500.
 *
 * Same harness as people-invite.route.test.ts (synthetic auth + in-memory
 * Prisma mock). The mailer transport is injected so no relay is dialed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    // PR #486 finding 2: the shared invite-url helper reads these. The accept
    // link's host is validated against `corsAllowedOrigins` (the box's trusted
    // origins) and resolved from the canonical origin (WIREGUARD_ENDPOINT_HOST);
    // a forged X-Forwarded-Host is never embedded. No canonical-origin env var
    // is set here, so the helper falls back to the box's trusted origin.
    ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createPeopleRouter } from "./people.js";
import type { ScopeName } from "../middleware/scope.js";
import {
  EMAIL_CHANNEL_SINGLETON_ID,
  type EmailChannelConfig,
} from "../services/email-channel.service.js";
import { __setEncryptionKeyForTest } from "../services/encryption.service.js";

const TEST_KEY = Buffer.alloc(32, 3).toString("base64");

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
  const invites = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    _invites: invites,
    emailChannelSetting: {
      findUnique: vi.fn(async () => channel),
    },
    userInvite: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        seq += 1;
        const row = { id: `inv-${seq}`, createdAt: new Date(), sendAttempts: 0, ...data };
        invites.set(row.id, row);
        return row;
      }),
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

function buildApp(prismaMock: any, sendMail = vi.fn().mockResolvedValue({ accepted: ["x"] })) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: "owner-id", username: "stefan", role: "owner" };
    next();
  });
  // WARP-455 — scope-loader axis is arg 2; sendOptions moves to arg 3. The
  // resend route is gated by requireRole only, so the loader is never
  // invoked here.
  app.use(
    "/api",
    createPeopleRouter(
      prismaMock,
      async () => new Set<ScopeName>(["team"]),
      { transportFactory: () => ({ sendMail }) as never },
    ),
  );
  return { app, sendMail };
}

beforeEach(() => {
  recordActivityMock.mockClear();
  __setEncryptionKeyForTest(TEST_KEY);
});

describe("POST /api/people/invite — email delivery (BUG-11)", () => {
  it("sends the invite email with the accept link and reports sendStatus=sent", async () => {
    const prisma = createPrismaMock(readyChannel());
    const { app, sendMail } = buildApp(prisma);

    const res = await request(app)
      .post("/api/people/invite")
      // x-forwarded-proto mirrors how the reverse proxy fronts the orchestrator;
      // the accept link must honour it (https in front of the box).
      .set("Host", "droplet-ai.local")
      .set("X-Forwarded-Proto", "https")
      .send({ email: "nina@acme.co", role: "family" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.send_status).toBe("sent");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const msg = sendMail.mock.calls[0][0];
    expect(msg.to).toBe("nina@acme.co");
    // The accept link points at the created token on the request host.
    const [row] = [...prisma._invites.values()];
    expect(msg.text).toContain(`https://droplet-ai.local/invite/${row.token}`);
    expect(msg.html).toContain(`href="https://droplet-ai.local/invite/${row.token}"`);
    expect(row.sendStatus).toBe("sent");
  });

  it("excludes a forged X-Forwarded-Host from the accept link (PR #486 finding 2)", async () => {
    const prisma = createPrismaMock(readyChannel());
    const { app, sendMail } = buildApp(prisma);

    const res = await request(app)
      .post("/api/people/invite")
      // A forged X-Forwarded-Host must never end up in the token-bearing link.
      .set("Host", "droplet-ai.local")
      .set("X-Forwarded-Host", "evil.example")
      .set("X-Forwarded-Proto", "https")
      .send({ email: "victim@acme.co", role: "family" });

    expect(res.status).toBe(200);
    const msg = sendMail.mock.calls[0][0];
    const [row] = [...prisma._invites.values()];
    // The attacker host is rejected; the link falls back to the box's trusted
    // origin, preserving the /invite/:token contract.
    expect(msg.text).not.toContain("evil.example");
    expect(msg.html).not.toContain("evil.example");
    expect(msg.text).toContain(`https://droplet-ai.local/invite/${row.token}`);
  });

  it("still creates the invite (200) and reports failed when the transport errors", async () => {
    const prisma = createPrismaMock(readyChannel());
    const failing = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { app } = buildApp(prisma, failing);

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "x@acme.co", role: "guest" });

    // The invite was created; the request did NOT 500.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.send_status).toBe("failed");
    const [row] = [...prisma._invites.values()];
    expect(row.sendStatus).toBe("failed");
    expect(row.sendError).toContain("ECONNREFUSED");
  });

  it("reports failed when no channel is configured (no silent success)", async () => {
    const prisma = createPrismaMock(null);
    const { app, sendMail } = buildApp(prisma);

    const res = await request(app)
      .post("/api/people/invite")
      .send({ email: "y@acme.co", role: "family" });

    expect(res.status).toBe(200);
    expect(res.body.send_status).toBe("failed");
    expect(sendMail).not.toHaveBeenCalled();
  });
});
