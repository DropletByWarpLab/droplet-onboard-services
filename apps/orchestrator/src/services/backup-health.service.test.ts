import { beforeEach, describe, expect, it, vi } from "vitest";

type Dispatch = { userId: string; kind: string; title: string; body?: string | null; url?: string };
const sendNotification = vi.fn(async (_prisma: unknown, _input: Dispatch) => ({ id: "n", channels: ["toast"], delivered: true }));
vi.mock("./notifications.service.js", () => ({
  sendNotification: (prisma: unknown, input: Dispatch) => sendNotification(prisma, input),
}));

import {
  BACKUP_STOPPED_TITLE,
  backupHealth,
  createBackupHealthCheck,
  parseHostStatus,
  type HostBackupStatus,
} from "./backup-health.service.js";

const H = 3_600_000;
const NOW = new Date("2026-09-22T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * H).toISOString();

function status(p: Partial<HostBackupStatus>): HostBackupStatus {
  return {
    state: "ok",
    reason: "",
    since: ago(24 * 30),
    lastAttemptAt: ago(9),
    lastSuccessAt: ago(9),
    lastFailureAt: null,
    lastRekeyAt: null,
    ...p,
  };
}

/** A NotificationLog that remembers what was sent — so the dedupe is tested
 *  against the rows the check itself produced, not a canned answer. */
function makePrisma() {
  const log: { title: string; kind: string; createdAt: Date }[] = [];
  sendNotification.mockImplementation(async (_p, input) => {
    log.push({ title: input.title, kind: input.kind, createdAt: new Date(clock.getTime()) });
    return { id: "n", channels: ["toast"], delivered: true };
  });
  const prisma = {
    user: {
      findMany: vi.fn(async ({ where }: { where: { role: { in: string[] } } }) =>
        [
          { username: "stefan", role: "owner" },
          { username: "romain", role: "admin" },
          { username: "kid", role: "family" },
        ].filter((u) => where.role.in.includes(u.role)),
      ),
    },
    notificationLog: {
      findFirst: vi.fn(async ({ where }: { where: { title: string; kind: string; createdAt?: { gt: Date } } }) =>
        log.find(
          (r) => r.title === where.title && r.kind === where.kind && (!where.createdAt || r.createdAt > where.createdAt.gt),
        ) ?? null,
      ),
    },
  };
  return { prisma: prisma as never, log };
}

let clock = NOW;

beforeEach(() => {
  sendNotification.mockReset();
  clock = NOW;
});

describe("backupHealth — one explicit value from the host status + the clock", () => {
  it("no status file → not_reporting (never guessed healthy)", () => {
    expect(backupHealth(null, NOW)).toMatchObject({ health: "not_reporting", alerting: false });
  });

  it("recent success → healthy", () => {
    expect(backupHealth(status({}), NOW)).toMatchObject({ health: "healthy", alerting: false });
  });

  it("one failed night with a success still inside 48 h → failing, not yet an alert", () => {
    const v = backupHealth(status({ state: "failed", reason: "dumping the databases (exit 1)", lastSuccessAt: ago(30) }), NOW);
    expect(v).toMatchObject({ health: "failing", alerting: false, reason: "dumping the databases (exit 1)" });
  });

  it("no success in 48 h → overdue, even if the last recorded run said ok (the timer stopped firing)", () => {
    expect(backupHealth(status({ state: "ok", lastSuccessAt: ago(49) }), NOW)).toMatchObject({ health: "overdue", alerting: true });
  });

  it("the window boundary is 48 h exactly", () => {
    expect(backupHealth(status({ lastSuccessAt: ago(48) }), NOW).health).toBe("healthy");
    expect(backupHealth(status({ lastSuccessAt: ago(48.01) }), NOW).health).toBe("overdue");
  });

  it("an orphaned repository alerts at once, before the window runs out", () => {
    expect(backupHealth(status({ state: "key_mismatch", lastSuccessAt: ago(2) }), NOW)).toMatchObject({
      health: "key_mismatch",
      alerting: true,
    });
  });

  it("before any success, the window runs from first contact (since)", () => {
    expect(backupHealth(status({ state: "pending", lastSuccessAt: null, since: ago(3) }), NOW).health).toBe("pending");
    expect(backupHealth(status({ state: "pending", lastSuccessAt: null, since: ago(50) }), NOW).health).toBe("overdue");
    expect(backupHealth(status({ state: "failed", lastSuccessAt: null, since: ago(50) }), NOW).health).toBe("overdue");
  });
});

describe("parseHostStatus — off-contract input is not_reporting, never a guess", () => {
  it("parses the file droplet-backup.sh writes", () => {
    const raw = `{
  "schema": 1,
  "state": "key_mismatch",
  "reason": "the backup repository no longer opens with this Droplet's key",
  "since": "2026-07-03T03:15:00Z",
  "lastAttemptAt": "2026-07-19T03:15:00Z",
  "lastSuccessAt": "2026-07-03T03:15:00Z",
  "lastFailureAt": "2026-07-19T03:15:00Z",
  "lastRekeyAt": null,
  "repository": "/var/lib/droplet/restic-repo"
}`;
    expect(parseHostStatus(raw)).toMatchObject({ state: "key_mismatch", lastRekeyAt: null, lastSuccessAt: "2026-07-03T03:15:00Z" });
  });

  it("unknown state or garbage → null", () => {
    expect(parseHostStatus('{"state":"fine"}')).toBeNull();
    expect(parseHostStatus("{not json")).toBeNull();
  });
});

describe("createBackupHealthCheck — exactly one notification per outage", () => {
  it("a missed window notifies owners + admins once, not once per hourly tick", async () => {
    const { prisma } = makePrisma();
    const s = status({ state: "failed", reason: "writing the snapshot (exit 1)", lastSuccessAt: ago(72) });
    const check = createBackupHealthCheck({ prisma, readStatus: async () => s, now: () => clock });

    for (let tick = 0; tick < 5; tick++) {
      clock = new Date(NOW.getTime() + tick * H);
      await check.runOnce();
    }

    expect(sendNotification).toHaveBeenCalledTimes(2); // one per recipient, one round
    expect(sendNotification.mock.calls.map((c) => c[1].userId).sort()).toEqual(["romain", "stefan"]);
    const input = sendNotification.mock.calls[0][1];
    expect(input).toMatchObject({ kind: "system", title: BACKUP_STOPPED_TITLE, url: "/settings" });
    expect(input.body).toContain("writing the snapshot");
  });

  it("an orphaned repository is reported, not ignored", async () => {
    const { prisma } = makePrisma();
    const s = status({ state: "key_mismatch", reason: "x", lastSuccessAt: ago(5) });
    await createBackupHealthCheck({ prisma, readStatus: async () => s, now: () => clock }).runOnce();
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification.mock.calls[0][1].body).toContain("no longer opens");
  });

  it("recovery then a NEW outage is announced again", async () => {
    const { prisma } = makePrisma();
    let s = status({ state: "failed", lastSuccessAt: ago(72) });
    const check = createBackupHealthCheck({ prisma, readStatus: async () => s, now: () => clock });
    await check.runOnce();
    expect(sendNotification).toHaveBeenCalledTimes(2);

    // Backups recover (a success AFTER the alert), then stop again for 3 days.
    clock = new Date(NOW.getTime() + 24 * H);
    s = status({ state: "ok", lastSuccessAt: clock.toISOString() });
    await check.runOnce();
    clock = new Date(NOW.getTime() + 24 * H + 72 * H);
    s = status({ state: "failed", lastSuccessAt: new Date(NOW.getTime() + 24 * H).toISOString() });
    await check.runOnce();
    await check.runOnce();
    expect(sendNotification).toHaveBeenCalledTimes(4);
  });

  it("healthy, failing-within-window and not_reporting stay quiet", async () => {
    const { prisma } = makePrisma();
    for (const s of [status({}), status({ state: "failed", lastSuccessAt: ago(20) }), null]) {
      await createBackupHealthCheck({ prisma, readStatus: async () => s, now: () => clock }).runOnce();
    }
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
