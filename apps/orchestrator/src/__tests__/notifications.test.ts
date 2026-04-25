import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mock MQTT before importing the SUT. The HA mock is gone with HA itself —
// Matter is the only smart-home path now, and phone/push routing will come
// back via a dedicated notifier, not via HA.
const mqttPublish = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  publish: (...a: unknown[]) => mqttPublish(...a),
}));

import { sendNotification, listRecentNotifications } from "../services/notifications.service.js";

function makePrismaStub() {
  const created: Array<Record<string, unknown>> = [];
  const stub = {
    notificationLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `log-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      }),
      findMany: vi.fn(async () => created.slice().reverse()),
    },
    _created: created,
  };
  return stub as unknown as PrismaClient & { _created: typeof created };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendNotification", () => {
  it("publishes to MQTT and logs success", async () => {
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, {
      userId: "alice",
      kind: "reminder",
      title: "Standup",
      body: "Daily 10am",
    });
    expect(result.delivered).toBe(true);
    expect(result.channels).toEqual(["toast"]);
    expect(mqttPublish).toHaveBeenCalledWith(
      "droplet/notifications/alice",
      expect.objectContaining({ kind: "reminder", title: "Standup", body: "Daily 10am" }),
    );
    expect((prisma as any)._created[0].channels).toBe("toast");
    expect((prisma as any)._created[0].deliveredAt).toBeInstanceOf(Date);
    expect((prisma as any)._created[0].error).toBeNull();
  });

  it("publishes even without a body field", async () => {
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, {
      userId: "alice",
      kind: "ai",
      title: "Hello",
    });
    expect(result.channels).toEqual(["toast"]);
    expect(mqttPublish).toHaveBeenCalledOnce();
  });

  it("marks delivered=false when MQTT publish fails", async () => {
    const prisma = makePrismaStub();
    mqttPublish.mockImplementationOnce(() => {
      throw new Error("mqtt unavailable");
    });
    const result = await sendNotification(prisma, {
      userId: "alice",
      kind: "system",
      title: "x",
    });
    expect(result.delivered).toBe(false);
    expect(result.channels).toEqual([]);
    expect(result.error).toMatch(/toast: mqtt_unavailable/);
    expect((prisma as any)._created[0].deliveredAt).toBeNull();
  });
});

describe("listRecentNotifications", () => {
  it("clamps limit between 1 and 200", async () => {
    const prisma = makePrismaStub();
    await listRecentNotifications(prisma, "alice", 9999);
    expect(prisma.notificationLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
    await listRecentNotifications(prisma, "alice", 0);
    expect(prisma.notificationLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });
});
