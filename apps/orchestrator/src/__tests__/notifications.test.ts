import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mock the MQTT and HA clients before importing the SUT.
const mqttPublish = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  publish: (...a: unknown[]) => mqttPublish(...a),
}));

const haCallService = vi.fn();
vi.mock("../services/home-assistant.client.js", () => ({
  callService: (...a: unknown[]) => haCallService(...a),
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
  haCallService.mockResolvedValue(undefined);
});

describe("sendNotification", () => {
  it("publishes to MQTT, calls HA when target is set, and logs success", async () => {
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, {
      userId: "alice",
      kind: "reminder",
      title: "Standup",
      body: "Daily 10am",
      haTarget: "notify.mobile_app_alice",
    });
    expect(result.delivered).toBe(true);
    expect(result.channels).toEqual(expect.arrayContaining(["toast", "ha"]));
    expect(mqttPublish).toHaveBeenCalledWith(
      "droplet/notifications/alice",
      expect.objectContaining({ kind: "reminder", title: "Standup", body: "Daily 10am" }),
    );
    expect(haCallService).toHaveBeenCalledWith(
      "notify",
      "mobile_app_alice",
      "",
      expect.objectContaining({ title: "Standup", message: "Daily 10am" }),
    );
    expect((prisma as any)._created[0].channels).toBe("toast,ha");
    expect((prisma as any)._created[0].deliveredAt).toBeInstanceOf(Date);
    expect((prisma as any)._created[0].error).toBeNull();
  });

  it("skips HA when ha_target is not provided", async () => {
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, {
      userId: "alice",
      kind: "ai",
      title: "Hello",
    });
    expect(result.channels).toEqual(["toast"]);
    expect(haCallService).not.toHaveBeenCalled();
  });

  it("logs HA failure but still reports delivered=true via toast", async () => {
    const prisma = makePrismaStub();
    haCallService.mockRejectedValueOnce(new Error("HA down"));
    const result = await sendNotification(prisma, {
      userId: "alice",
      kind: "reminder",
      title: "x",
      haTarget: "notify.bad",
    });
    expect(result.delivered).toBe(true); // toast worked
    expect(result.channels).toEqual(["toast"]);
    expect(result.error).toMatch(/ha: HA down/);
    expect((prisma as any)._created[0].error).toMatch(/HA down/);
  });

  it("strips the 'notify.' prefix from haTarget before calling HA", async () => {
    const prisma = makePrismaStub();
    await sendNotification(prisma, {
      userId: "alice",
      kind: "system",
      title: "x",
      haTarget: "notify.echo_kitchen",
    });
    expect(haCallService).toHaveBeenCalledWith("notify", "echo_kitchen", "", expect.any(Object));
  });

  it("handles MQTT publish failure gracefully", async () => {
    const prisma = makePrismaStub();
    mqttPublish.mockImplementationOnce(() => {
      throw new Error("mqtt unavailable");
    });
    const result = await sendNotification(prisma, {
      userId: "alice",
      kind: "system",
      title: "x",
      haTarget: "notify.x",
    });
    // Toast failed, HA succeeded — still delivered.
    expect(result.delivered).toBe(true);
    expect(result.channels).toEqual(["ha"]);
    expect(result.error).toMatch(/toast: mqtt_unavailable/);
  });

  it("delivered=false when both channels fail", async () => {
    const prisma = makePrismaStub();
    mqttPublish.mockImplementationOnce(() => { throw new Error("nope"); });
    haCallService.mockRejectedValueOnce(new Error("nope"));
    const result = await sendNotification(prisma, {
      userId: "alice",
      kind: "system",
      title: "x",
      haTarget: "notify.x",
    });
    expect(result.delivered).toBe(false);
    expect(result.channels).toEqual([]);
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
