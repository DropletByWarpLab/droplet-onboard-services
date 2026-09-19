/**
 * WARP-2904 — the NotificationLog row records the web-push decision
 * EXPLICITLY on the `sendNotification` path.
 *
 * `channels` keeps its meaning (push appears only when a push went out) and
 * `error` is only written when nothing delivered, so before this column a
 * push refused by the `web_push` off-LAN gate behind a delivered toast was
 * indistinguishable from "no subscribers" and from "push service failed".
 * `pushOutcome` names which one it was — never inferred from NULLs.
 *
 * Separate file from notifications.test.ts on purpose: those cases rely on
 * the REAL push pipeline throwing against a bare stub (push failure never
 * masks a toast) and stay unmodified; here the pipeline is mocked so each
 * outcome can be driven directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const mqttPublish = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  publish: (...a: unknown[]) => mqttPublish(...a),
}));

const dispatchMock = vi.fn();
const ensureMock = vi.fn(async () => undefined);
vi.mock("../services/push-dispatch.service.js", () => ({
  dispatchToUser: (...a: unknown[]) => dispatchMock(...a),
  ensurePushDispatch: () => ensureMock(),
}));

import { sendNotification } from "../services/notifications.service.js";

function makePrismaStub() {
  const created: Array<Record<string, unknown>> = [];
  const stub = {
    notificationLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `log-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      }),
    },
    _created: created,
  };
  return stub as unknown as PrismaClient & { _created: typeof created };
}

const input = { userId: "owner", kind: "ai" as const, title: "Run parked", body: "Needs a yes" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendNotification — pushOutcome on the NotificationLog row (WARP-2904)", () => {
  it("refused by the gate → pushOutcome refused_gate; channels stays 'toast'; error stays null", async () => {
    dispatchMock.mockResolvedValue({ sent: 0, pruned: 0, subscriptions: 0, refused: "egress_disabled" });
    const prisma = makePrismaStub();

    const result = await sendNotification(prisma, input);

    expect(result.delivered).toBe(true);
    expect(result.channels).toEqual(["toast"]);
    expect(result.error).toBeUndefined();
    const row = prisma._created[0];
    expect(row.pushOutcome).toBe("refused_gate");
    expect(row.channels).toBe("toast");
    expect(row.error).toBeNull();
  });

  it("gate open, no subscribers → pushOutcome no_subscribers", async () => {
    dispatchMock.mockResolvedValue({ sent: 0, pruned: 0, subscriptions: 0 });
    const prisma = makePrismaStub();
    await sendNotification(prisma, input);
    expect(prisma._created[0].pushOutcome).toBe("no_subscribers");
    expect(prisma._created[0].channels).toBe("toast");
  });

  it("gate open, a push went out → pushOutcome sent and 'push' joins channels", async () => {
    dispatchMock.mockResolvedValue({ sent: 1, pruned: 0, subscriptions: 1 });
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, input);
    expect(result.channels).toEqual(["toast", "push"]);
    expect(prisma._created[0].pushOutcome).toBe("sent");
    expect(prisma._created[0].channels).toBe("toast,push");
  });

  it("gate open, subscribers present, nothing sent → pushOutcome failed (distinct from no_subscribers)", async () => {
    dispatchMock.mockResolvedValue({ sent: 0, pruned: 0, subscriptions: 2 });
    const prisma = makePrismaStub();
    await sendNotification(prisma, input);
    expect(prisma._created[0].pushOutcome).toBe("failed");
    // A delivered toast still means the row carries no `error` — unchanged rule.
    expect(prisma._created[0].error).toBeNull();
  });

  it("the push pipeline throwing → pushOutcome failed, and the error reaches the row only when nothing delivered", async () => {
    dispatchMock.mockRejectedValue(new Error("vapid unconfigured"));
    mqttPublish.mockImplementationOnce(() => {
      throw new Error("mqtt down");
    });
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, input);
    expect(result.delivered).toBe(false);
    expect(prisma._created[0].pushOutcome).toBe("failed");
    expect(String(prisma._created[0].error)).toContain("push: vapid unconfigured");
  });

  it("a refusal is distinguishable in the row from no_subscribers AND from failed", async () => {
    const prisma = makePrismaStub();
    dispatchMock.mockResolvedValueOnce({ sent: 0, pruned: 0, subscriptions: 0, refused: "egress_disabled" });
    await sendNotification(prisma, input);
    dispatchMock.mockResolvedValueOnce({ sent: 0, pruned: 0, subscriptions: 0 });
    await sendNotification(prisma, input);
    dispatchMock.mockResolvedValueOnce({ sent: 0, pruned: 0, subscriptions: 1 });
    await sendNotification(prisma, input);
    expect(prisma._created.map((r) => r.pushOutcome)).toEqual([
      "refused_gate",
      "no_subscribers",
      "failed",
    ]);
    // …while `channels` and `error` are IDENTICAL across the three — which is
    // exactly why the column exists.
    expect(new Set(prisma._created.map((r) => r.channels)).size).toBe(1);
    expect(new Set(prisma._created.map((r) => r.error)).size).toBe(1);
  });
});
