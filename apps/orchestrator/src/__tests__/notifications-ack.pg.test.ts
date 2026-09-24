/**
 * WARP-2804 — notification acknowledgement against REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   CHECK      `NotificationLog_ack_shape` lives in raw migration SQL (Prisma's
 *              schema language cannot express it) and the drift gate cannot
 *              see it. Only Postgres proves it refuses an acked row without a
 *              time, and a sign-in recorded on a row nobody acked.
 *   backfill   Which value the rows written BEFORE the migration get
 *              (`untracked`) versus every new row (`unacked`) is the whole
 *              point of D2, and it is a property of ADD COLUMN … DEFAULT then
 *              SET DEFAULT — a fake cannot show it. The migration file itself
 *              is run here, twice, against a pre-WARP-2804 table.
 *   first ack  "First ack wins" rests on the row lock: two concurrent acks of
 *              one row must answer exactly one `changed: true`, and the stored
 *              sign-in must be the winner's.
 *   ack-all    A row created after `before` is never swept, even while the
 *              sweep runs.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job in
 * .github/workflows/orchestrator-tests.yml. Needs only the NotificationLog
 * table (no pgvector), so it also runs against a bare Postgres that holds the
 * migrated NotificationLog shape.
 *
 * FIXTURE SCOPING — this DB is shared by the pg suites running in series.
 * Every row this file writes is namespaced `warp2804-` and every cleanup is
 * scoped to that prefix. The backfill case runs inside ONE transaction on a
 * scratch schema and rolls the whole thing back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { MIGRATIONS_DIR } from "./helpers/test-paths.js";

vi.unmock("@prisma/client");
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

import {
  ackNotification,
  ackAllNotifications,
  countUnread,
  recordNotification,
} from "../services/notifications.service.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const PREFIX = "warp2804-";
const MIGRATION_SQL = readFileSync(
  join(MIGRATIONS_DIR, "20260924040000_warp_2804_notification_ack", "migration.sql"),
  "utf8",
);

/** The migration's statements, split at top-level `;` (a `DO $$ … $$` body keeps its own). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (const line of sql.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().startsWith("--") && !inDollar) continue;
    cur += line + "\n";
    inDollar = (line.match(/\$\$/g)?.length ?? 0) % 2 === 1 ? !inDollar : inDollar;
    if (!inDollar && line.trimEnd().endsWith(";")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Rollback extends Error {}

describe.skipIf(!RUN)("notification acknowledgement — real Postgres (WARP-2804)", () => {
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
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  const u = (name: string) => `${PREFIX}${name}`;

  describe("the CHECK NotificationLog_ack_shape", () => {
    async function insertRaw(cols: Record<string, unknown>): Promise<unknown> {
      const names = Object.keys(cols);
      const params = names.map((_, i) => {
        const v = cols[names[i]!];
        if (names[i] === "ackState") return `$${i + 1}::"NotificationAckState"`;
        if (names[i] === "ackMethod") return `$${i + 1}::"NotificationAckMethod"`;
        if (names[i] === "kind") return `$${i + 1}::"NotificationKind"`;
        if (v instanceof Date) return `$${i + 1}::timestamp(3)`;
        return `$${i + 1}`;
      });
      return prisma.$executeRawUnsafe(
        `INSERT INTO "NotificationLog" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${params.join(", ")})`,
        ...names.map((n) => cols[n]),
      );
    }
    const base = (id: string) => ({ id: `${PREFIX}${id}`, username: u("stefan"), kind: "system", title: "t", channels: "" });

    it("a legal acked row and a legal unacked row insert", async () => {
      await expect(insertRaw({ ...base("ok1") })).resolves.toBe(1);
      await expect(
        insertRaw({ ...base("ok2"), ackState: "acked", ackedAt: new Date(), ackMethod: "inbox", ackSessionId: "sid", ackClient: "c" }),
      ).resolves.toBe(1);
    });

    it.each([
      ["acked without a time", { ackState: "acked", ackMethod: "inbox" }],
      ["acked without a method", { ackState: "acked", ackedAt: new Date() }],
      ["a time on an unacked row", { ackState: "unacked", ackedAt: new Date(), ackMethod: "inbox" }],
      ["a sign-in on an unacked row", { ackState: "unacked", ackSessionId: "sid-x" }],
      ["a client on an untracked row", { ackState: "untracked", ackClient: "Safari on iPhone" }],
    ])("refuses %s", async (_label, cols) => {
      await expect(insertRaw({ ...base("bad"), ...cols })).rejects.toThrow(/NotificationLog_ack_shape/);
    });

    // Review F3 — "the session store confirmed that sign-in was live" only on
    // an acked row that names a sign-in.
    it.each([
      ["a confirmed sign-in on an unacked row", { ackState: "unacked", ackSessionChecked: true }],
      [
        "a confirmed sign-in on an acked row that names no sign-in",
        { ackState: "acked", ackedAt: new Date(), ackMethod: "inbox", ackSessionChecked: true },
      ],
    ])("refuses %s", async (_label, cols) => {
      await expect(insertRaw({ ...base("bad"), ...cols })).rejects.toThrow(/NotificationLog_ack_session_checked/);
    });

    it("a confirmed sign-in on an acked row with a sid inserts; an unconfirmed one too", async () => {
      const acked = { ackState: "acked", ackedAt: new Date(), ackMethod: "inbox", ackSessionId: "sid-1" };
      await expect(insertRaw({ ...base("chk1"), ...acked, ackSessionChecked: true })).resolves.toBe(1);
      await expect(insertRaw({ ...base("chk2"), ...acked, ackSessionChecked: false })).resolves.toBe(1);
    });

    it("a raw INSERT that names no ackState lands `unacked` (the default after the migration)", async () => {
      await insertRaw({ ...base("default") });
      const row = await prisma.notificationLog.findUnique({ where: { id: `${PREFIX}default` } });
      expect(row?.ackState).toBe("unacked");
    });
  });

  it("MUTATION: the migration backfills rows written before it as `untracked`; new rows are `unacked`; a second run changes nothing", async () => {
    const outcome = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA warp2804_backfill`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO warp2804_backfill`);
        // The NotificationLog columns the migration touches, as they stand
        // before it (WARP-2911's shape).
        await tx.$executeRawUnsafe(
          `CREATE TABLE "NotificationLog" ("id" TEXT PRIMARY KEY, "username" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        );
        await tx.$executeRawUnsafe(`INSERT INTO "NotificationLog" ("id", "username") VALUES ('before-1', 'stefan'), ('before-2', 'maria')`);
        for (const pass of [1, 2]) {
          for (const stmt of statements(MIGRATION_SQL)) await tx.$executeRawUnsafe(stmt);
          if (pass === 1) {
            await tx.$executeRawUnsafe(`INSERT INTO "NotificationLog" ("id", "username") VALUES ('after-1', 'stefan')`);
          }
        }
        const rows = await tx.$queryRawUnsafe<Array<{ id: string; ackState: string }>>(
          `SELECT "id", "ackState"::text AS "ackState" FROM "NotificationLog" ORDER BY "id"`,
        );
        const checks = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM pg_constraint WHERE conname = 'NotificationLog_ack_shape' AND conrelid = '"NotificationLog"'::regclass`,
        );
        const indexes = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'warp2804_backfill' AND indexname = 'NotificationLog_username_ackState_createdAt_idx'`,
        );
        throw new Rollback(JSON.stringify({ rows, checks: Number(checks[0]!.n), indexes: Number(indexes[0]!.n) }));
      })
      .catch((err: unknown) => {
        if (err instanceof Rollback) return JSON.parse(err.message);
        throw err;
      });
    expect(outcome.rows).toEqual([
      { id: "after-1", ackState: "unacked" },
      { id: "before-1", ackState: "untracked" },
      { id: "before-2", ackState: "untracked" },
    ]);
    expect(outcome.checks).toBe(1);
    expect(outcome.indexes).toBe(1);
    // Rolled back: the scratch schema never existed outside the transaction.
    const left = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = 'warp2804_backfill'`,
    );
    expect(Number(left[0]!.n)).toBe(0);
  });

  it("two concurrent acks of one row → exactly one changed:true, and the stored sign-in is the winner's", async () => {
    for (let round = 0; round < 5; round++) {
      await cleanup();
      const { id } = await recordNotification(prisma, { username: u("stefan"), kind: "system", title: `race ${round}` });
      const [a, b] = await Promise.all([
        ackNotification(prisma, { id, username: u("stefan"), method: "inbox", sessionId: "sid-a", client: "a", sessionChecked: true }),
        ackNotification(prisma, { id, username: u("stefan"), method: "opened", sessionId: "sid-b", client: "b", sessionChecked: false }),
      ]);
      expect([a!.changed, b!.changed].filter(Boolean)).toHaveLength(1);
      const winner = a!.changed
        ? { method: "inbox", sid: "sid-a", checked: true }
        : { method: "opened", sid: "sid-b", checked: false };
      const stored = await prisma.notificationLog.findUnique({ where: { id } });
      expect(stored).toMatchObject({
        ackState: "acked",
        ackMethod: winner.method,
        ackSessionId: winner.sid,
        ackSessionChecked: winner.checked,
      });
      // Both answered with the same, stored ack.
      expect(a!.row.ackedAt).toEqual(stored!.ackedAt);
      expect(b!.row.ackedAt).toEqual(stored!.ackedAt);
    }
  });

  it("another person's id acks nothing in the database", async () => {
    const { id } = await recordNotification(prisma, { username: u("maria"), kind: "system", title: "hers" });
    expect(
      await ackNotification(prisma, { id, username: u("stefan"), method: "inbox", sessionId: "s", client: null, sessionChecked: true }),
    ).toBeNull();
    expect(await prisma.notificationLog.findUnique({ where: { id } })).toMatchObject({ ackState: "unacked", ackSessionId: null });
  });

  it("MUTATION: ack-all never sweeps a row newer than `before` — one that arrived while the person looked, or one racing the sweep", async () => {
    const t0 = new Date(Date.now() - 60_000);
    const before = new Date(t0.getTime() + 10_000);
    await prisma.notificationLog.createMany({
      data: [
        ...[0, 1, 2].map((i) => ({
          id: `${PREFIX}old-${i}`,
          username: u("stefan"),
          kind: "system" as const,
          title: `old ${i}`,
          channels: "",
          createdAt: new Date(t0.getTime() + i * 1000),
        })),
        // Arrived after the list was drawn and before "mark all read" was
        // clicked: already committed when the sweep runs (D5).
        {
          id: `${PREFIX}arrived`,
          username: u("stefan"),
          kind: "system" as const,
          title: "arrived while looking",
          channels: "",
          createdAt: new Date(before.getTime() + 5_000),
        },
      ],
    });
    const [out] = await Promise.all([
      ackAllNotifications(prisma, { username: u("stefan"), before, sessionId: "sid-1", client: null, sessionChecked: false }),
      prisma.notificationLog.create({
        data: { id: `${PREFIX}new`, username: u("stefan"), kind: "system", title: "new", channels: "", createdAt: new Date(before.getTime() + 1) },
      }),
    ]);
    expect(out.acked).toBe(3);
    for (const id of [`${PREFIX}arrived`, `${PREFIX}new`]) {
      expect((await prisma.notificationLog.findUnique({ where: { id } }))?.ackState, id).toBe("unacked");
    }
    expect(await countUnread(prisma, u("stefan"))).toBe(2);
  });
});
