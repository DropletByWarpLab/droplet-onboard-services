/**
 * WARP-2980 (ADR-059 P5 §6.5) — the full build and the area rebuild, mocked
 * lane: the order of the writes, the claim, the swap, the failure path.
 * What the statement itself produces — and that it equals the TypeScript
 * reference built on `zonesForEvent` — is security-baseline-build.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../__tests__/helpers/test-paths.js";
import {
  BASELINE_BUILDS_KEPT,
  BASELINE_BUILD_CLAIM_STALE_MS,
  BASELINE_BUILD_STATEMENT_TIMEOUT,
  BASELINE_BUILD_TX_TIMEOUT_MS,
  BASELINE_COVERAGE_KEEP_DAYS,
  rebuildAreas,
  runFullBuild,
} from "./security-baseline-build.js";
import { SECURITY_BASELINE_RULESET_VERSION } from "../lib/security-baseline-math.js";

const NOW = new Date("2026-09-23T04:20:00Z"); // 00:20 in New York
const TZ = "America/New_York";
const BUILD_ID = "6b1d3c4e-1111-4a2b-9c3d-000000000001";

interface Call {
  op: string;
  args: unknown;
}

function fake(opts: { claimFails?: unknown; buildFails?: unknown; inserted?: number; ready?: Record<string, unknown> | null } = {}) {
  const log: Call[] = [];
  const push = (op: string) => (args: unknown) => {
    log.push({ op, args });
  };
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      push("tx.$executeRawUnsafe")(sql);
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      push("tx.$queryRawUnsafe")(sql);
      return [{ locked: false }];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      push("tx.$executeRaw")({ sql: strings.join("?"), values });
      if (opts.buildFails) throw opts.buildFails;
      return opts.inserted ?? 192;
    }),
    securityBaselineBuild: {
      updateMany: vi.fn(async (a: unknown) => {
        push("tx.build.updateMany")(a);
        return { count: 1 };
      }),
      update: vi.fn(async (a: unknown) => {
        push("tx.build.update")(a);
        return {};
      }),
    },
    securityBaselineCell: {
      aggregate: vi.fn(async (a: unknown) => {
        push("tx.cell.aggregate")(a);
        return { _sum: { eventCount: 57 } };
      }),
      deleteMany: vi.fn(async (a: unknown) => {
        push("tx.cell.deleteMany")(a);
        return { count: 3 };
      }),
      count: vi.fn(async (a: unknown) => {
        push("tx.cell.count")(a);
        return 400;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>, o: unknown) => {
      push("$transaction")(o);
      return fn(tx);
    }),
    securityBaselineBuild: {
      updateMany: vi.fn(async (a: unknown) => {
        push("build.updateMany")(a);
        return { count: 1 };
      }),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        push("build.create")(a);
        if (opts.claimFails) throw opts.claimFails;
        return { id: BUILD_ID, ...a.data };
      }),
      findFirst: vi.fn(async (a: unknown) => {
        push("build.findFirst")(a);
        return opts.ready === undefined ? null : opts.ready;
      }),
      findMany: vi.fn(async (a: unknown) => {
        push("build.findMany")(a);
        return [{ id: "old-1" }, { id: "old-2" }];
      }),
      deleteMany: vi.fn(async (a: unknown) => {
        push("build.deleteMany")(a);
        return { count: 2 };
      }),
    },
    securityCoverageSpan: {
      deleteMany: vi.fn(async (a: unknown) => {
        push("span.deleteMany")(a);
        return { count: 0 };
      }),
    },
  };
  return { prisma: prisma as never, tx, raw: prisma, log, ops: () => log.map((c) => c.op) };
}

describe("runFullBuild — claim, one transaction, swap, prune", () => {
  it("sweeps stale claims, claims, builds under a 45 s statement timeout in a 55 s READ COMMITTED transaction, swaps, then prunes", async () => {
    const f = fake();
    const r = await runFullBuild(f.prisma, "nightly", TZ, NOW);
    expect(r).toEqual({ status: "built", buildId: BUILD_ID, cellCount: 192, eventCount: 57 });
    expect(f.ops()).toEqual([
      "build.updateMany", // stale claims → failed 'interrupted'
      "build.create", // the claim
      "$transaction",
      "tx.$executeRawUnsafe", // SET LOCAL statement_timeout
      "tx.$executeRaw", // the one INSERT … SELECT
      "tx.cell.aggregate",
      "tx.build.updateMany", // the old ready → superseded
      "tx.build.update", // this → ready
      "build.findMany", // prune: superseded / failed beyond the newest 14
      "build.deleteMany",
      "span.deleteMany", // coverage older than 35 days
    ]);
    expect(f.log[0]!.args).toEqual({
      where: { state: "building", startedAt: { lt: new Date(NOW.getTime() - BASELINE_BUILD_CLAIM_STALE_MS) } },
      data: { state: "failed", error: "interrupted", finishedAt: NOW },
    });
    expect(f.log[1]!.args).toEqual({
      data: {
        state: "building",
        trigger: "nightly",
        timezone: TZ,
        windowFrom: "2026-08-26",
        windowTo: "2026-09-22",
        rulesetVersion: SECURITY_BASELINE_RULESET_VERSION,
        startedAt: NOW,
      },
    });
    expect(f.log[2]!.args).toEqual({ isolationLevel: "ReadCommitted", timeout: BASELINE_BUILD_TX_TIMEOUT_MS });
    expect(f.log[3]!.args).toBe(`SET LOCAL statement_timeout = '${BASELINE_BUILD_STATEMENT_TIMEOUT}'`);
    expect(f.log[6]!.args).toEqual({ where: { state: "ready" }, data: { state: "superseded" } });
    expect(f.log[7]!.args).toEqual({
      where: { id: BUILD_ID },
      data: { state: "ready", finishedAt: NOW, cellCount: 192, eventCount: 57, cellsVersion: 1 },
    });
    expect(f.log[8]!.args).toMatchObject({
      where: { state: { in: ["superseded", "failed"] } },
      orderBy: { startedAt: "desc" },
      skip: BASELINE_BUILDS_KEPT,
    });
    expect(f.log[9]!.args).toEqual({ where: { id: { in: ["old-1", "old-2"] }, state: { in: ["superseded", "failed"] } } });
    expect(f.log[10]!.args).toEqual({
      where: { state: "closed", coveredUntil: { lt: new Date(NOW.getTime() - BASELINE_COVERAGE_KEEP_DAYS * 86_400_000) } },
    });
  });

  it("the statement gets the window's slots and bounds as UTC instants, every area, and the camera keys", async () => {
    const f = fake();
    await runFullBuild(f.prisma, "first", TZ, NOW);
    const call = f.log.find((c) => c.op === "tx.$executeRaw")!.args as { values: unknown[] };
    const [buildId, ymds, hours, dayTypes, starts, ends, windowStart, windowEnd, onlyZoneIds, includeCameraKeys, labels] = call.values as [
      string,
      string[],
      string[],
      string[],
      string[],
      string[],
      string,
      string,
      string[] | null,
      boolean,
      string[],
    ];
    expect(buildId).toBe(BUILD_ID);
    expect(ymds).toHaveLength(28 * 24);
    expect(new Set(ymds)).toEqual(new Set(Array.from({ length: 28 }, (_x, i) => ymds[i * 24])));
    expect(hours[0]).toBe("0");
    expect(dayTypes[0]).toBe("weekday"); // 2026-08-26 is a Wednesday
    // UTC wall time as `timestamp(3)` text — never a zone the session could reinterpret.
    expect(starts[0]).toBe("2026-08-26 04:00:00.000");
    expect(ends[0]).toBe("2026-08-26 05:00:00.000");
    expect(windowStart).toBe("2026-08-26 04:00:00.000");
    expect(windowEnd).toBe("2026-09-23 04:00:00.000");
    expect(onlyZoneIds).toBeNull();
    expect(includeCameraKeys).toBe(true);
    expect(labels).toEqual(["person", "car", "dog", "cat"]);
  });

  it("a claim someone else holds (the `building` partial unique index) → skip, nothing else runs", async () => {
    const f = fake({ claimFails: Object.assign(new Error("unique"), { code: "P2002" }) });
    expect(await runFullBuild(f.prisma, "nightly", TZ, NOW)).toEqual({ status: "claimed_elsewhere" });
    expect(f.ops()).toEqual(["build.updateMany", "build.create"]);
  });

  it("a failed build is marked failed by a SEPARATE write (first line, ≤ 500 chars); the ready one keeps serving", async () => {
    const long = `canceling statement due to statement timeout${"x".repeat(600)}\nDETAIL: more`;
    const f = fake({ buildFails: new Error(long) });
    const r = await runFullBuild(f.prisma, "nightly", TZ, NOW);
    expect(r.status).toBe("failed");
    const failed = f.log.filter((c) => c.op === "build.updateMany")[1]!.args as { where: unknown; data: { error: string } };
    expect(failed.where).toEqual({ id: BUILD_ID, state: "building" });
    expect(failed.data.error).toHaveLength(500);
    expect(failed.data.error.startsWith("canceling statement due to statement timeout")).toBe(true);
    expect(failed.data.error).not.toContain("DETAIL");
    expect(failed.data).toMatchObject({ state: "failed", finishedAt: NOW });
    // No swap, no prune.
    expect(f.ops()).not.toContain("tx.build.update");
    expect(f.ops()).not.toContain("build.deleteMany");
  });

  it("any claim failure other than the unique index throws", async () => {
    const f = fake({ claimFails: new Error("db down") });
    await expect(runFullBuild(f.prisma, "nightly", TZ, NOW)).rejects.toThrow("db down");
  });
});

describe("rebuildAreas — one area's cells rebuilt from the ready build's own window", () => {
  const READY = { id: BUILD_ID, timezone: TZ, windowFrom: "2026-08-26", windowTo: "2026-09-22", cellsVersion: 3 };

  it("deletes those area keys' cells, rebuilds ONLY them (no camera keys), bumps cellsVersion — in one transaction", async () => {
    const f = fake({ ready: READY, inserted: 96 });
    const r = await rebuildAreas(f.prisma, ["z-1", "z-2"]);
    expect(r).toEqual({ status: "rebuilt", buildId: BUILD_ID, inserted: 96 });
    expect(f.ops()).toEqual([
      "build.findFirst",
      "$transaction",
      "tx.$executeRawUnsafe",
      "tx.$queryRawUnsafe", // the cells lock: concurrent rebuilds of one area take turns
      "tx.cell.deleteMany",
      "tx.$executeRaw",
      "tx.cell.count",
      "tx.build.update",
    ]);
    expect(f.log.find((c) => c.op === "tx.cell.deleteMany")!.args).toEqual({
      where: { buildId: BUILD_ID, zoneKey: { in: ["area:z-1", "area:z-2"] } },
    });
    const values = (f.log.find((c) => c.op === "tx.$executeRaw")!.args as { values: unknown[] }).values;
    expect(values[8]).toEqual(["z-1", "z-2"]);
    expect(values[9]).toBe(false);
    expect((values[1] as string[])[0]).toBe("2026-08-26");
    expect(f.log.find((c) => c.op === "tx.build.update")!.args).toEqual({
      where: { id: BUILD_ID },
      data: { cellsVersion: { increment: 1 }, cellCount: 400 },
    });
  });

  it("an area rebuild reads only its linked cameras' coverage and events — never a full-cost scan (review #2352, finding 3)", async () => {
    const f = fake({ ready: READY });
    await rebuildAreas(f.prisma, ["z-1"]);
    const sql = (f.log.find((c) => c.op === "tx.$executeRaw")!.args as { sql: string }).sql;
    expect(sql).toMatch(/p\.only_zone_ids IS NULL OR sp\.camera IN \(SELECT camera FROM link\)/);
    expect(sql).toMatch(/p\.only_zone_ids IS NULL OR e\.camera IN \(SELECT camera FROM link\)/);
    // `link` is defined before the CTEs that read it.
    expect(sql.indexOf("link AS (")).toBeLessThan(sql.indexOf("cam_obs AS ("));
  });

  it("concurrent area rebuilds take turns on one transaction-level advisory lock, taken before the delete (review #2352, finding 5)", async () => {
    const f = fake({ ready: READY });
    await rebuildAreas(f.prisma, ["z-1"]);
    const lock = f.log.find((c) => c.op === "tx.$queryRawUnsafe")!.args as string;
    expect(lock).toMatch(/pg_advisory_xact_lock\(hashtext\('droplet:security-baseline-cells'\)\)/);
  });

  it("no ready build → nothing to rebuild", async () => {
    const f = fake({ ready: null });
    expect(await rebuildAreas(f.prisma, ["z-1"])).toEqual({ status: "no_ready_build" });
    expect(f.ops()).toEqual(["build.findFirst"]);
  });
});

describe("a build fits inside the tick's advisory lock (review #2352, finding 5)", () => {
  it("40 s per statement, 50 s per transaction: under the cron runtime's 60 s lock with room for the rest of the tick", () => {
    expect(BASELINE_BUILD_STATEMENT_TIMEOUT).toBe("40s");
    expect(BASELINE_BUILD_TX_TIMEOUT_MS).toBe(50_000);
    const cron = readFileSync(join(PACKAGE_ROOT, "src", "services", "cron-runtime.service.ts"), "utf8");
    const lockMs = Number(/\{ timeout: ([0-9_]+) \}/.exec(cron)![1]!.replace(/_/g, ""));
    expect(lockMs).toBe(60_000);
    expect(BASELINE_BUILD_TX_TIMEOUT_MS).toBeLessThan(lockMs);
  });
});

describe("the statement — rule-carrying pieces a reader must find (the pg lane proves what they select)", () => {
  let sql = "";
  beforeEach(async () => {
    const f = fake();
    await runFullBuild(f.prisma, "first", TZ, NOW);
    sql = (f.log.find((c) => c.op === "tx.$executeRaw")!.args as { sql: string }).sql;
  });
  it("is the one INSERT … SELECT into the cells", () => {
    expect(sql).toMatch(/^\s*INSERT INTO "SecurityBaselineCell"/);
  });
  it("counts only frigate detections", () => {
    expect(sql).toMatch(/e\.source = 'frigate' AND e\.kind = 'detection'/);
  });
  it("an area slot needs EVERY linked camera observed, each for ≥ 5/6 of the slot", () => {
    expect(sql).toMatch(/HAVING COUNT\(DISTINCT o\.camera\) = cardinality\(a\.cams\)/);
    expect(sql).toMatch(/\* 5\.0 \/ 6\.0/);
  });
  it("the dwell quantile is a real visit (percentile_disc), never interpolated", () => {
    expect(sql).toContain("percentile_disc(0.99)");
    expect(sql).not.toContain("percentile_cont");
  });
  it("never converts time in SQL", () => {
    expect(sql).not.toMatch(/AT\s+TIME\s+ZONE/i);
    expect(sql).not.toMatch(/(^|[^A-Za-z_])timezone\s*\(/i);
  });
});
