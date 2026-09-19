import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mock MQTT before importing the SUT. The smart-home surface is Matter
// (matter.service.ts); push delivery to phones rides on the Web Push
// pipeline in services/push-dispatch.service.ts.
const mqttPublish = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  publish: (...a: unknown[]) => mqttPublish(...a),
}));

// WARP-2909 — web push is mocked at the transport so the PAYLOAD it is handed
// can be asserted; the real `dispatchToUser` still runs in front of it.
const { webpushSend } = vi.hoisted(() => ({
  webpushSend: vi.fn(async (_sub: unknown, _body: string, _opts?: unknown) => ({ statusCode: 201 })),
}));
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "test-public", privateKey: "test-private" }),
    setVapidDetails: vi.fn(),
    sendNotification: (sub: unknown, body: string, opts?: unknown) => webpushSend(sub, body, opts),
  },
}));

import {
  assertNotificationData,
  assertNotificationLink,
  assertNotificationTag,
  listRecentNotifications,
  publishNotificationToast,
  recordNotification,
  sendNotification,
  type DispatchInput,
} from "../services/notifications.service.js";

function makePrismaStub(opts: { pushSubscriptions?: Array<{ endpoint: string }> } = {}) {
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
    // WARP-2909 — only when a test opts in: the default stub has NO
    // `pushSubscription` delegate, so `dispatchToUser` throws exactly as it
    // does on a box with push misconfigured (the WARP-2752 cases rely on it).
    ...(opts.pushSubscriptions
      ? {
          systemFlag: {
            findUnique: vi.fn(async () => ({
              valueJson: { publicKey: "test-public", privateKey: "test-private" },
            })),
          },
          pushSubscription: {
            findMany: vi.fn(async () =>
              opts.pushSubscriptions!.map((s, i) => ({
                id: `sub-${i + 1}`,
                endpoint: s.endpoint,
                p256dhKey: "p",
                authKey: "a",
              })),
            ),
            deleteMany: vi.fn(async () => ({ count: 0 })),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
        }
      : {}),
    _created: created,
  };
  return stub as unknown as PrismaClient & { _created: typeof created };
}

/** Every key at every depth of a payload — the redemption-contract pin walks
 *  the whole object, not just the top level. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

/** The exact DispatchInput the agent-run worker sends at park (WARP-2909). */
const PARKED_RUN: DispatchInput = {
  userId: "romain",
  kind: "ai",
  title: "Approval needed: delete_file",
  body: "Background run wants to run delete_file. Open the run to approve or deny it. Nothing has been done yet.",
  url: "/admin/audit?run=run-1",
  data: { agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true },
  tag: "agent-run:run-1",
};

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
      userId: "alice",
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
      userId: "alice",
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

// ── WARP-2909 — a notification carries a deep link ──────────────────────────

describe("assertNotificationLink (WARP-2909)", () => {
  it("accepts a same-origin dashboard path", () => {
    expect(() => assertNotificationLink("/admin/audit?run=run-1")).not.toThrow();
    expect(() => assertNotificationLink("/")).not.toThrow();
    expect(() => assertNotificationLink("/cameras/front_door")).not.toThrow();
  });

  it.each([
    ["an https scheme", "https://example.invalid/admin"],
    ["a javascript scheme", "javascript:alert(1)"],
    ["a mailto scheme", "mailto:owner@example.invalid"],
    ["a bare relative path", "admin/audit"],
  ])("rejects %s", (_label, url) => {
    expect(() => assertNotificationLink(url)).toThrow(/^invalid_link/);
  });

  it("rejects a protocol-relative //host/… url", () => {
    expect(() => assertNotificationLink("//example.invalid/admin")).toThrow(/^invalid_link/);
  });

  it("rejects a backslash anywhere in the path", () => {
    expect(() => assertNotificationLink("/admin\\audit")).toThrow(/^invalid_link/);
    expect(() => assertNotificationLink("/\\example.invalid")).toThrow(/^invalid_link/);
  });

  it.each([
    ["CR", "/admin\r?run=1"],
    ["LF", "/admin\n?run=1"],
    ["NUL", "/admin\0?run=1"],
  ])("rejects a %s control character", (_label, url) => {
    expect(() => assertNotificationLink(url)).toThrow(/^invalid_link/);
  });

  it("rejects anything over 512 characters, and the empty string", () => {
    expect(() => assertNotificationLink("/" + "a".repeat(511))).not.toThrow();
    expect(() => assertNotificationLink("/" + "a".repeat(512))).toThrow(/^invalid_link/);
    expect(() => assertNotificationLink("")).toThrow(/^invalid_link/);
  });
});

describe("assertNotificationTag (WARP-2909)", () => {
  it("accepts the agent-run tag shape and rejects whitespace, slashes and >128 chars", () => {
    expect(() => assertNotificationTag("agent-run:run-1")).not.toThrow();
    expect(() => assertNotificationTag("event-abc.1_2")).not.toThrow();
    expect(() => assertNotificationTag("agent run")).toThrow(/^invalid_tag/);
    expect(() => assertNotificationTag("agent/run")).toThrow(/^invalid_tag/);
    expect(() => assertNotificationTag("")).toThrow(/^invalid_tag/);
    expect(() => assertNotificationTag("a".repeat(129))).toThrow(/^invalid_tag/);
  });
});

describe("assertNotificationData (WARP-2909)", () => {
  it("accepts a small flat record of strings, numbers and booleans", () => {
    expect(() =>
      assertNotificationData({ agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true, n: 2 }),
    ).not.toThrow();
  });

  it("rejects a nested object", () => {
    expect(() => assertNotificationData({ a: { b: 1 } } as never)).toThrow(/^invalid_data: .*flat/);
  });

  it("rejects an array value", () => {
    expect(() => assertNotificationData({ a: [1, 2] } as never)).toThrow(/^invalid_data: .*flat/);
  });

  it("rejects anything over 1 KB serialised", () => {
    expect(() => assertNotificationData({ a: "x".repeat(1000) })).not.toThrow();
    expect(() => assertNotificationData({ a: "x".repeat(1024) })).toThrow(/^invalid_data: .*1 KB/);
  });

  // One test per forbidden key: `url` because sw.js spreads `data` over the
  // validated url; the other four because a notification payload is copied to
  // third-party push services and OS notification stores.
  it("refuses the key `url`", () => {
    expect(() => assertNotificationData({ url: "/x" })).toThrow(/^invalid_data: .*`url`/);
  });
  it("refuses the key `token`", () => {
    expect(() => assertNotificationData({ token: "t" })).toThrow(/^invalid_data: .*`token`/);
  });
  it("refuses the key `confirmationToken`", () => {
    expect(() => assertNotificationData({ confirmationToken: "t" })).toThrow(/^invalid_data: .*`confirmationToken`/);
  });
  it("refuses the key `bindingHash`", () => {
    expect(() => assertNotificationData({ bindingHash: "h" })).toThrow(/^invalid_data: .*`bindingHash`/);
  });
  it("refuses the key `pendingBindingHash`", () => {
    expect(() => assertNotificationData({ pendingBindingHash: "h" })).toThrow(/^invalid_data: .*`pendingBindingHash`/);
  });
});

describe("sendNotification — deep link (WARP-2909)", () => {
  it("a bad url THROWS before the toast and before the row: nothing published, nothing written", async () => {
    const prisma = makePrismaStub();
    await expect(
      sendNotification(prisma, { userId: "alice", kind: "ai", title: "x", url: "https://example.invalid/" }),
    ).rejects.toThrow(/^invalid_link/);
    expect((prisma as any)._created).toEqual([]);
    expect(mqttPublish).not.toHaveBeenCalled();
  });

  it("bad data and a bad tag throw the same way", async () => {
    const prisma = makePrismaStub();
    await expect(
      sendNotification(prisma, { userId: "alice", kind: "ai", title: "x", url: "/x", data: { token: "t" } }),
    ).rejects.toThrow(/^invalid_data: .*`token`/);
    await expect(
      sendNotification(prisma, { userId: "alice", kind: "ai", title: "x", url: "/x", tag: "no spaces" }),
    ).rejects.toThrow(/^invalid_tag/);
    expect((prisma as any)._created).toEqual([]);
    expect(mqttPublish).not.toHaveBeenCalled();
  });

  it("the toast carries url, data and tag when set, and the row persists url and data", async () => {
    const prisma = makePrismaStub();
    await sendNotification(prisma, PARKED_RUN);
    expect(mqttPublish).toHaveBeenCalledWith(
      "droplet/notifications/romain",
      expect.objectContaining({
        kind: "ai",
        url: "/admin/audit?run=run-1",
        data: { agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true },
        tag: "agent-run:run-1",
      }),
    );
    const row = (prisma as any)._created[0];
    expect(row.url).toBe("/admin/audit?run=run-1");
    expect(row.data).toEqual({ agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true });
  });

  it("without a link the toast has no url/data/tag keys and the row's url is null", async () => {
    const prisma = makePrismaStub();
    await sendNotification(prisma, { userId: "alice", kind: "reminder", title: "Standup" });
    const payload = mqttPublish.mock.calls[0]![1] as Record<string, unknown>;
    expect("url" in payload).toBe(false);
    expect("data" in payload).toBe(false);
    expect("tag" in payload).toBe(false);
    expect((prisma as any)._created[0].url).toBeNull();
  });

  it("web push receives { title, body, url, data, tag } through dispatchToUser", async () => {
    const prisma = makePrismaStub({ pushSubscriptions: [{ endpoint: "sub-endpoint-1" }] });
    const result = await sendNotification(prisma, PARKED_RUN);
    expect(result.channels).toEqual(["toast", "push"]);
    expect(webpushSend).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(webpushSend.mock.calls[0]![1])) as Record<string, unknown>;
    expect(sent).toEqual({
      title: PARKED_RUN.title,
      body: PARKED_RUN.body,
      url: "/admin/audit?run=run-1",
      data: { agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true },
      tag: "agent-run:run-1",
    });
  });

  it("no default tag is derived: a call without one sends tag: undefined", async () => {
    const prisma = makePrismaStub({ pushSubscriptions: [{ endpoint: "sub-endpoint-1" }] });
    await sendNotification(prisma, { userId: "alice", kind: "reminder", title: "Standup", url: "/reminders" });
    const sent = JSON.parse(String(webpushSend.mock.calls[0]![1])) as Record<string, unknown>;
    expect(sent.tag).toBeUndefined();
    expect(Object.keys(sent)).not.toContain("tag");
    expect(sent.url).toBe("/reminders");
  });

  // The redemption contract: nothing in any hop of a parked run's notification
  // can stand in for the confirm route. The token is minted at human attention
  // (docs/agent-runs-design.md §7); nothing exists at park time to leak, and
  // these three payloads are what a push service, an OS tray and the log keep.
  it("a parked run's toast, push and log row carry no token/hash/confirm key, and the url's only query key is `run`", async () => {
    const prisma = makePrismaStub({ pushSubscriptions: [{ endpoint: "sub-endpoint-1" }] });
    await sendNotification(prisma, PARKED_RUN);
    const toast = mqttPublish.mock.calls[0]![1];
    const push = JSON.parse(String(webpushSend.mock.calls[0]![1]));
    const row = (prisma as any)._created[0];
    for (const payload of [toast, push, row]) {
      expect(allKeys(payload).filter((k) => /token|hash|confirm/i.test(k))).toEqual([]);
      const url = new URL(String((payload as { url: string }).url), "http://localhost");
      expect([...url.searchParams.keys()]).toEqual(["run"]);
      expect(url.pathname).toBe("/admin/audit");
    }
  });
});

describe("publishNotificationToast — deep link (WARP-2909)", () => {
  it("never throws: a bad url drops url and data from the payload and records toast: invalid_link", () => {
    const out = publishNotificationToast({
      userId: "alice",
      kind: "event",
      title: "x",
      url: "//example.invalid/",
      data: { a: 1 },
    });
    expect(out.channels).toEqual(["toast"]);
    expect(out.errors).toContain("toast: invalid_link");
    const payload = mqttPublish.mock.calls[0]![1] as Record<string, unknown>;
    expect("url" in payload).toBe(false);
    expect("data" in payload).toBe(false);
  });

  it("a good url reaches the toast payload", () => {
    const out = publishNotificationToast({ userId: "alice", kind: "event", title: "x", url: "/projects/1" });
    expect(out.errors).toEqual([]);
    expect(mqttPublish.mock.calls[0]![1]).toMatchObject({ url: "/projects/1" });
  });
});

describe("recordNotification — deep link (WARP-2909)", () => {
  it("throws on a bad url BEFORE the row write", async () => {
    const prisma = makePrismaStub();
    await expect(
      recordNotification(prisma, { userId: "alice", kind: "event", title: "x", url: "javascript:alert(1)" }),
    ).rejects.toThrow(/^invalid_link/);
    expect(prisma.notificationLog.create).not.toHaveBeenCalled();
  });

  it("persists url and data on the queued row", async () => {
    const prisma = makePrismaStub();
    await recordNotification(prisma, { userId: "alice", kind: "event", title: "x", url: "/x", data: { k: "v" } });
    expect((prisma as any)._created[0]).toMatchObject({ url: "/x", data: { k: "v" }, channels: "" });
  });
});

describe("listRecentNotifications — deep link (WARP-2909)", () => {
  it("returns url and data for a row written with them", async () => {
    const prisma = makePrismaStub();
    await sendNotification(prisma, PARKED_RUN);
    await sendNotification(prisma, { userId: "romain", kind: "reminder", title: "Standup" });
    const rows = await listRecentNotifications(prisma, "romain");
    expect(rows[1]).toMatchObject({
      url: "/admin/audit?run=run-1",
      data: { agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true },
    });
    expect(rows[0].url).toBeNull();
  });
});
