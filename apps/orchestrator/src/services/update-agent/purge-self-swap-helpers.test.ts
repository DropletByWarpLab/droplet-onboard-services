/**
 * WARP-1044 — GC of exited droplet-ota-self-swap-<id> helper containers.
 *
 * The self-swap helper runs WITHOUT --rm (its logs are the rollback forensic
 * trail — WARP-539) and the collision guard only reaps the previous helper
 * for the SAME update id, so every applied update leaves one exited container
 * behind. purgeSelfSwapHelpers (daily 03:00 purge cron, same 7-day window as
 * the backup GC) removes them once past retention, capturing `docker logs`
 * into <updatesDir>/<id>/self-swap-helper.log FIRST.
 *
 * The docker surface is the audited host script's fixed subcommands
 * (list-self-swap-helpers / capture-self-swap-logs / rm-self-swap-helper),
 * mocked here at the exec boundary — these tests pin the DECISIONS:
 *   - old exited helper       → logs captured, then removed (in that order);
 *   - recent exited helper    → kept;
 *   - running helper          → never touched, no matter how old;
 *   - in-flight update id     → never touched, no matter how old;
 *   - docker/script failures  → logged, sweep continues (never throws);
 *   - log already persisted   → capture skipped, container still removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import type { ExecFn } from "./host-compose-runner.js";
import { purgeSelfSwapHelpers } from "./purge-self-swap-helpers.js";

const SCRIPT = "/opt/droplet/scripts/lib/apply-update.sh";
const DAY_MS = 86400_000;

function createPrismaStub(rows: Array<{ id: string; status: string }>) {
  return {
    deviceUpdate: {
      findMany: async (args: { where?: { status?: { notIn?: string[] } } }) => {
        const notIn = args.where?.status?.notIn;
        return rows
          .filter((r) => notIn === undefined || !notIn.includes(r.status))
          .map((r) => ({ id: r.id }));
      },
    },
  } as never as PrismaClient;
}

function loggerSpy() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never as pino.Logger;
}

/** One listing line in the exact shape list-self-swap-helpers prints. */
function helperLine(updateId: string, status: string, finishedAt: string): string {
  return JSON.stringify({
    name: `/droplet-ota-self-swap-${updateId}`,
    status,
    finishedAt,
  });
}

function agoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

interface ExecCall {
  subcommand: string;
  updateId?: string;
}

/**
 * Exec-boundary mock: answers list-self-swap-helpers with the scripted lines
 * and records every call; failOn(subcommand, updateId) drives failures.
 */
function createExecMock(
  listLines: string[],
  failOn: (subcommand: string, updateId?: string) => boolean = () => false,
) {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (file, args) => {
    expect(file).toBe(SCRIPT);
    const call: ExecCall = { subcommand: args[0], updateId: args[2] };
    calls.push(call);
    if (failOn(call.subcommand, call.updateId)) {
      throw new Error(`stub: ${call.subcommand} failed`);
    }
    if (call.subcommand === "list-self-swap-helpers") {
      return { stdout: listLines.map((l) => `${l}\n`).join(""), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, exec };
}

let updatesDir: string;

beforeEach(() => {
  updatesDir = mkdtempSync(path.join(tmpdir(), "warp1044-updates-"));
});

afterEach(() => {
  rmSync(updatesDir, { recursive: true, force: true });
});

function runPurge(
  prisma: PrismaClient,
  exec: ExecFn,
  extra?: { logger?: pino.Logger },
) {
  return purgeSelfSwapHelpers(prisma, {
    scriptPath: SCRIPT,
    updatesDir,
    retentionDays: 7,
    exec,
    logger: extra?.logger ?? loggerSpy(),
  });
}

describe("purgeSelfSwapHelpers (WARP-1044)", () => {
  it("captures logs and then removes an exited helper past the retention window", async () => {
    const { calls, exec } = createExecMock([helperLine("du-old", "exited", agoIso(10))]);
    const prisma = createPrismaStub([{ id: "du-old", status: "committed" }]);

    const res = await runPurge(prisma, exec);

    expect(res).toEqual({ removed: 1, logsCaptured: 1 });
    expect(calls.map((c) => c.subcommand)).toEqual([
      "list-self-swap-helpers",
      "capture-self-swap-logs", // capture strictly BEFORE rm — the container
      "rm-self-swap-helper", //     is the only log store until then.
    ]);
    expect(calls[1].updateId).toBe("du-old");
    expect(calls[2].updateId).toBe("du-old");
  });

  it("keeps an exited helper INSIDE the retention window", async () => {
    const { calls, exec } = createExecMock([helperLine("du-recent", "exited", agoIso(2))]);
    const prisma = createPrismaStub([{ id: "du-recent", status: "committed" }]);

    const res = await runPurge(prisma, exec);

    expect(res).toEqual({ removed: 0, logsCaptured: 0 });
    expect(calls.map((c) => c.subcommand)).toEqual(["list-self-swap-helpers"]);
  });

  it("NEVER touches a running helper, no matter how old it looks", async () => {
    // A restarted helper can report an OLD FinishedAt from its previous run —
    // the status gate must win.
    const { calls, exec } = createExecMock([helperLine("du-running", "running", agoIso(30))]);
    const prisma = createPrismaStub([{ id: "du-running", status: "committed" }]);

    const res = await runPurge(prisma, exec);

    expect(res).toEqual({ removed: 0, logsCaptured: 0 });
    expect(calls.map((c) => c.subcommand)).toEqual(["list-self-swap-helpers"]);
  });

  it("NEVER touches the helper of an in-flight (non-terminal) update id", async () => {
    const { calls, exec } = createExecMock([helperLine("du-inflight", "exited", agoIso(30))]);
    const prisma = createPrismaStub([{ id: "du-inflight", status: "applying" }]);

    const res = await runPurge(prisma, exec);

    expect(res).toEqual({ removed: 0, logsCaptured: 0 });
    expect(calls.map((c) => c.subcommand)).toEqual(["list-self-swap-helpers"]);
  });

  it("skips the log capture when logs are already persisted, but still removes", async () => {
    // A prior sweep captured the logs but failed the rm (or the file was
    // placed by hand) — never double-write the forensic capture.
    mkdirSync(path.join(updatesDir, "du-old"), { recursive: true });
    writeFileSync(
      path.join(updatesDir, "du-old", "self-swap-helper.log"),
      "[ota-self-swap] already captured\n",
    );
    const { calls, exec } = createExecMock([helperLine("du-old", "exited", agoIso(10))]);
    const prisma = createPrismaStub([{ id: "du-old", status: "committed" }]);

    const res = await runPurge(prisma, exec);

    expect(res).toEqual({ removed: 1, logsCaptured: 0 });
    expect(calls.map((c) => c.subcommand)).toEqual([
      "list-self-swap-helpers",
      "rm-self-swap-helper",
    ]);
  });

  it("logs and skips the sweep when the docker listing fails — never throws", async () => {
    const logger = loggerSpy();
    const { calls, exec } = createExecMock([], (sub) => sub === "list-self-swap-helpers");
    const prisma = createPrismaStub([]);

    const res = await runPurge(prisma, exec, { logger });

    expect(res).toEqual({ removed: 0, logsCaptured: 0 });
    expect(calls.map((c) => c.subcommand)).toEqual(["list-self-swap-helpers"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "update.self_swap_helper_list_failed" }),
      expect.any(String),
    );
  });

  it("continues the sweep past a helper whose removal fails", async () => {
    const logger = loggerSpy();
    const { calls, exec } = createExecMock(
      [helperLine("du-wedged", "exited", agoIso(10)), helperLine("du-ok", "exited", agoIso(9))],
      (sub, id) => sub === "rm-self-swap-helper" && id === "du-wedged",
    );
    const prisma = createPrismaStub([
      { id: "du-wedged", status: "committed" },
      { id: "du-ok", status: "rolled_back" },
    ]);

    const res = await runPurge(prisma, exec, { logger });

    expect(res).toEqual({ removed: 1, logsCaptured: 2 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "update.self_swap_helper_purge_failed",
        deviceUpdateId: "du-wedged",
      }),
      expect.any(String),
    );
    // du-ok was still reaped after du-wedged failed.
    expect(calls.filter((c) => c.subcommand === "rm-self-swap-helper").map((c) => c.updateId))
      .toEqual(["du-wedged", "du-ok"]);
  });

  it("ignores foreign containers and malformed listing lines", async () => {
    const { calls, exec } = createExecMock([
      JSON.stringify({ name: "/some-other-container", status: "exited", finishedAt: agoIso(30) }),
      "not-json at all",
      helperLine("", "exited", agoIso(30)), // empty update id
    ]);
    const prisma = createPrismaStub([]);

    const res = await runPurge(prisma, exec);

    expect(res).toEqual({ removed: 0, logsCaptured: 0 });
    expect(calls.map((c) => c.subcommand)).toEqual(["list-self-swap-helpers"]);
  });
});
