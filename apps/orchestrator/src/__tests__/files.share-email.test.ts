/**
 * WARP-941 — POST /api/files/share fires a best-effort notification email
 * for person shares (shareType 0).
 *
 * Sharing a file with a household member persisted the share in Nextcloud
 * but told the recipient NOTHING — no email, no signal. This wires the
 * existing operator-configured SMTP channel (email-channel.service, the
 * same relay that delivers user invites) to person-share creation:
 *
 *   - recipient email is resolved from the LOCAL Prisma User table by
 *     nextcloudUsername (case-insensitive), the same directory path
 *     /files/share-recipients uses (ADR-013), decrypted via readUserEmail.
 *   - the send is FIRE-AND-FORGET: channel unconfigured, recipient without
 *     an email, or a transport failure must never fail or delay the share
 *     response — the share already exists in Nextcloud.
 *   - link shares (shareType 3) send nothing — explicit code path, no
 *     directory lookup at all.
 *
 * The transport is injected through createFilesRouter's SendOptions seam
 * (same seam auth.ts uses for invites) so no test dials a relay.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as Request & { user?: { role?: string } }).user?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
  requireRoleOrMcpService:
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as Request & { user?: { role?: string } }).user?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      next();
    },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../config.js", () => ({
  config: { MAX_UPLOAD_SIZE_MB: 10, NODE_ENV: "test", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nc-session-token"),
}));
vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncListShares: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
    ncListTrash: vi.fn(),
    ncRestoreTrashItem: vi.fn(),
    ncDeleteTrashItem: vi.fn(),
    ncEmptyTrash: vi.fn(),
    ncListVersions: vi.fn(),
    ncRestoreVersion: vi.fn(),
    ncSetFavorite: vi.fn(),
    ncListFavorites: vi.fn(),
    ncSearchFiles: vi.fn(),
    ncListRecents: vi.fn(),
    ncFetchThumbnail: vi.fn(),
    ncCreateShareV2: vi.fn(),
    ncUpdateShare: vi.fn(),
    ncDeleteShare: vi.fn(),
    ncListSharedWithMe: vi.fn(),
    ncListOutboundShares: vi.fn(),
  };
});

import { createFilesRouter } from "../routes/files.js";
import { ncCreateShareV2 } from "../services/nextcloud.client.js";
import type { EmailChannelConfig } from "../services/email-channel.service.js";

const ncCreateShareV2Mock = vi.mocked(ncCreateShareV2);

interface FakeUser {
  id: string;
  username: string;
  role: "owner" | "admin" | "family";
}

interface UserRow {
  id: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
}

const CALLER: FakeUser = { id: "uuid-caller", username: "stef-local", role: "family" };

function roster(overrides: Partial<Record<"romainEmail", string | null>> = {}): UserRow[] {
  return [
    {
      id: "uuid-caller",
      displayName: "Stefan",
      email: "stef@example.com",
      nextcloudUsername: "Stefan-Cruceru",
    },
    {
      id: "uuid-romain",
      displayName: "Romain",
      email: overrides.romainEmail !== undefined ? overrides.romainEmail : "romain@example.com",
      nextcloudUsername: "romain",
    },
  ];
}

function readyChannel(): EmailChannelConfig {
  return {
    id: "singleton",
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
  };
}

const CREATED_PERSON_SHARE = {
  id: 77,
  url: null,
  token: null,
  shareType: 0,
  permissions: 1,
  path: "/Photos/trip.jpg",
  expireDate: null,
  hasPassword: false,
  note: null,
  shareWith: "romain",
  shareWithDisplayName: "Romain",
  uidOwner: "stefan",
  ownerDisplayName: "Stefan",
  stime: 1712860391,
};

function buildApp(opts: {
  rows?: UserRow[];
  channel?: EmailChannelConfig | null;
  sendMail?: ReturnType<typeof vi.fn>;
}) {
  const { rows = roster(), channel = readyChannel(), sendMail = vi.fn() } = opts;
  sendMail.mockResolvedValue?.(undefined);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: FakeUser }).user = CALLER;
    next();
  });
  const findMany = vi.fn(async () => rows);
  const prismaStub = {
    fileCitation: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      ),
      findMany,
    },
    emailChannelSetting: {
      findUnique: vi.fn(async () => channel),
    },
  };
  app.use(
    "/api",
    createFilesRouter(prismaStub as never, {
      transportFactory: () => ({ sendMail }) as never,
    }),
  );
  return { app, sendMail, findMany };
}

/** Let the fire-and-forget notification chain drain. */
async function flushAsync(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("WARP-941 — POST /api/files/share person-share notification email", () => {
  beforeEach(() => {
    ncCreateShareV2Mock.mockReset();
    ncCreateShareV2Mock.mockResolvedValue(CREATED_PERSON_SHARE as never);
  });

  it("sends the notification to the recipient's directory email when the channel is ready", async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ sendMail });

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/Photos/trip.jpg", shareType: 0, permissions: 1, shareWith: "romain" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(77);

    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    const msg = sendMail.mock.calls[0][0];
    expect(msg.to).toBe("romain@example.com");
    expect(msg.from).toBe('"Droplet" <droplet@example.com>');
    // The body names the sharer and the file so the email is actionable.
    expect(msg.text).toContain("Stefan");
    expect(msg.text).toContain("trip.jpg");
    expect(msg.html).toContain("trip.jpg");
  });

  it("matches the recipient case-insensitively on nextcloudUsername", async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ sendMail });

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/doc.txt", shareType: 0, shareWith: "ROMAIN" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    expect(sendMail.mock.calls[0][0].to).toBe("romain@example.com");
  });

  it("prefers an exact-case nextcloudUsername match over a differently-cased row", async () => {
    // Two directory rows whose nextcloudUsername differ ONLY by case. The
    // differently-cased "Romain" is listed FIRST, so a naive case-insensitive
    // .find() would misdeliver the notification (which discloses the sharer +
    // filename) to the WRONG person. The row that matches shareWith exactly
    // must win; the case-insensitive path is only a fallback.
    const rows: UserRow[] = [
      {
        id: "uuid-caller",
        displayName: "Stefan",
        email: "stef@example.com",
        nextcloudUsername: "Stefan-Cruceru",
      },
      {
        id: "uuid-romain-other",
        displayName: "Romain (other)",
        email: "wrong-romain@example.com",
        nextcloudUsername: "Romain",
      },
      {
        id: "uuid-romain-exact",
        displayName: "Romain",
        email: "romain@example.com",
        nextcloudUsername: "romain",
      },
    ];
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const { app } = buildApp({ sendMail, rows });

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/doc.txt", shareType: 0, shareWith: "romain" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    // The exact "romain" row is notified — NOT the differently-cased "Romain".
    expect(sendMail.mock.calls[0][0].to).toBe("romain@example.com");
  });

  it("no-ops (share still 200, no dial) when the SMTP channel is not configured", async () => {
    const sendMail = vi.fn();
    const { app } = buildApp({ sendMail, channel: null });

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/doc.txt", shareType: 0, shareWith: "romain" });

    expect(res.status).toBe(200);
    await flushAsync();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("no-ops when the channel exists but is disabled (isChannelReady contract)", async () => {
    const sendMail = vi.fn();
    const { app } = buildApp({
      sendMail,
      channel: { ...readyChannel(), enabled: false },
    });

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/doc.txt", shareType: 0, shareWith: "romain" });

    expect(res.status).toBe(200);
    await flushAsync();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("share still 200s when the transport throws (mail failure never fails the share)", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:587"));
    const { app } = buildApp({ sendMail });

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/doc.txt", shareType: 0, shareWith: "romain" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(77);
    // The failure path actually executed — and was swallowed.
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
  });

  it("sends nothing for link shares (shareType 3) — not even a directory lookup", async () => {
    const sendMail = vi.fn();
    const { app, findMany } = buildApp({ sendMail });
    ncCreateShareV2Mock.mockResolvedValue({
      ...CREATED_PERSON_SHARE,
      id: 78,
      shareType: 3,
      shareWith: null,
      url: "http://nextcloud.test/s/abc",
      token: "abc",
    } as never);

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/doc.txt", shareType: 3 });

    expect(res.status).toBe(200);
    await flushAsync();
    expect(sendMail).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("no-ops when the recipient has no email on file (share still 200)", async () => {
    const sendMail = vi.fn();
    const { app } = buildApp({ sendMail, rows: roster({ romainEmail: null }) });

    const res = await request(app)
      .post("/api/files/share")
      .send({ path: "/doc.txt", shareType: 0, shareWith: "romain" });

    expect(res.status).toBe(200);
    await flushAsync();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
