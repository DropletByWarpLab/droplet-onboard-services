import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mock MQTT before importing the SUT. The smart-home surface is Matter
// (matter.service.ts); push delivery to phones rides on the Web Push
// pipeline in services/push-dispatch.service.ts.
const mqttPublish = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  publish: (...a: unknown[]) => mqttPublish(...a),
}));

// WARP-2904: the dial-time DNS check resolves push hosts; keep it offline.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "142.250.0.1", family: 4 }],
}));

// WARP-2909 — web-push itself is mocked so a test can capture the exact
// payload the push channel would encrypt and send.
const webpushSend = vi.fn(async () => ({}));
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
    setVapidDetails: () => {},
    sendNotification: (...a: unknown[]) => webpushSend(...(a as [])),
  },
}));

import {
  sendNotification,
  deliverNotification,
  listNotifications,
  publishNotificationToast,
  recordNotification,
  assertNotificationLink,
  assertNotificationData,
  NotificationRecipientError,
  notifyOwnersAndAdmins,
} from "../services/notifications.service.js";
import { isReservedUserId, isUserIdShaped } from "@droplet/auth-policy";
import { makeFakeNotificationLog } from "./helpers/fake-notification-log.js";

/** WARP-2804 — the log is an evaluating fake: `sendNotification` now records
 *  the row first (create), reads it back and stamps the outcome on it
 *  (update), so `_created[0]` is the row as it stands after delivery. */
function makePrismaStub() {
  const log = makeFakeNotificationLog();
  const stub = {
    notificationLog: log.delegate,
    _created: log.rows as unknown as Array<Record<string, unknown>>,
  };
  return stub as unknown as PrismaClient & { _created: Array<Record<string, unknown>> };
}

/** The same stub plus the two delegates web push needs: a persisted VAPID
 *  keypair and one subscription for the user. */
function makePushingPrismaStub() {
  const stub = makePrismaStub() as unknown as Record<string, unknown>;
  stub.systemFlag = {
    findUnique: vi.fn(async () => ({ valueJson: { publicKey: "pub", privateKey: "priv" } })),
  };
  // WARP-2904 — the web_push off-LAN channel is open for these cases.
  stub.offLanAllowlistChannel = {
    findUnique: vi.fn(async () => ({ key: "web_push", enabled: true })),
  };
  stub.pushSubscription = {
    // WARP-2904: only a real push-service host is dialled.
    findMany: vi.fn(async () => [{ endpoint: "https://fcm.googleapis.com/fcm/send/1", p256dhKey: "p", authKey: "a" }]),
    count: vi.fn(async () => 1),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  return stub as unknown as PrismaClient & { _created: Array<Record<string, unknown>> };
}

const PARKED = {
  username: "romain",
  kind: "ai" as const,
  title: "Approval needed: delete_file",
  body: "Open the run to approve or deny it.",
  url: "/workshop?run=run-1",
  tag: "agent-run:run-1",
  data: { agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendNotification", () => {
  it("publishes to MQTT and logs success", async () => {
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, {
      username: "alice",
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
    // WARP-2911 — the row is keyed by the column's real name.
    expect((prisma as any)._created[0].username).toBe("alice");
    expect((prisma as any)._created[0]).not.toHaveProperty("userId");
  });

  // WARP-2752 — web push is a SECOND channel, and its failures must not be
  // mistaken for a delivery failure.
  //
  // The stub below has no `pushSubscription` delegate, so `dispatchToUser`
  // throws — which is also what a box with push misconfigured does. On such a
  // box EVERY notification would otherwise carry an error string, `error`
  // would be uniformly non-null, and a real failure would be invisible in
  // exactly the column someone would check. `error` answers "why did this not
  // arrive"; if the toast carried it, nothing failed to arrive.
  it("a push failure does NOT mask a delivered toast", async () => {
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, {
      username: "alice",
      kind: "ai",
      title: "Acme is 90 days past due",
    });
    expect(result.delivered).toBe(true);
    expect(result.channels).toEqual(["toast"]);
    expect(result.error).toBeUndefined();
    expect((prisma as any)._created[0].error).toBeNull();
  });

  it("records the push failure when NOTHING delivered", async () => {
    // The other side of the same rule: with no channel carrying it, the push
    // error is the only explanation there is, so it must reach the row.
    mqttPublish.mockImplementationOnce(() => {
      throw new Error("mqtt down");
    });
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, {
      username: "alice",
      kind: "ai",
      title: "Acme is 90 days past due",
    });
    expect(result.delivered).toBe(false);
    expect(result.channels).toEqual([]);
    expect(String((prisma as any)._created[0].error)).toContain("push:");
  });

  it("publishes even without a body field", async () => {
    const prisma = makePrismaStub();
    const result = await sendNotification(prisma, {
      username: "alice",
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
      username: "alice",
      kind: "system",
      title: "x",
    });
    expect(result.delivered).toBe(false);
    expect(result.channels).toEqual([]);
    expect(result.error).toMatch(/toast: mqtt_unavailable/);
    expect((prisma as any)._created[0].deliveredAt).toBeNull();
  });
});

describe("listNotifications — the limit", () => {
  it("clamps limit between 1 and 200 (one extra row is read to know whether there is a next page)", async () => {
    const prisma = makePrismaStub();
    await listNotifications(prisma, "alice", { limit: 9999 });
    expect(prisma.notificationLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 201 }),
    );
    // WARP-2911 — read back by the recipient's username.
    expect(prisma.notificationLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ username: "alice" }) }),
    );
    await listNotifications(prisma, "alice", { limit: 0 });
    expect(prisma.notificationLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 2 }),
    );
  });
});

// WARP-2904 — the push leg's outcome is an explicit enum on the row, so a dial
// refused by the `web_push` off-LAN gate is distinguishable from "no
// subscribers" and from "push failed" — and never hides in `error` behind a
// delivered toast.
describe("sendNotification — NotificationLog.pushOutcome", () => {
  const vapid = { publicKey: "pub", privateKey: "priv" };
  function stubWithPush(gateEnabled: boolean | "throws") {
    const stub = makePrismaStub() as any;
    stub.systemFlag = { findUnique: vi.fn(async () => ({ valueJson: vapid })) };
    stub.offLanAllowlistChannel = {
      findUnique: vi.fn(async () => {
        if (gateEnabled === "throws") throw new Error("db down");
        return { key: "web_push", enabled: gateEnabled };
      }),
    };
    stub.pushSubscription = {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    return stub;
  }

  for (const gate of [false, "throws"] as const) {
    it(`gate ${String(gate)} → refused_gate; toast still delivered, error stays null`, async () => {
      const prisma = stubWithPush(gate);
      const result = await sendNotification(prisma, { username: "alice", kind: "ai", title: "x" });
      expect(result.channels).toEqual(["toast"]);
      expect(prisma._created[0].pushOutcome).toBe("refused_gate");
      expect(prisma._created[0].error).toBeNull();
      expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    });
  }

  it("gate on, no subscriptions → no_subscribers", async () => {
    const prisma = stubWithPush(true);
    await sendNotification(prisma, { username: "alice", kind: "ai", title: "x" });
    expect(prisma._created[0].pushOutcome).toBe("no_subscribers");
    expect(prisma._created[0].channels).toBe("toast");
  });

  it("a throwing push leg → failed", async () => {
    const prisma = stubWithPush(true);
    prisma.pushSubscription.findMany.mockRejectedValueOnce(new Error("db down"));
    await sendNotification(prisma, { username: "alice", kind: "ai", title: "x" });
    expect(prisma._created[0].pushOutcome).toBe("failed");
    expect(prisma._created[0].error).toBeNull(); // the toast carried it
  });
});

// ── WARP-2909: deep links ───────────────────────────────────────────────────

describe("assertNotificationLink (WARP-2909)", () => {
  it.each(["/workshop?run=r1", "/", "/cameras/front_door"])("accepts the same-origin path %s", (u) => {
    expect(() => assertNotificationLink(u)).not.toThrow();
  });
  it.each([
    ["a scheme", "https://evil.example/x"],
    ["javascript:", "javascript:alert(1)"],
    ["mailto:", "mailto:a@b.c"],
    ["protocol-relative", "//evil.example/x"],
    ["a backslash", "/\\evil.example"],
    ["CR", "/a\rb"],
    ["LF", "/a\nb"],
    ["NUL", "/a\u0000b"],
    ["a relative path", "workshop"],
    ["empty", ""],
    ["over 512 chars", "/" + "a".repeat(512)],
  ])("rejects %s", (_label, u) => {
    expect(() => assertNotificationLink(u)).toThrow(/invalid_notification_link/);
  });
});

describe("assertNotificationData (WARP-2909)", () => {
  it("accepts a small flat object", () => {
    expect(() => assertNotificationData({ a: "x", n: 1, b: true })).not.toThrow();
  });
  it.each(["url", "token", "confirmationToken", "bindingHash", "pendingBindingHash"])(
    "refuses the key %s",
    (k) => {
      expect(() => assertNotificationData({ [k]: "x" })).toThrow(/forbidden key/);
    },
  );
  it("refuses nesting", () => {
    expect(() => assertNotificationData({ a: { b: 1 } } as never)).toThrow(/not flat/);
    expect(() => assertNotificationData({ a: [1] } as never)).toThrow(/not flat/);
  });
  it("refuses more than 1 KB serialised", () => {
    expect(() => assertNotificationData({ a: "x".repeat(1100) })).toThrow(/too large/);
  });
});

describe("sendNotification deep link (WARP-2909)", () => {
  it("a bad url throws before the toast, the push and the row", async () => {
    const prisma = makePushingPrismaStub();
    await expect(sendNotification(prisma, { ...PARKED, url: "//evil.example" })).rejects.toThrow(
      /invalid_notification_link/,
    );
    expect(prisma._created).toHaveLength(0);
    expect(mqttPublish).not.toHaveBeenCalled();
    expect(webpushSend).not.toHaveBeenCalled();
  });

  it("a bad tag throws too", async () => {
    const prisma = makePrismaStub();
    await expect(sendNotification(prisma, { ...PARKED, tag: "has space" })).rejects.toThrow(/tag/);
    expect(prisma._created).toHaveLength(0);
  });

  it("carries url + data to the toast, url + data + tag to web push, url + data to the row", async () => {
    const prisma = makePushingPrismaStub();
    const result = await sendNotification(prisma, PARKED);
    expect(result.channels).toEqual(["toast", "push"]);

    const toast = mqttPublish.mock.calls[0]![1] as Record<string, unknown>;
    expect(toast).toMatchObject({ url: PARKED.url, data: PARKED.data });

    const push = JSON.parse(String((webpushSend.mock.calls[0] as unknown[])[1]));
    expect(push).toEqual({
      title: PARKED.title,
      body: PARKED.body,
      url: PARKED.url,
      data: PARKED.data,
      tag: PARKED.tag,
      notificationId: result.id,
    });

    expect(prisma._created[0]).toMatchObject({ url: PARKED.url, data: PARKED.data });
    // WARP-2911 — the push leg looks subscriptions up by the same username.
    expect((prisma as any).pushSubscription.findMany).toHaveBeenCalledWith({ where: { username: "romain" } });

    // The redemption contract: nothing that could approve the run rides on
    // any of the three, and the link's only query key is `run`.
    const secretish = /token|hash|confirm/i;
    const keysOf = (o: unknown): string[] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...keysOf(v)]) : [];
    for (const surface of [toast, push, prisma._created[0]]) {
      expect(keysOf(surface).filter((k) => secretish.test(k))).toEqual([]);
    }
    expect([...new URL(PARKED.url, "https://box.local").searchParams.keys()]).toEqual(["run"]);
  });

  it("no tag supplied → the push carries tag: undefined (none is derived)", async () => {
    const prisma = makePushingPrismaStub();
    await sendNotification(prisma, { username: "alice", kind: "reminder", title: "Standup" });
    const push = JSON.parse(String((webpushSend.mock.calls[0] as unknown[])[1]));
    expect(push.tag).toBeUndefined();
    expect(push.url).toBeUndefined();
    expect(prisma._created[0]).toMatchObject({ url: null });
  });
});

// WARP-2904 × WARP-2909 — the gate runs before the payload is built into a
// push: a refused dial sends nothing, so the deep link never leaves the box
// by push, while the toast and the row still carry it.
describe("deep link behind a closed web_push gate", () => {
  it("nothing is pushed, url included; toast + row keep the link; outcome refused_gate", async () => {
    const prisma = makePushingPrismaStub();
    (prisma as any).offLanAllowlistChannel.findUnique.mockResolvedValue({ key: "web_push", enabled: false });
    const result = await sendNotification(prisma, PARKED);

    expect(webpushSend).not.toHaveBeenCalled();
    expect((prisma as any).pushSubscription.findMany).not.toHaveBeenCalled();
    expect(result.channels).toEqual(["toast"]);
    expect(mqttPublish.mock.calls[0]![1]).toMatchObject({ url: PARKED.url });
    expect(prisma._created[0]).toMatchObject({ url: PARKED.url, pushOutcome: "refused_gate", error: null });
  });
});

describe("publishNotificationToast deep link (WARP-2909)", () => {
  it("never throws: a bad url is DROPPED from the toast and recorded", () => {
    const out = publishNotificationToast({ ...PARKED, id: "log-1", url: "javascript:alert(1)" });
    expect(out.channels).toEqual(["toast"]);
    expect(out.errors).toContain("toast: invalid_link");
    const toast = mqttPublish.mock.calls[0]![1] as Record<string, unknown>;
    expect(toast).not.toHaveProperty("url");
    expect(toast).not.toHaveProperty("data");
  });
});

describe("recordNotification deep link (WARP-2909)", () => {
  it("throws before the row write on a bad url", async () => {
    const prisma = makePrismaStub();
    await expect(recordNotification(prisma, { ...PARKED, url: "https://x" })).rejects.toThrow();
    expect(prisma._created).toHaveLength(0);
  });
  it("writes url + data", async () => {
    const prisma = makePrismaStub();
    await recordNotification(prisma, PARKED);
    expect(prisma._created[0]).toMatchObject({ url: PARKED.url, data: PARKED.data });
  });
});

describe("listNotifications deep link (WARP-2909)", () => {
  it("returns url and data for a row written with them", async () => {
    const prisma = makePrismaStub();
    await sendNotification(prisma, PARKED);
    const { rows: [row] } = await listNotifications(prisma, "romain");
    expect(row).toMatchObject({ url: PARKED.url, data: PARKED.data });
  });
});

// ── WARP-2911: the recipient is a username, never a User.id ─────────────────
//
// A `User.id` (`@default(uuid())`) handed to the recipient slot fails SILENTLY
// and completely — the broker drops the toast, no PushSubscription matches, and
// no reader can see the row. It shipped three times (WARP-2783, WARP-2813,
// WARP-2910), each time behind a green test whose fake had `id === username`.
// So all three entry points refuse a UUID-shaped recipient by THROWING, with
// the caller's file in the error, before anything is published or written.
describe("WARP-2911 — a UUID-shaped recipient is refused (NOTIFICATION_RECIPIENT_IS_ID)", () => {
  const USER_ID = "3b7d0195-6c1e-4f2a-9d8b-2a4c6e8f0a1b";
  const to = (username: string) => ({ username, kind: "system" as const, title: "Audit log integrity check failed" });

  it("sendNotification throws before the toast, the push and the row", async () => {
    const prisma = makePushingPrismaStub();
    const err = await sendNotification(prisma, to(USER_ID)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationRecipientError);
    expect(err).toMatchObject({ code: "NOTIFICATION_RECIPIENT_IS_ID" });
    expect(mqttPublish).not.toHaveBeenCalled();
    expect(webpushSend).not.toHaveBeenCalled();
    expect(prisma._created).toHaveLength(0);
  });

  it("publishNotificationToast throws instead of publishing to a topic nobody subscribes", () => {
    expect(() => publishNotificationToast({ ...to(USER_ID), id: "log-1" })).toThrow(NotificationRecipientError);
    expect(mqttPublish).not.toHaveBeenCalled();
  });

  it("recordNotification throws before the row write (inside a caller's transaction, that aborts it)", async () => {
    const prisma = makePrismaStub();
    await expect(recordNotification(prisma, to(USER_ID))).rejects.toMatchObject({
      code: "NOTIFICATION_RECIPIENT_IS_ID",
    });
    expect(prisma._created).toHaveLength(0);
  });

  it("upper-case hex is still an id", () => {
    expect(() => publishNotificationToast({ ...to(USER_ID.toUpperCase()), id: "log-1" })).toThrow(
      /NOTIFICATION_RECIPIENT_IS_ID/,
    );
  });

  it("the error names the caller's file, so the log line says where the id came from", () => {
    let err: unknown;
    try {
      publishNotificationToast({ ...to(USER_ID), id: "log-1" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotificationRecipientError);
    const e = err as NotificationRecipientError;
    expect(e.caller).toMatch(/notifications\.test\.ts/);
    expect(e.message).toContain(e.caller!);
    expect(e.toJSON()).toMatchObject({ code: "NOTIFICATION_RECIPIENT_IS_ID", caller: e.caller });
  });

  it("refuses EXACTLY what @droplet/auth-policy refuses to mint — creation and refusal cannot drift", () => {
    // Every place a username is created refuses `isReservedUserId`, which
    // includes `isUserIdShaped`. If the refusal here drifted from that shape,
    // either a creatable username would be refused every notification, or an
    // id would slip through. One predicate, asserted from both sides.
    const samples = [USER_ID, USER_ID.toUpperCase(), `${USER_ID}-2`, `sso-${USER_ID}`, "dev", "alice", USER_ID.slice(1)];
    for (const username of samples) {
      let refused = false;
      try {
        publishNotificationToast({ ...to(username), id: "log-1" });
      } catch (e) {
        refused = e instanceof NotificationRecipientError;
      }
      expect(refused, username).toBe(isUserIdShaped(username));
      expect(isReservedUserId(username) || !refused, username).toBe(true);
    }
  });

  it.each(["dev", "_service:mcp", "alice", "romain.jouffret@example.com"])(
    "%s is a username: all three accept it",
    async (username) => {
      const prisma = makePrismaStub();
      await expect(sendNotification(prisma, to(username))).resolves.toMatchObject({ channels: ["toast"] });
      expect(() => publishNotificationToast({ ...to(username), id: "log-1" })).not.toThrow();
      await expect(recordNotification(prisma, to(username))).resolves.toHaveProperty("id");
      expect(mqttPublish).toHaveBeenCalledWith(`droplet/notifications/${username}`, expect.anything());
    },
  );
});

// WARP-2911 — the OTA path's owner/admin fan-out (index.ts `notifyOwners`),
// here so it can be tested: one refused recipient (an account whose username
// predates the ban on the User.id shape) never costs the others the alert.
describe("notifyOwnersAndAdmins (WARP-2911)", () => {
  const LEGACY = "5f0c2a1e-7b3d-4c9e-8a21-0e6d4b9c3f70";

  function ownersStub(usernames: string[]) {
    const stub = makePrismaStub() as unknown as Record<string, unknown>;
    stub.user = {
      findMany: vi.fn(async ({ where }: { where: { role: { in: string[] } } }) => {
        expect(where.role.in.sort()).toEqual(["admin", "owner"]);
        return usernames.map((username) => ({ username }));
      }),
    };
    return stub as unknown as PrismaClient & { _created: Array<Record<string, unknown>>; user: { findMany: ReturnType<typeof vi.fn> } };
  }

  it("notifies every owner and admin by username", async () => {
    const prisma = ownersStub(["stefan", "romain"]);
    await notifyOwnersAndAdmins(prisma, "Update rolled back", "It is running the previous version.");
    expect(mqttPublish.mock.calls.map((c) => c[0])).toEqual([
      "droplet/notifications/stefan",
      "droplet/notifications/romain",
    ]);
    expect(prisma._created.map((r) => r.username)).toEqual(["stefan", "romain"]);
  });

  it("🔴 a refused recipient is skipped and logged; the ones after it are still told", async () => {
    const prisma = ownersStub([LEGACY, "romain"]);
    await expect(
      notifyOwnersAndAdmins(prisma, "Update rolled back", "It is running the previous version."),
    ).resolves.toEqual({ notified: ["romain"], failed: [LEGACY] });
    expect(mqttPublish.mock.calls.map((c) => c[0])).toEqual(["droplet/notifications/romain"]);
    expect(prisma._created.map((r) => r.username)).toEqual(["romain"]);
  });
});

// ── WARP-2804: record, then deliver ─────────────────────────────────────────
//
// The row exists before any transport, so the toast and the push can carry its
// id — which is what lets a client acknowledge the notification it shows. A
// crash mid-send leaves a queued row the user can find, never a toast with no
// row behind it.
describe("WARP-2804 — sendNotification records the row, then delivers it", () => {
  it("the row is created BEFORE anything is published", async () => {
    const prisma = makePushingPrismaStub();
    await sendNotification(prisma, PARKED);
    const created = (prisma.notificationLog.create as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(mqttPublish.mock.invocationCallOrder[0]!).toBeGreaterThan(created);
    expect(webpushSend.mock.invocationCallOrder[0]!).toBeGreaterThan(created);
  });

  it("the toast carries the row's id, and the push carries it as notificationId", async () => {
    const prisma = makePushingPrismaStub();
    const result = await sendNotification(prisma, PARKED);
    expect(result.id).toBe(prisma._created[0]!.id);
    const toast = mqttPublish.mock.calls[0]![1] as Record<string, unknown>;
    expect(toast.id).toBe(result.id);
    const push = JSON.parse(String((webpushSend.mock.calls[0] as unknown[])[1]));
    expect(push.notificationId).toBe(result.id);
  });

  it("one row per send: the outcome is stamped on the recorded row, not written as a second one", async () => {
    const prisma = makePushingPrismaStub();
    await sendNotification(prisma, PARKED);
    expect(prisma._created).toHaveLength(1);
    expect(prisma._created[0]).toMatchObject({ channels: "toast,push", pushOutcome: "sent", error: null });
    expect(prisma._created[0]!.deliveredAt).toBeInstanceOf(Date);
    // A fresh row is unread.
    expect(prisma._created[0]!.ackState).toBe("unacked");
  });

  it("a dispatchToUser throw leaves the row stamped `failed`, rather than no row", async () => {
    const prisma = makePushingPrismaStub();
    (prisma as any).pushSubscription.findMany.mockRejectedValueOnce(new Error("db down"));
    const result = await sendNotification(prisma, PARKED);
    expect(prisma._created).toHaveLength(1);
    expect(prisma._created[0]).toMatchObject({ id: result.id, pushOutcome: "failed", channels: "toast" });
  });

  it("a failed row create publishes nothing and pushes nothing", async () => {
    const prisma = makePushingPrismaStub();
    (prisma.notificationLog.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    await expect(sendNotification(prisma, PARKED)).rejects.toThrow(/db down/);
    expect(mqttPublish).not.toHaveBeenCalled();
    expect(webpushSend).not.toHaveBeenCalled();
  });

  it("a stamp that cannot be written is logged, not thrown: the notification already went out", async () => {
    const prisma = makePrismaStub();
    (prisma.notificationLog.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db blip"));
    const result = await sendNotification(prisma, { username: "alice", kind: "reminder", title: "Standup" });
    expect(result).toMatchObject({ delivered: true, channels: ["toast"] });
    // The row stays unread and findable, and says its outcome was never
    // recorded — the claim's honest trace, never "queued" (which a retry
    // would read as "not sent yet" and send again).
    expect(prisma._created[0]).toMatchObject({
      channels: "",
      deliveredAt: null,
      error: "delivery: outcome_unknown",
      ackState: "unacked",
    });
  });

  // Review F2 — once the row is committed, the caller must not see a throw:
  // brain-notify re-sends on a throw (a duplicate, the first one orphaned
  // unread), and backup-health / tls-notify / filing-digest de-duplicate on
  // the row existing (so the alert is never re-sent — "backups stopped"
  // reaches nobody).
  it("MUTATION: never re-reads its own row — a read that fails after the commit costs nothing", async () => {
    const prisma = makePushingPrismaStub();
    (prisma.notificationLog.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db blip"));
    const result = await sendNotification(prisma, PARKED);
    expect(result).toMatchObject({ delivered: true, channels: ["toast", "push"] });
    expect(prisma._created).toHaveLength(1);
    expect(mqttPublish).toHaveBeenCalledTimes(1);
    expect(prisma._created[0]).toMatchObject({ channels: "toast,push", pushOutcome: "sent" });
  });

  it("after the commit, no bookkeeping failure throws: a claim and a stamp that both fail still deliver", async () => {
    const prisma = makePrismaStub();
    (prisma.notificationLog.updateMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    (prisma.notificationLog.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const result = await sendNotification(prisma, { username: "alice", kind: "system", title: "Backups stopped" });
    expect(result).toMatchObject({ delivered: true, channels: ["toast"] });
    expect(prisma._created).toHaveLength(1);
    expect(mqttPublish).toHaveBeenCalledTimes(1);
  });
});

// Review F8 — delivery by id is idempotent. A retry (P3 re-driving a row after
// a crash, a double call) must never re-publish the toast, re-push, or
// overwrite the first stamp. The guard is a CLAIM: the one update that moves a
// row out of "queued" before any transport, so two callers cannot both win.
describe("WARP-2804 — delivery is claimed: a retry by id is a no-op", () => {
  it("MUTATION: a second deliverNotification publishes nothing, pushes nothing and keeps the first stamp", async () => {
    const prisma = makePushingPrismaStub();
    const { id } = await recordNotification(prisma, PARKED);
    const first = await deliverNotification(prisma, id);
    const stamped = { ...prisma._created[0] };
    const again = await deliverNotification(prisma, id);
    expect(first).toMatchObject({ delivered: true, channels: ["toast", "push"] });
    expect(again).toEqual({ id, channels: [], delivered: false, skipped: "already_delivered" });
    expect(mqttPublish).toHaveBeenCalledTimes(1);
    expect(webpushSend).toHaveBeenCalledTimes(1);
    expect(prisma._created[0]).toEqual(stamped);
  });

  it("two concurrent deliveries of one row publish once", async () => {
    const prisma = makePushingPrismaStub();
    const { id } = await recordNotification(prisma, PARKED);
    const results = await Promise.all([deliverNotification(prisma, id), deliverNotification(prisma, id)]);
    expect(results.filter((r) => r.skipped === "already_delivered")).toHaveLength(1);
    expect(mqttPublish).toHaveBeenCalledTimes(1);
    expect(webpushSend).toHaveBeenCalledTimes(1);
  });

  it("a delivery whose stamp was lost is not re-sent (outcome_unknown is not 'queued')", async () => {
    const prisma = makePrismaStub();
    (prisma.notificationLog.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db blip"));
    const { id } = await sendNotification(prisma, { username: "alice", kind: "reminder", title: "Standup" });
    expect(await deliverNotification(prisma, id)).toMatchObject({ skipped: "already_delivered" });
    expect(mqttPublish).toHaveBeenCalledTimes(1);
  });

  it("an activity-notify row whose toast already went out (channels set, pushOutcome NULL) is not re-sent", async () => {
    const prisma = makePrismaStub();
    const { id } = await recordNotification(prisma, { username: "alice", kind: "event", title: "Assigned" });
    Object.assign(prisma._created[0]!, { channels: "toast", deliveredAt: new Date() });
    expect(await deliverNotification(prisma, id)).toMatchObject({ skipped: "already_delivered" });
    expect(mqttPublish).not.toHaveBeenCalled();
  });

  it("a claim that cannot be written still delivers (losing the notification is worse than a rare duplicate)", async () => {
    const prisma = makePrismaStub();
    const { id } = await recordNotification(prisma, { username: "alice", kind: "system", title: "x" });
    (prisma.notificationLog.updateMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db blip"));
    const result = await deliverNotification(prisma, id);
    expect(result).toMatchObject({ delivered: true, channels: ["toast"] });
    expect(prisma._created[0]).toMatchObject({ channels: "toast", error: null });
  });
});

describe("WARP-2804 — deliverNotification(prisma, id)", () => {
  it("delivers what the ROW says, by id, to the row's recipient", async () => {
    const prisma = makePushingPrismaStub();
    const { id } = await recordNotification(prisma, PARKED);
    const result = await deliverNotification(prisma, id, { tag: PARKED.tag });
    expect(result).toMatchObject({ id, channels: ["toast", "push"], delivered: true });
    expect(mqttPublish).toHaveBeenCalledWith(
      "droplet/notifications/romain",
      expect.objectContaining({ id, kind: "ai", title: PARKED.title, body: PARKED.body, url: PARKED.url, data: PARKED.data }),
    );
    const push = JSON.parse(String((webpushSend.mock.calls[0] as unknown[])[1]));
    expect(push).toEqual({
      title: PARKED.title,
      body: PARKED.body,
      url: PARKED.url,
      data: PARKED.data,
      tag: PARKED.tag,
      notificationId: id,
    });
    expect(prisma._created[0]).toMatchObject({ id, channels: "toast,push", pushOutcome: "sent" });
  });

  it("throws when the row cannot be read — and publishes nothing", async () => {
    const prisma = makePushingPrismaStub();
    await expect(deliverNotification(prisma, "log-missing")).rejects.toThrow(/notification_not_found/);
    expect(mqttPublish).not.toHaveBeenCalled();
    expect(webpushSend).not.toHaveBeenCalled();
  });

  it("never throws on transport: MQTT down and push throwing still stamp the row", async () => {
    const prisma = makePrismaStub(); // no pushSubscription delegate: the push leg throws
    const { id } = await recordNotification(prisma, { username: "alice", kind: "system", title: "x" });
    mqttPublish.mockImplementationOnce(() => {
      throw new Error("mqtt down");
    });
    const result = await deliverNotification(prisma, id);
    expect(result.delivered).toBe(false);
    expect(prisma._created[0]).toMatchObject({ channels: "", deliveredAt: null, pushOutcome: "failed" });
    expect(String(prisma._created[0]!.error)).toMatch(/toast: mqtt_unavailable/);
  });

  // Review F5 — the tag is checked ON ITS OWN. A bad tag used to strip the
  // row's valid url/data too: the toast lost its Open action and the push
  // opened /cameras.
  it("MUTATION: a bad tag drops ONLY the tag — url and data still reach the toast and the push — and the row says invalid_tag", async () => {
    const prisma = makePushingPrismaStub();
    const { id } = await recordNotification(prisma, PARKED);
    const result = await deliverNotification(prisma, id, { tag: "has space" });
    expect(result.channels).toEqual(["toast", "push"]);
    const toast = mqttPublish.mock.calls[0]![1] as Record<string, unknown>;
    expect(toast).toMatchObject({ url: PARKED.url, data: PARKED.data });
    const push = JSON.parse(String((webpushSend.mock.calls[0] as unknown[])[1]));
    expect(push).toMatchObject({ url: PARKED.url, data: PARKED.data });
    expect(push.tag).toBeUndefined();
    expect(prisma._created[0]!.error).toBe("delivery: invalid_tag");
  });

  it("a per-incident tag (`incident/42`) is a valid collapse key and reaches the push", async () => {
    const prisma = makePushingPrismaStub();
    await sendNotification(prisma, { ...PARKED, tag: "incident/42" });
    const push = JSON.parse(String((webpushSend.mock.calls[0] as unknown[])[1]));
    expect(push.tag).toBe("incident/42");
    expect(prisma._created[0]!.error).toBeNull();
  });

  it.each(["has space", "a\\b", "x".repeat(129), "", "tag\n2", "tag?x=1"])(
    "the tag %j is still refused by sendNotification (a caller bug)",
    async (tag) => {
      const prisma = makePrismaStub();
      await expect(sendNotification(prisma, { ...PARKED, tag })).rejects.toThrow(/tag/);
      expect(prisma._created).toHaveLength(0);
    },
  );

  it("accepts a priority (WARP-2978 fills it) and ignores it here", async () => {
    const prisma = makePrismaStub();
    const { id } = await recordNotification(prisma, { username: "alice", kind: "event", title: "x" });
    await expect(deliverNotification(prisma, id, { priority: "alert" })).resolves.toMatchObject({ id });
  });
});
