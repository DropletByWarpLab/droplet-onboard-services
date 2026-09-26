/**
 * resolveNcToken — the Nextcloud credential used for OCS/WebDAV calls made on
 * behalf of the signed-in user.
 *
 * Only a password login (and invite-accept) stores the per-user Nextcloud
 * token in Redis. A person who signs in with a passkey (Windows Hello) or SSO
 * therefore had NO Nextcloud credential once their last password session was
 * gone: /api/files/* and pairing answered 401. W2: when the per-user slot is
 * empty, fall back to the decrypted app password of the caller's newest ACTIVE
 * paired device. That credential already belongs to the same person; revoked
 * devices are never used. `DeviceClient.userId` holds the USERNAME (the
 * pairing route keys it that way), so the lookup is by `req.user.username`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request } from "express";

vi.mock("../config.js", () => ({
  config: { JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa" },
}));

const redisGet = vi.fn();
vi.mock("./cache.service.js", () => ({
  getRedis: () => ({ get: (...a: unknown[]) => redisGet(...a) }),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheSetNx: vi.fn(),
  cacheDel: vi.fn(),
  cacheSetAdd: vi.fn(),
  cacheSetRemove: vi.fn(),
  cacheSetMembers: vi.fn(),
}));

const decryptSecret = vi.fn((ciphertext: string) => `plain(${ciphertext})`);
vi.mock("./encryption.service.js", () => ({
  decryptSecret: (c: string) => decryptSecret(c),
}));

vi.mock("../middleware/auth.js", () => ({ SESSION_COOKIE_NAME: "droplet_session" }));

import { resolveNcToken, bindNcTokenFallbackPrisma } from "./nextcloud-session.service.js";
import { signAccessToken } from "./jwt.service.js";

interface DeviceRow {
  id: string;
  userId: string;
  ncAppPassword: string;
  status: "active" | "revoked";
  createdAt: Date;
}

function devicePrisma(rows: DeviceRow[]) {
  return {
    deviceClient: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const hits = rows
          .filter((r) => r.userId === where.userId && r.status === where.status)
          .sort((a, b) =>
            orderBy?.createdAt === "desc"
              ? b.createdAt.getTime() - a.createdAt.getTime()
              : a.createdAt.getTime() - b.createdAt.getTime(),
          );
        return hits[0] ?? null;
      }),
    },
  };
}

const USER = { id: "u-uuid-stefan-7777", username: "stefan" };

function jwtRequest(): Request {
  const token = signAccessToken({
    id: USER.id,
    username: USER.username,
    displayName: "Stefan",
    role: "owner",
  });
  return {
    cookies: {},
    headers: { authorization: `Bearer ${token}` },
    user: { ...USER },
  } as unknown as Request;
}

const t0 = new Date("2026-09-01T00:00:00Z");
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  redisGet.mockResolvedValue(null);
});

afterEach(() => {
  bindNcTokenFallbackPrisma(null);
});

describe("resolveNcToken — per-user Redis slot", () => {
  it("returns the stored per-user token and never touches the device table", async () => {
    redisGet.mockResolvedValue("nc-session-token");
    const prisma = devicePrisma([
      { id: "d1", userId: "stefan", ncAppPassword: "enc-1", status: "active", createdAt: t0 },
    ]);
    bindNcTokenFallbackPrisma(prisma);

    expect(await resolveNcToken(jwtRequest())).toBe("nc-session-token");
    expect(redisGet).toHaveBeenCalledWith(`auth:nc-token:${USER.id}`);
    expect(prisma.deviceClient.findFirst).not.toHaveBeenCalled();
  });

  it("passes a legacy (non-JWT) session token through unchanged", async () => {
    const req = {
      cookies: { droplet_session: "legacy-nextcloud-token" },
      headers: {},
      user: { ...USER },
    } as unknown as Request;
    expect(await resolveNcToken(req)).toBe("legacy-nextcloud-token");
  });
});

describe("resolveNcToken — paired-device fallback (W2)", () => {
  it("uses the newest ACTIVE device's decrypted app password when the slot is empty", async () => {
    const prisma = devicePrisma([
      { id: "d-old", userId: "stefan", ncAppPassword: "enc-old", status: "active", createdAt: minutes(1) },
      { id: "d-new", userId: "stefan", ncAppPassword: "enc-new", status: "active", createdAt: minutes(5) },
    ]);
    bindNcTokenFallbackPrisma(prisma);

    expect(await resolveNcToken(jwtRequest())).toBe("plain(enc-new)");
    // Keyed by USERNAME (DeviceClient.userId), active only, newest first.
    expect(prisma.deviceClient.findFirst).toHaveBeenCalledWith({
      where: { userId: "stefan", status: "active" },
      orderBy: { createdAt: "desc" },
      select: { ncAppPassword: true },
    });
  });

  it("skips a revoked device even when it is the newest", async () => {
    bindNcTokenFallbackPrisma(
      devicePrisma([
        { id: "d-act", userId: "stefan", ncAppPassword: "enc-act", status: "active", createdAt: minutes(1) },
        { id: "d-rev", userId: "stefan", ncAppPassword: "enc-rev", status: "revoked", createdAt: minutes(9) },
      ]),
    );
    expect(await resolveNcToken(jwtRequest())).toBe("plain(enc-act)");
  });

  it("returns null when every paired device is revoked", async () => {
    bindNcTokenFallbackPrisma(
      devicePrisma([
        { id: "d-rev", userId: "stefan", ncAppPassword: "enc-rev", status: "revoked", createdAt: minutes(9) },
      ]),
    );
    expect(await resolveNcToken(jwtRequest())).toBeNull();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it("never uses another person's device", async () => {
    bindNcTokenFallbackPrisma(
      devicePrisma([
        { id: "d-a", userId: "alice", ncAppPassword: "enc-alice", status: "active", createdAt: minutes(9) },
      ]),
    );
    expect(await resolveNcToken(jwtRequest())).toBeNull();
  });

  it("falls back when the Redis read itself fails", async () => {
    redisGet.mockRejectedValue(new Error("ECONNREFUSED"));
    bindNcTokenFallbackPrisma(
      devicePrisma([
        { id: "d1", userId: "stefan", ncAppPassword: "enc-1", status: "active", createdAt: t0 },
      ]),
    );
    expect(await resolveNcToken(jwtRequest())).toBe("plain(enc-1)");
  });

  it("returns null (fail closed, as before) when the stored ciphertext cannot be decrypted", async () => {
    decryptSecret.mockImplementationOnce(() => {
      throw new Error("bad tag");
    });
    bindNcTokenFallbackPrisma(
      devicePrisma([
        { id: "d1", userId: "stefan", ncAppPassword: "enc-1", status: "active", createdAt: t0 },
      ]),
    );
    expect(await resolveNcToken(jwtRequest())).toBeNull();
  });

  it("returns null when the device lookup fails", async () => {
    bindNcTokenFallbackPrisma({
      deviceClient: { findFirst: vi.fn().mockRejectedValue(new Error("db down")) },
    });
    expect(await resolveNcToken(jwtRequest())).toBeNull();
  });

  it("returns null when no directory is bound (the pre-W2 answer)", async () => {
    bindNcTokenFallbackPrisma(null);
    expect(await resolveNcToken(jwtRequest())).toBeNull();
  });
});
