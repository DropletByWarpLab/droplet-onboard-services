/**
 * WARP-3193 PERF-10 / QUAL-7 — reminders dispatch runs on its own cron-runtime
 * schedule, so a calendar sync that takes minutes (a 50 MB feed, a CalDAV
 * server that hangs) never holds a due reminder back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { syncSource, findStaleSources, sendNotification } = vi.hoisted(() => ({
  syncSource: vi.fn(),
  findStaleSources: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("./calendar.service.js", () => ({ syncSource, findStaleSources }));
vi.mock("./notifications.service.js", () => ({ sendNotification }));

import { startRemindersPoller } from "./reminders-poller.js";
import { createCronRuntime } from "./cron-runtime.service.js";

function prismaWith(due: Array<{ id: string; userId: string; title: string; body: string | null }>) {
  return {
    reminder: {
      findMany: vi.fn(async () => due.splice(0)),
      update: vi.fn(async () => ({})),
    },
  };
}

describe("reminders poller (WARP-3193)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    syncSource.mockReset();
    findStaleSources.mockReset();
    sendNotification.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches a reminder that falls due while a calendar sync is still running", async () => {
    // The first sync never finishes.
    findStaleSources.mockResolvedValue(["feed-1"]);
    syncSource.mockReturnValue(new Promise(() => {}));
    const due: Array<{ id: string; userId: string; title: string; body: string | null }> = [];
    const prisma = prismaWith(due);
    const rt = createCronRuntime();

    startRemindersPoller(prisma as never, rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncSource).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();

    // A reminder falls due; the next dispatch tick must deliver it even though
    // the sync is still stuck.
    due.push({ id: "r1", userId: "alice", title: "Bins", body: null });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sendNotification).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ username: "alice", kind: "reminder", title: "Bins" }),
    );
    // And the stuck sync was not stacked a second time beside itself.
    expect(syncSource).toHaveBeenCalledTimes(1);
    rt.stop();
  });

  it("registers no timer of its own: stopping the runtime stops the poller", async () => {
    findStaleSources.mockResolvedValue([]);
    const prisma = prismaWith([]);
    const rt = createCronRuntime();
    startRemindersPoller(prisma as never, rt);
    await vi.advanceTimersByTimeAsync(0);
    rt.stop();
    const calls = prisma.reminder.findMany.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(prisma.reminder.findMany.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});
