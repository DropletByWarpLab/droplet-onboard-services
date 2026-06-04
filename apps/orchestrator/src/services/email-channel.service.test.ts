/**
 * BUG-11 — outbound SMTP invite-email channel.
 *
 * Unit-tests the pure, fallible boundary that turns operator-supplied SMTP
 * config (EmailChannelSetting) + an invite (token → accept link) into a sent
 * message — WITHOUT touching a real SMTP server. The transport is injected, so
 * tests use nodemailer's built-in `streamTransport`/`jsonTransport` stub (it
 * captures the message instead of dialing a relay).
 *
 * What these tests pin:
 *   - config redaction: the password NEVER appears in the API-shaped view
 *     (rule 19) — only `hasPassword`.
 *   - transport options derive correctly from the security mode
 *     (starttls → secure:false, tls → secure:true).
 *   - buildInviteEmail puts the accept LINK (not the bare token in a way that
 *     leaks) into both the text and html parts, with a sane subject + from.
 *   - sendInviteEmail flips the invite to `sent` on success and to `failed`
 *     (with the error, attempts incremented) on transport failure — and a
 *     failure NEVER throws out of the send path (the request must not 500).
 *   - a disabled / unconfigured channel is reported as not-ready rather than
 *     attempting a dial.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("@prisma/client");

import {
  redactChannelConfig,
  buildTransportOptions,
  buildInviteEmail,
  sendInviteEmail,
  isChannelReady,
  EmailChannelNotConfiguredError,
  EMAIL_CHANNEL_SINGLETON_ID,
  type EmailChannelConfig,
} from "./email-channel.service.js";
import { __setEncryptionKeyForTest } from "./encryption.service.js";

// 32-byte base64 test key so encrypt/decrypt round-trips without env setup.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function baseConfig(overrides: Partial<EmailChannelConfig> = {}): EmailChannelConfig {
  return {
    id: EMAIL_CHANNEL_SINGLETON_ID,
    enabled: true,
    host: "smtp.example.com",
    port: 587,
    username: "postmaster@example.com",
    passwordEnc: "",
    fromAddress: "droplet@example.com",
    fromName: "Droplet",
    security: "starttls",
    lastError: null,
    lastTestedAt: null,
    updatedAt: new Date(),
    updatedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  __setEncryptionKeyForTest(TEST_KEY);
});

describe("redactChannelConfig", () => {
  it("never emits the encrypted password or any plaintext; exposes hasPassword", () => {
    const cfg = baseConfig({ passwordEnc: "ZW5jcnlwdGVkLWJsb2I=" });
    const view = redactChannelConfig(cfg);

    // The shape the GET endpoint returns.
    expect(view.host).toBe("smtp.example.com");
    expect(view.port).toBe(587);
    expect(view.username).toBe("postmaster@example.com");
    expect(view.fromAddress).toBe("droplet@example.com");
    expect(view.security).toBe("starttls");
    expect(view.hasPassword).toBe(true);

    // Belt-and-braces: NO key in the view carries the secret.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("ZW5jcnlwdGVkLWJsb2I=");
    expect(serialized).not.toContain("passwordEnc");
    expect(serialized).not.toContain("password");
  });

  it("reports hasPassword=false when no password is set", () => {
    expect(redactChannelConfig(baseConfig({ passwordEnc: "" })).hasPassword).toBe(false);
  });
});

describe("buildTransportOptions", () => {
  it("starttls → secure:false on the configured port with decrypted auth", () => {
    const cfg = baseConfig({ security: "starttls", port: 587 });
    const opts = buildTransportOptions(cfg, "hunter2");
    expect(opts.host).toBe("smtp.example.com");
    expect(opts.port).toBe(587);
    expect(opts.secure).toBe(false);
    expect(opts.auth).toEqual({ user: "postmaster@example.com", pass: "hunter2" });
  });

  it("tls → secure:true (implicit TLS, e.g. port 465)", () => {
    const opts = buildTransportOptions(baseConfig({ security: "tls", port: 465 }), "pw");
    expect(opts.secure).toBe(true);
    expect(opts.port).toBe(465);
  });

  it("omits auth entirely when there is no username (open relay on LAN)", () => {
    const opts = buildTransportOptions(baseConfig({ username: "" }), "");
    expect(opts.auth).toBeUndefined();
  });
});

describe("buildInviteEmail", () => {
  it("includes the accept link in both text and html, with subject + from", () => {
    const msg = buildInviteEmail({
      to: "newperson@acme.co",
      fromAddress: "droplet@example.com",
      fromName: "Droplet",
      acceptUrl: "https://droplet-ai.local/invite/TOKEN123",
      role: "family",
    });

    expect(msg.to).toBe("newperson@acme.co");
    expect(msg.from).toBe('"Droplet" <droplet@example.com>');
    expect(msg.subject).toMatch(/invit/i);
    expect(msg.text).toContain("https://droplet-ai.local/invite/TOKEN123");
    expect(msg.html).toContain("https://droplet-ai.local/invite/TOKEN123");
    // The link must be an <a href> in the html part so it's clickable.
    expect(msg.html).toContain('href="https://droplet-ai.local/invite/TOKEN123"');
  });
});

describe("isChannelReady", () => {
  it("true only when enabled AND host AND fromAddress are present", () => {
    expect(isChannelReady(baseConfig())).toBe(true);
    expect(isChannelReady(baseConfig({ enabled: false }))).toBe(false);
    expect(isChannelReady(baseConfig({ host: "" }))).toBe(false);
    expect(isChannelReady(baseConfig({ fromAddress: "" }))).toBe(false);
    expect(isChannelReady(null)).toBe(false);
  });
});

// ── In-memory UserInvite + EmailChannelSetting store ──
function createPrismaMock(channel: EmailChannelConfig | null) {
  const invites = new Map<string, Record<string, unknown>>();
  return {
    _channel: channel,
    _invites: invites,
    emailChannelSetting: {
      findUnique: vi.fn(async () => channel),
    },
    userInvite: {
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const prev = invites.get(where.id) ?? { id: where.id, sendAttempts: 0 };
          const next = {
            ...prev,
            ...data,
            // emulate Prisma's { increment } operator for sendAttempts
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

describe("sendInviteEmail", () => {
  it("sends via the injected transport and flips the invite to sent", async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: ["newperson@acme.co"], messageId: "<x>" });
    const cfg = baseConfig({ passwordEnc: "" });
    const prisma = createPrismaMock(cfg);

    const result = await sendInviteEmail(
      prisma as never,
      {
        inviteId: "inv-1",
        to: "newperson@acme.co",
        acceptUrl: "https://droplet-ai.local/invite/TOK",
        role: "family",
      },
      { transportFactory: () => ({ sendMail }) as never },
    );

    expect(result.status).toBe("sent");
    expect(sendMail).toHaveBeenCalledTimes(1);
    const sentArg = sendMail.mock.calls[0][0];
    expect(sentArg.to).toBe("newperson@acme.co");
    expect(sentArg.text).toContain("https://droplet-ai.local/invite/TOK");

    const row = prisma._invites.get("inv-1")!;
    expect(row.sendStatus).toBe("sent");
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.sendError).toBeNull();
  });

  it("marks the invite failed (not thrown, not 500) when the transport errors", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:587"));
    const prisma = createPrismaMock(baseConfig());

    // Must NOT throw — the request path stays alive.
    const result = await sendInviteEmail(
      prisma as never,
      {
        inviteId: "inv-2",
        to: "x@acme.co",
        acceptUrl: "https://droplet-ai.local/invite/TOK2",
        role: "guest",
      },
      { transportFactory: () => ({ sendMail }) as never },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("ECONNREFUSED");

    const row = prisma._invites.get("inv-2")!;
    expect(row.sendStatus).toBe("failed");
    expect(row.sendError).toContain("ECONNREFUSED");
    expect(row.sendAttempts).toBe(1);
    // The SMTP error string must not leak the password or the raw token field.
    expect(JSON.stringify(row)).not.toContain("passwordEnc");
  });

  it("does not dial and marks failed when the channel is unconfigured/disabled", async () => {
    const sendMail = vi.fn();
    const prisma = createPrismaMock(baseConfig({ enabled: false }));

    const result = await sendInviteEmail(
      prisma as never,
      {
        inviteId: "inv-3",
        to: "x@acme.co",
        acceptUrl: "https://droplet-ai.local/invite/TOK3",
        role: "family",
      },
      { transportFactory: () => ({ sendMail }) as never },
    );

    expect(sendMail).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not configured|disabled/i);
    const row = prisma._invites.get("inv-3")!;
    expect(row.sendStatus).toBe("failed");
  });
});

describe("EmailChannelNotConfiguredError", () => {
  it("carries a stable code", () => {
    const err = new EmailChannelNotConfiguredError();
    expect(err.code).toBe("EMAIL_CHANNEL_NOT_CONFIGURED");
    expect(err).toBeInstanceOf(Error);
  });
});
