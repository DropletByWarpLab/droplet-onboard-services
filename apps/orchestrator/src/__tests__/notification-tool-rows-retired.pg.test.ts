/**
 * WARP-3060 — retiring the rows `send_notification` wrote and nothing ever
 * delivered, against REAL Postgres.
 *
 * The migration is a WHERE clause over a shared table on every shipped box: a
 * mocked client cannot show which rows it touches. Here the migration's own SQL
 * (read from its folder, not restated) runs over one row of each shape a box
 * holds — the tool's phantom in each ack state, a delivered `ai` row, a failed
 * `ai` row, an `ai` row whose delivery was claimed, a queued non-`ai` row —
 * and only the phantoms may change. It then runs again and must change nothing.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 * Every row is namespaced `warp3060-` and every cleanup is scoped to it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { MIGRATIONS_DIR } from "./helpers/test-paths.js";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const MIGRATION = "20260925020000_warp_3060_retire_undelivered_tool_notifications";
const SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION, "migration.sql"), "utf8");
const PREFIX = "warp3060-";
const RETIRED = "delivery: never_sent (WARP-3060)";

describe.skipIf(!RUN)("WARP-3060 retiring send_notification's undelivered rows — real Postgres", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  const cleanup = () => prisma.notificationLog.deleteMany({ where: { username: { startsWith: PREFIX } } });
  beforeEach(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  const username = `${PREFIX}alice`;
  const ours = async () =>
    new Map(
      (await prisma.notificationLog.findMany({ where: { username: { startsWith: PREFIX } } })).map((r) => [r.id, r]),
    );

  it("retires every phantom, leaves every other shape untouched, and a second run changes nothing", async () => {
    // The tool's row, exactly as the pre-WARP-3060 handler wrote it, in the
    // three ack states a box can hold it in.
    const phantom = await prisma.notificationLog.create({ data: { username, kind: "ai", title: "Pop!", channels: "" } });
    const legacy = await prisma.notificationLog.create({
      data: { username, kind: "ai", title: "Before 2804", channels: "", ackState: "untracked" },
    });
    const seen = await prisma.notificationLog.create({
      data: { username, kind: "ai", title: "Seen", channels: "", ackState: "acked", ackedAt: new Date(), ackMethod: "inbox" },
    });
    // Everything else: a channel carried it, an error says why not, a delivery
    // claim is in flight, or it is not the tool's kind at all.
    const untouched = await Promise.all([
      prisma.notificationLog.create({
        data: { username, kind: "ai", title: "Run finished", channels: "toast", deliveredAt: new Date(), pushOutcome: "no_subscribers" },
      }),
      prisma.notificationLog.create({
        data: { username, kind: "ai", title: "Digest", channels: "", error: "toast: mqtt_unavailable", pushOutcome: "no_subscribers" },
      }),
      prisma.notificationLog.create({
        data: { username, kind: "ai", title: "Claimed", channels: "", error: "delivery: outcome_unknown" },
      }),
      prisma.notificationLog.create({ data: { username, kind: "system", title: "Assigned to you", channels: "" } }),
    ]);
    expect(phantom.ackState).toBe("unacked");
    const before = await ours();

    await prisma.$executeRawUnsafe(SQL);

    const after = await ours();
    expect(after.get(phantom.id)).toEqual({ ...before.get(phantom.id), error: RETIRED, ackState: "untracked" });
    expect(after.get(legacy.id)).toEqual({ ...before.get(legacy.id), error: RETIRED });
    expect(after.get(seen.id)).toEqual({ ...before.get(seen.id), error: RETIRED });
    for (const row of untouched) expect(after.get(row.id), row.title).toEqual(before.get(row.id));

    await prisma.$executeRawUnsafe(SQL);
    expect(await ours()).toEqual(after);
  });
});
