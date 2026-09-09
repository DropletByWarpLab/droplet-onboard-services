/**
 * WARP-2177 — review check: durable runs added NO queue dependency.
 *
 * The epic (WARP-2176) evaluated Temporal, BullMQ-shaped queues and a second
 * scheduler and rejected all of them: `cronRuntime.scheduleInterval` plus the
 * transaction-scoped `pg_try_advisory_xact_lock` already in
 * cron-runtime.service.ts is the whole runtime. This guard turns that
 * decision into a red build if anyone reaches for a queue package later.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `__dirname`, not `import.meta.url`: this package builds to CommonJS, where
// tsc rejects import.meta outright (TS1470) — same resolution as
// confirmation-owner-drift.guard.test.ts. Never the cwd (WARP-2654).
const ORCHESTRATOR_PACKAGE_JSON = join(__dirname, "..", "..", "package.json");

const QUEUE_PACKAGES = [
  "bullmq",
  "bull",
  "bee-queue",
  "agenda",
  "pg-boss",
  "graphile-worker",
  "@temporalio/client",
  "@temporalio/worker",
  "kue",
  "bree",
];

describe("agent runs — no queue dependency (WARP-2177 review check)", () => {
  it("apps/orchestrator/package.json declares none of the known queue packages", () => {
    const pkg = JSON.parse(readFileSync(ORCHESTRATOR_PACKAGE_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const found = QUEUE_PACKAGES.filter((name) => declared.has(name));
    expect(found).toEqual([]);
  });
});
