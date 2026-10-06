import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ register: vi.fn(), sweep: vi.fn(), sync: vi.fn() }));
vi.mock("../pm/pm-outbox.js", () => ({ registerOutboxConsumer: mocks.register }));
vi.mock("./sla-clock.service.js", () => ({ sweepTicketSlas: mocks.sweep, syncTicketSla: mocks.sync }));
import { registerSupportSlaRuntime } from "./sla-runtime.js";
beforeEach(() => { vi.clearAllMocks(); mocks.sweep.mockResolvedValue(0); mocks.sync.mockResolvedValue(undefined); });
describe("SLA lifecycle on the canonical runtime", () => {
  const now = new Date("2026-10-05T09:00:00Z");
  function register() {
    const tx = {};
    const prisma: any = { $transaction: vi.fn(async (fn) => fn(tx)) };
    const cron: any = { scheduleInterval: vi.fn(), scheduleCron: vi.fn(), stop: vi.fn() };
    const deps = { now: () => now };
    registerSupportSlaRuntime(prisma, cron, deps);
    return { prisma, cron, deps, tx, consumer: mocks.register.mock.calls[0]![0] };
  }
  it("uses the shared runtime's replica lock, startup execution and shutdown ownership", async () => {
    const f = register();
    expect(f.cron.scheduleInterval).toHaveBeenCalledWith(60000, expect.any(Function), { lockKey: "droplet:support-sla-clock", immediate: true });
    await f.cron.scheduleInterval.mock.calls[0][1]();
    expect(mocks.sweep).toHaveBeenCalledWith(f.prisma, f.deps);
    expect(mocks.register.mock.calls[0]![1]).toEqual({ prisma: f.prisma, cronRuntime: f.cron, now: f.deps.now });
  });
  it("propagates failures to the runtime's retry/canary path", async () => {
    const f = register(); mocks.sweep.mockRejectedValueOnce(new Error("clock database offline"));
    await expect(f.cron.scheduleInterval.mock.calls[0][1]()).rejects.toThrow("clock database offline");
  });
  it("repairs committed creation/priority activity transactionally and does not consume its own transitions", async () => {
    const f = register();
    await f.consumer.handle({ workItemId: "t1", verb: "created" });
    await f.consumer.handle({ workItemId: "t1", verb: "updated", field: "priority" });
    await f.consumer.handle({ workItemId: "t1", verb: "sla_breached" });
    expect(mocks.sync.mock.calls).toEqual([[f.tx, "t1", now, "create", f.deps], [f.tx, "t1", now, "priority", f.deps]]);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
  });
  it.each(["deleted", "created"])("ignores detached %s activity without a current work item", async (verb) => {
    const f = register();
    await f.consumer.handle({ workItemId: null, verb });
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
