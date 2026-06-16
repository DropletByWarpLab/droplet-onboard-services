/**
 * PR #377 (WARP-___) — WebAuthn ceremony challenge store.
 *
 * The challenge store is the replay defence for both the registration and
 * authentication ceremonies. Requirements under test:
 *
 *   1. createChallenge mints a random base64url challenge, persists it with
 *      the ceremony `type`, an `expiresAt` derived from the TTL constant, and
 *      the (optional) `userId`, and returns the challenge string.
 *   2. consumeChallenge resolves a live challenge by value + type, DELETEs it
 *      (single-use), and returns its row.
 *   3. A second consume of the same challenge returns null (consume-by-delete
 *      means it's gone — no replay).
 *   4. An expired challenge is rejected (and cleaned up), returns null.
 *   5. A challenge minted for the REGISTRATION ceremony is NOT accepted by an
 *      AUTHENTICATION consume (the pools don't cross-contaminate).
 *   6. The minted challenge has enough entropy (>= 16 bytes -> >= 22 b64url
 *      chars) — a guessable challenge defeats the whole point.
 *
 * Strategy: an in-memory Prisma mock for the webAuthnChallenge delegate,
 * mirroring auth.directory-login.test.ts's createPrismaMock approach. No real
 * DB (this ticket is LOCAL-only), but the mock honours the unique-challenge
 * and delete semantics the real table enforces.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createChallenge,
  consumeChallenge,
  WEBAUTHN_CHALLENGE_TTL_MS,
} from "./webauthn-challenge.service.js";

interface ChallengeRow {
  id: string;
  challenge: string;
  type: "REGISTRATION" | "AUTHENTICATION";
  userId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

function createPrismaMock(seed: ChallengeRow[] = []) {
  const rows: ChallengeRow[] = [...seed];
  let seq = 0;
  const delegate = {
    create: vi.fn(async ({ data }: { data: Omit<ChallengeRow, "id" | "createdAt"> }) => {
      if (rows.some((r) => r.challenge === data.challenge)) {
        throw new Error("Unique constraint failed on challenge");
      }
      const row: ChallengeRow = {
        id: `c-${++seq}`,
        createdAt: new Date(),
        ...data,
      };
      rows.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: { where: { challenge: string } }) => {
      return rows.find((r) => r.challenge === where.challenge) ?? null;
    }),
    delete: vi.fn(async ({ where }: { where: { id?: string; challenge?: string } }) => {
      const idx = rows.findIndex(
        (r) => (where.id && r.id === where.id) || (where.challenge && r.challenge === where.challenge),
      );
      if (idx === -1) throw new Error("Record to delete does not exist");
      const [removed] = rows.splice(idx, 1);
      return removed;
    }),
    deleteMany: vi.fn(async ({ where }: { where?: { expiresAt?: { lt: Date } } }) => {
      const before = rows.length;
      if (where?.expiresAt?.lt) {
        const cutoff = where.expiresAt.lt;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.expiresAt < cutoff) rows.splice(i, 1);
        }
      }
      return { count: before - rows.length };
    }),
  };
  const prisma = { webAuthnChallenge: delegate } as unknown as PrismaClient;
  return { prisma, rows, delegate };
}

describe("WebAuthn challenge store — single-use, time-bound replay defence", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("createChallenge persists a row with type + userId + TTL-derived expiry and returns the challenge", async () => {
    const { prisma, rows, delegate } = createPrismaMock();
    const before = Date.now();

    const challenge = await createChallenge(prisma, {
      type: "REGISTRATION",
      userId: "u-1",
    });

    expect(typeof challenge).toBe("string");
    expect(delegate.create).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.challenge).toBe(challenge);
    expect(row.type).toBe("REGISTRATION");
    expect(row.userId).toBe("u-1");
    // Expiry is TTL ahead of now (allow scheduling slack).
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(WEBAUTHN_CHALLENGE_TTL_MS - 2000);
    expect(ttl).toBeLessThanOrEqual(WEBAUTHN_CHALLENGE_TTL_MS + 2000);
  });

  it("mints a high-entropy challenge (>= 22 base64url chars ~ 16 bytes)", async () => {
    const { prisma } = createPrismaMock();
    const challenge = await createChallenge(prisma, { type: "AUTHENTICATION", userId: null });
    expect(challenge.length).toBeGreaterThanOrEqual(22);
    // base64url alphabet only — no +, /, or = padding.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("consumeChallenge returns the row and DELETEs it (single-use)", async () => {
    const { prisma, rows, delegate } = createPrismaMock();
    const challenge = await createChallenge(prisma, { type: "AUTHENTICATION", userId: null });

    const consumed = await consumeChallenge(prisma, challenge, "AUTHENTICATION");

    expect(consumed).not.toBeNull();
    expect(consumed!.challenge).toBe(challenge);
    expect(delegate.delete).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
  });

  it("a replayed challenge (second consume) returns null", async () => {
    const { prisma } = createPrismaMock();
    const challenge = await createChallenge(prisma, { type: "REGISTRATION", userId: "u-1" });

    const first = await consumeChallenge(prisma, challenge, "REGISTRATION");
    const second = await consumeChallenge(prisma, challenge, "REGISTRATION");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("an expired challenge is rejected and cleaned up", async () => {
    const expired: ChallengeRow = {
      id: "c-old",
      challenge: "expired-challenge-aaaaaaaaaaaaaaaaaaaa",
      type: "AUTHENTICATION",
      userId: null,
      expiresAt: new Date(Date.now() - 1000), // already past
      createdAt: new Date(Date.now() - 60_000),
    };
    const { prisma, rows } = createPrismaMock([expired]);

    const consumed = await consumeChallenge(prisma, expired.challenge, "AUTHENTICATION");

    expect(consumed).toBeNull();
    // expired row must not survive a consume attempt
    expect(rows.find((r) => r.id === "c-old")).toBeUndefined();
  });

  it("does NOT accept a REGISTRATION challenge on an AUTHENTICATION consume", async () => {
    const { prisma, rows } = createPrismaMock();
    const challenge = await createChallenge(prisma, { type: "REGISTRATION", userId: "u-1" });

    const consumed = await consumeChallenge(prisma, challenge, "AUTHENTICATION");

    expect(consumed).toBeNull();
    // wrong-ceremony attempt must not delete the still-valid registration row
    expect(rows).toHaveLength(1);
  });
});
