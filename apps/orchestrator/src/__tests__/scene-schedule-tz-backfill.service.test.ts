/**
 * KAN-6 — legacy SceneSchedule timezone backfill.
 *
 * Pre-KAN-6 rows stored the schedule hour as a UTC value in the RRULE BYHOUR
 * (a UTC-7 owner who picked 07:00 has BYHOUR=14). The timezone-column
 * migration back-fills timezone='UTC' but leaves BYHOUR alone, so the new
 * describeRrule (which reads BYHOUR as wall-clock in the row's zone) DISPLAYS
 * the wrong hour for non-UTC homes (14:00 instead of 07:00).
 *
 * This one-shot, idempotent backfill converts every legacy (timezone='UTC')
 * row to the box's local IANA zone such that:
 *   (a) the FIRING INSTANT is unchanged (same nextFireAt), and
 *   (b) the DISPLAYED local hour is correct again (BYHOUR rewritten to the
 *       box-zone wall-clock hour).
 *
 * It records completion in SystemFlag so it never re-runs — new rows created
 * later carry their real zone from the UI and must NOT be touched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("@prisma/client");

import {
  backfillLegacySceneScheduleTimezones,
  SCENE_TZ_BACKFILL_FLAG_KEY,
} from "../services/scene-schedule-tz-backfill.service.js";
import { nextFireFromRrule } from "../utils/rrule.js";

interface FakeRow {
  id: string;
  rrule: string;
  timezone: string;
  nextFireAt: Date;
}

/**
 * Minimal in-memory prisma stand-in for the two models the backfill touches:
 * SceneSchedule (findMany WHERE timezone='UTC' + update) and SystemFlag
 * (findUnique by key + create). `$transaction(fn)` runs the callback against
 * the same store so the row-updates + marker-write are observed as one unit.
 */
function createPrismaMock(opts: { rows?: FakeRow[]; flagSet?: boolean } = {}) {
  const rows = new Map<string, FakeRow>();
  for (const r of opts.rows ?? []) rows.set(r.id, { ...r });
  const flags = new Map<string, { key: string; valueJson: unknown }>();
  if (opts.flagSet) {
    flags.set(SCENE_TZ_BACKFILL_FLAG_KEY, {
      key: SCENE_TZ_BACKFILL_FLAG_KEY,
      valueJson: {},
    });
  }

  const client = {
    sceneSchedule: {
      findMany: vi.fn(async ({ where }: { where?: { timezone?: string } } = {}) => {
        const all = [...rows.values()];
        if (where?.timezone) return all.filter((r) => r.timezone === where.timezone);
        return all;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeRow>;
        }) => {
          const existing = rows.get(where.id);
          if (!existing) throw new Error(`no row ${where.id}`);
          const updated = { ...existing, ...data };
          rows.set(where.id, updated);
          return updated;
        },
      ),
    },
    systemFlag: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        return flags.get(where.key) ?? null;
      }),
      create: vi.fn(
        async ({ data }: { data: { key: string; valueJson?: unknown } }) => {
          if (flags.has(data.key)) {
            const err = new Error("Unique constraint failed");
            (err as { code?: string }).code = "P2002";
            throw err;
          }
          const row = { key: data.key, valueJson: data.valueJson ?? {} };
          flags.set(data.key, row);
          return row;
        },
      ),
    },
    // Assigned after the object literal so the callback's reference to `client`
    // isn't inside `client`'s own initializer (avoids TS's implicit-any cycle).
    $transaction: vi.fn() as ReturnType<typeof vi.fn>,
  };
  client.$transaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(client),
  );
  return { client, rows, flags };
}

describe("KAN-6 — backfillLegacySceneScheduleTimezones", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts a legacy UTC-hour daily row to the box zone, preserving the firing instant", async () => {
    // Legacy: a UTC-7 (PDT) owner picked 07:00, persisted as BYHOUR=14 UTC,
    // nextFireAt = 14:00 UTC. Box zone = America/Los_Angeles.
    const original: FakeRow = {
      id: "s1",
      rrule: "FREQ=DAILY;BYHOUR=14;BYMINUTE=0",
      timezone: "UTC",
      nextFireAt: new Date("2026-07-02T14:00:00.000Z"),
    };
    const { client, rows } = createPrismaMock({ rows: [original] });

    const result = await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: "America/Los_Angeles",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(result.converted).toBe(1);
    const after = rows.get("s1")!;
    // Invariant (a): the firing instant is unchanged.
    expect(after.nextFireAt.toISOString()).toBe("2026-07-02T14:00:00.000Z");
    // The row now carries the box zone.
    expect(after.timezone).toBe("America/Los_Angeles");
    // Invariant (b): BYHOUR rewritten to the local wall-clock hour (07), so
    // describeRrule (which reads BYHOUR as wall-clock in the row's zone) shows
    // the right local time again — and recomputing from the new rule lands on
    // the SAME UTC instant.
    expect(after.rrule).toContain("BYHOUR=7");
    const recomputed = nextFireFromRrule(
      after.rrule,
      new Date("2026-07-02T13:59:00.000Z"),
      after.timezone,
    );
    expect(recomputed?.toISOString()).toBe("2026-07-02T14:00:00.000Z");
  });

  it("the DISPLAYED hour after conversion is the local hour, not the UTC hour", async () => {
    const original: FakeRow = {
      id: "s1",
      rrule: "FREQ=DAILY;BYHOUR=14;BYMINUTE=30",
      timezone: "UTC",
      nextFireAt: new Date("2026-07-02T14:30:00.000Z"),
    };
    const { client, rows } = createPrismaMock({ rows: [original] });
    await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: "America/Los_Angeles",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    const after = rows.get("s1")!;
    // 14:30 UTC = 07:30 PDT → BYHOUR=7, BYMINUTE preserved.
    expect(after.rrule).toContain("BYHOUR=7");
    expect(after.rrule).toContain("BYMINUTE=30");
    expect(after.rrule).not.toContain("BYHOUR=14");
  });

  it("records completion in SystemFlag so it never re-runs", async () => {
    const { client, flags } = createPrismaMock({
      rows: [
        {
          id: "s1",
          rrule: "FREQ=DAILY;BYHOUR=14",
          timezone: "UTC",
          nextFireAt: new Date("2026-07-02T14:00:00.000Z"),
        },
      ],
    });
    const r1 = await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: "America/Los_Angeles",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(r1.ran).toBe(true);
    expect(flags.has(SCENE_TZ_BACKFILL_FLAG_KEY)).toBe(true);
  });

  it("short-circuits (no row touched) when the completion flag is already set", async () => {
    const { client } = createPrismaMock({
      flagSet: true,
      rows: [
        {
          id: "s1",
          rrule: "FREQ=DAILY;BYHOUR=14",
          timezone: "UTC",
          nextFireAt: new Date("2026-07-02T14:00:00.000Z"),
        },
      ],
    });
    const result = await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: "America/Los_Angeles",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(result.ran).toBe(false);
    expect(result.converted).toBe(0);
    expect(client.sceneSchedule.update).not.toHaveBeenCalled();
  });

  it("leaves rows as UTC (no conversion) when the box zone is unresolvable, but still marks complete so it never retries", async () => {
    const { client, rows, flags } = createPrismaMock({
      rows: [
        {
          id: "s1",
          rrule: "FREQ=DAILY;BYHOUR=14",
          timezone: "UTC",
          nextFireAt: new Date("2026-07-02T14:00:00.000Z"),
        },
      ],
    });
    const result = await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: null, // nothing resolvable
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(result.converted).toBe(0);
    expect(rows.get("s1")!.timezone).toBe("UTC");
    expect(rows.get("s1")!.rrule).toBe("FREQ=DAILY;BYHOUR=14");
    // Still recorded so we don't re-scan every boot.
    expect(flags.has(SCENE_TZ_BACKFILL_FLAG_KEY)).toBe(true);
  });

  it("treats a box zone of UTC as a no-op conversion (rows already correct)", async () => {
    const { client, rows } = createPrismaMock({
      rows: [
        {
          id: "s1",
          rrule: "FREQ=DAILY;BYHOUR=14",
          timezone: "UTC",
          nextFireAt: new Date("2026-07-02T14:00:00.000Z"),
        },
      ],
    });
    const result = await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: "UTC",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(result.converted).toBe(0);
    expect(rows.get("s1")!.timezone).toBe("UTC");
    expect(rows.get("s1")!.rrule).toBe("FREQ=DAILY;BYHOUR=14");
  });

  it("never touches non-UTC rows (a real zone authored after the migration)", async () => {
    const { client, rows } = createPrismaMock({
      rows: [
        {
          id: "legacy",
          rrule: "FREQ=DAILY;BYHOUR=14",
          timezone: "UTC",
          nextFireAt: new Date("2026-07-02T14:00:00.000Z"),
        },
        {
          id: "new",
          rrule: "FREQ=DAILY;BYHOUR=7",
          timezone: "America/New_York",
          nextFireAt: new Date("2026-07-02T11:00:00.000Z"),
        },
      ],
    });
    const result = await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: "America/Los_Angeles",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(result.converted).toBe(1);
    // The pre-existing real-zone row is untouched.
    const newRow = rows.get("new")!;
    expect(newRow.timezone).toBe("America/New_York");
    expect(newRow.rrule).toBe("FREQ=DAILY;BYHOUR=7");
  });

  it("preserves the firing instant for a WEEKLY legacy row too", async () => {
    // A Friday 22:00 UTC weekly rule. In LA that fire is Friday 15:00 PDT.
    const original: FakeRow = {
      id: "w1",
      rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=22;BYMINUTE=0",
      timezone: "UTC",
      nextFireAt: new Date("2026-07-03T22:00:00.000Z"), // 2026-07-03 is a Friday
    };
    const { client, rows } = createPrismaMock({ rows: [original] });
    await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: "America/Los_Angeles",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    const after = rows.get("w1")!;
    expect(after.timezone).toBe("America/Los_Angeles");
    expect(after.rrule).toContain("BYHOUR=15");
    // BYDAY must survive untouched — the fire is still "Friday local".
    expect(after.rrule).toContain("BYDAY=FR");
    expect(after.nextFireAt.toISOString()).toBe("2026-07-03T22:00:00.000Z");
    const recomputed = nextFireFromRrule(
      after.rrule,
      new Date("2026-07-03T21:59:00.000Z"),
      after.timezone,
    );
    expect(recomputed?.toISOString()).toBe("2026-07-03T22:00:00.000Z");
  });

  it("does not crash on a malformed legacy rrule — skips it, converts the rest", async () => {
    const { client, rows } = createPrismaMock({
      rows: [
        {
          id: "bad",
          rrule: "FREQ=YEARLY;GARBAGE",
          timezone: "UTC",
          nextFireAt: new Date("2026-07-02T14:00:00.000Z"),
        },
        {
          id: "good",
          rrule: "FREQ=DAILY;BYHOUR=14",
          timezone: "UTC",
          nextFireAt: new Date("2026-07-02T14:00:00.000Z"),
        },
      ],
    });
    const result = await backfillLegacySceneScheduleTimezones(client as never, {
      boxTimezone: "America/Los_Angeles",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(1);
    // The malformed row is left exactly as-is (still UTC), not corrupted.
    expect(rows.get("bad")!.timezone).toBe("UTC");
    expect(rows.get("bad")!.rrule).toBe("FREQ=YEARLY;GARBAGE");
    expect(rows.get("good")!.timezone).toBe("America/Los_Angeles");
  });
});
