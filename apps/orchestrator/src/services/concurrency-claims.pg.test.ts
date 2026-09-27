/**
 * WARP-3193 — the two database-held claims, raced on real Postgres.
 *
 *   PERF-3: the DeviceUpdate apply claim. Of N runners racing
 *     claimDeviceUpdateForApply on one row, exactly one wins.
 *   PERF-9: the ChatMessage (sessionId, turnId, role) partial unique index.
 *     N concurrent createTurnRows for one turn leave exactly one user and one
 *     assistant row, every caller gets the same ids, and all but the creator
 *     are told the turn is in flight.
 *
 * Self-gated on RUN_PG_INTEGRATION like every *.pg.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { claimDeviceUpdateForApply } from "./update-agent/apply.js";
import { ChatPersistenceService } from "./chat-persistence.service.js";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("WARP-3193 concurrency claims (real Postgres)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<
      typeof import("@prisma/client")
    >("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "DeviceUpdate" WHERE "gitSha" = \'warp3193\'');
    await prisma.$executeRawUnsafe('DELETE FROM "ChatSession" WHERE "id" = \'warp3193-s\'');
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = \'warp3193-u\'');
  });

  it("PERF-3: exactly one of eight racing runners claims the update", async () => {
    const row = await prisma.deviceUpdate.create({
      data: {
        status: "verifying",
        gitSha: "warp3193",
        builtAt: new Date(),
        manifestSha256: "0".repeat(64),
        manifestJson: {},
      },
    });

    const wins = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimDeviceUpdateForApply(prisma, row.id, `run-${i}`)),
    );

    expect(wins.filter(Boolean)).toHaveLength(1);
    const after = await prisma.deviceUpdate.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.applyClaim).toBe("claimed");
    expect(after.applyClaimId).toBe(`run-${wins.indexOf(true)}`);
  });

  it("PERF-9: eight concurrent submits of one turn create it once and start one loop", async () => {
    await prisma.user.create({
      data: { id: "warp3193-u", username: "warp3193-u", displayName: "w", passwordHash: "x", role: "owner" },
    });
    await prisma.chatSession.create({ data: { id: "warp3193-s", userId: "warp3193-u" } });
    const svc = new ChatPersistenceService(prisma);

    const turns = await Promise.all(
      Array.from({ length: 8 }, () =>
        svc.createTurnRows({ conversationId: "warp3193-s", userContent: "hi", turnId: "turn-x" }),
      ),
    );

    const rows = await prisma.chatMessage.findMany({ where: { sessionId: "warp3193-s" } });
    expect(rows.map((r) => r.role).sort()).toEqual(["assistant", "user"]);
    expect(new Set(turns.map((t) => t.assistantMessageId)).size).toBe(1);
    expect(new Set(turns.map((t) => t.userMessageId)).size).toBe(1);
    // Exactly one caller created the turn; every other one must not run a loop.
    expect(turns.filter((t) => !t.assistantInFlight)).toHaveLength(1);
  });
});
