/**
 * WARP-2904 — web push is an off-LAN channel: `dispatchToUser`, the one dial
 * site, reads the `web_push` gate on every call BEFORE loading a subscription,
 * re-checks every stored endpoint, and audits every dial and refusal.
 *
 * This file is the guard `check-egress-allowlist.py` cannot be: the push
 * destination is a database row, so no repo literal exists for the CI gate to
 * see. Mutation-tested — removing the gate call from `dispatchToUser` turns
 * the "gate off" cases red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({
  default: {
    sendNotification: (...a: unknown[]) => sendNotification(...a),
    setVapidDetails: vi.fn(),
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
  },
}));

// DNS is mocked: every name resolves public unless a test says otherwise.
const lookupMock = vi.fn(async () => [{ address: "142.250.0.1", family: 4 }]);
vi.mock("node:dns/promises", () => ({ lookup: (...a: unknown[]) => lookupMock(...(a as [])) }));

import { dispatchDetectionEvent, dispatchToUser } from "../services/push-dispatch.service.js";
import { NotificationRecipientError } from "../services/notification-recipient.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

const audited: RecordParams[] = [];

// A real push-service host: since the review fix, only those are dialled.
const GOOD = "https://fcm.googleapis.com/fcm/send/abc123";

function sub(endpoint: string) {
  return { id: endpoint, userId: "alice", endpoint, p256dhKey: "p".repeat(40), authKey: "a".repeat(20) };
}

function makePrisma(opts: {
  gate: "on" | "off" | "missing" | "throws";
  subs?: ReturnType<typeof sub>[];
}) {
  return {
    offLanAllowlistChannel: {
      findUnique: vi.fn(async () => {
        if (opts.gate === "throws") throw new Error("db unreachable");
        if (opts.gate === "missing") return null;
        return { key: "web_push", enabled: opts.gate === "on" };
      }),
    },
    pushSubscription: {
      findMany: vi.fn(async () => opts.subs ?? []),
      count: vi.fn(async () => (opts.subs ?? []).length),
      deleteMany: vi.fn(async ({ where }: { where: { endpoint: { in: string[] } } }) => ({
        count: where.endpoint.in.length,
      })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  lookupMock.mockImplementation(async () => [{ address: "142.250.0.1", family: 4 }]);
  audited.length = 0;
  _setActivityRecorderForTests(
    {
      record: async (p: RecordParams) => {
        audited.push(p);
        return null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    null,
  );
});

afterEach(() => {
  _setActivityRecorderForTests(null, null);
});

/** recordActivity is fire-and-forget; let the microtasks drain. */
const flush = () => new Promise((r) => setImmediate(r));

describe("dispatchToUser — web_push off-LAN gate (fail-closed)", () => {
  for (const gate of ["off", "missing", "throws"] as const) {
    it(`gate ${gate}: never dials, never loads, prunes or bumps a subscription`, async () => {
      const prisma = makePrisma({ gate, subs: [sub(GOOD)] });
      const result = await dispatchToUser(prisma, "alice", { title: "t", body: "b" });

      expect(result).toEqual({ sent: 0, pruned: 0, attempted: 0, refused: "egress_disabled" });
      expect(sendNotification).not.toHaveBeenCalled();
      expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
      expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
      expect(prisma.pushSubscription.updateMany).not.toHaveBeenCalled();

      await flush();
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({
        kind: "network",
        sub: "web_push",
        refs: { channel: "web_push", outcome: "refused_gate", userId: "alice" },
      });
    });
  }

  it("gate off with NO subscriptions writes no audit row (push ships off; no warning per notification)", async () => {
    const prisma = makePrisma({ gate: "off", subs: [] });
    const result = await dispatchToUser(prisma, "alice", { title: "t", body: "b" });
    expect(result.refused).toBe("egress_disabled");
    await flush();
    expect(audited).toHaveLength(0);
  });

  it("passes a dial timeout so an endpoint that never answers cannot stall the caller", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const prisma = makePrisma({ gate: "on", subs: [sub(GOOD)] });
    await dispatchToUser(prisma, "alice", { title: "t", body: "b" });
    expect(sendNotification.mock.calls[0][2]).toMatchObject({ timeout: 10_000 });
  });

  it("reads the gate by the web_push enum key", async () => {
    const prisma = makePrisma({ gate: "off" });
    await dispatchToUser(prisma, "alice", { title: "t", body: "b" });
    expect(prisma.offLanAllowlistChannel.findUnique).toHaveBeenCalledWith({
      where: { key: "web_push" },
    });
  });

  it("gate on: dials, and the audit row carries the HOST only — never the endpoint or payload", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const prisma = makePrisma({ gate: "on", subs: [sub(GOOD)] });
    const result = await dispatchToUser(prisma, "alice", { title: "secret title", body: "secret body" });

    expect(result).toEqual({ sent: 1, pruned: 0, attempted: 1 });
    expect(sendNotification).toHaveBeenCalledOnce();
    await flush();
    expect(audited).toHaveLength(1);
    expect(audited[0].refs).toEqual({
      channel: "web_push",
      outcome: "allowed",
      userId: "alice",
      dst: "fcm.googleapis.com",
    });
    const serialized = JSON.stringify(audited[0]);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("secret");
  });

  it("gate on, no rows: attempted 0 and no refusal (the no_subscribers case)", async () => {
    const prisma = makePrisma({ gate: "on", subs: [] });
    const result = await dispatchToUser(prisma, "alice", { title: "t", body: "b" });
    expect(result).toEqual({ sent: 0, pruned: 0, attempted: 0 });
  });
});

describe("dispatchToUser — endpoint re-checked at dial time", () => {
  for (const [label, endpoint] of [
    ["private address", "https://192.168.1.10/push"],
    ["loopback", "https://127.0.0.1:8443/push"],
    ["plain http", "http://fcm.googleapis.com/fcm/send/x"],
    // The review's bypass: WHATWG says host "127.0.0.1;.evil.example",
    // web-push's legacy url.parse dials 127.0.0.1.
    ["semicolon parser-split", "https://127.0.0.1;.fcm.googleapis.com/push/abc"],
    ["userinfo", "https://fcm.googleapis.com@127.0.0.1/x"],
    ["non-default port", "https://fcm.googleapis.com:8443/fcm/send/x"],
    ["non-push public host", "https://push.vendor.example.com/send/x"],
  ] as const) {
    it(`a pre-existing ${label} row is skipped and deleted, never dialled`, async () => {
      sendNotification.mockResolvedValue({ statusCode: 201 });
      const prisma = makePrisma({ gate: "on", subs: [sub(endpoint), sub(GOOD)] });
      const result = await dispatchToUser(prisma, "alice", { title: "t", body: "b" });

      expect(sendNotification).toHaveBeenCalledOnce();
      expect(sendNotification.mock.calls[0][0]).toMatchObject({ endpoint: GOOD });
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { endpoint: { in: [endpoint] } },
      });
      expect(result).toEqual({ sent: 1, pruned: 1, attempted: 1 });
      await flush();
      expect(audited.map((a) => (a.refs as { outcome: string }).outcome).sort()).toEqual([
        "allowed",
        "refused_endpoint",
      ]);
    });
  }
});

describe("dispatchToUser — dials exactly the vetted host", () => {
  it("a push-service name that resolves inside the boundary is refused and pruned", async () => {
    lookupMock.mockImplementation(async () => [{ address: "10.0.0.5", family: 4 }]);
    const prisma = makePrisma({ gate: "on", subs: [sub(GOOD)] });
    const result = await dispatchToUser(prisma, "alice", { title: "t", body: "b" });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, pruned: 1, attempted: 0 });
  });

  it("hands web-push the normalised URL, whose legacy-parsed host is the audited host", async () => {
    const { parse } = await import("node:url");
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const wns = "https://wns2-by3p.notify.windows.com/w/?token=abc";
    const prisma = makePrisma({ gate: "on", subs: [sub(wns)] });
    await dispatchToUser(prisma, "alice", { title: "t", body: "b" });
    const dialled = (sendNotification.mock.calls[0][0] as { endpoint: string }).endpoint;
    expect(dialled).toBe(wns);
    await flush();
    expect(parse(dialled).hostname).toBe((audited[0].refs as { dst: string }).dst);
  });

  it("dials the rebuilt URL, never the raw row", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const prisma = makePrisma({ gate: "on", subs: [sub("https://FCM.GoogleAPIs.com/fcm/send/x")] });
    await dispatchToUser(prisma, "alice", { title: "t", body: "b" });
    expect((sendNotification.mock.calls[0][0] as { endpoint: string }).endpoint).toBe(
      "https://fcm.googleapis.com/fcm/send/x",
    );
  });
});

// ── WARP-2911 ───────────────────────────────────────────────────────────────

const USER_ID = "3b7d0195-6c1e-4f2a-9d8b-2a4c6e8f0a1b";

describe("WARP-2911 — dispatchToUser refuses a User.id-shaped recipient", () => {
  // `dispatchToUser` has direct callers (the camera fan-out, the push test
  // button) that never pass through sendNotification's check — commit 5's
  // camera bug lived in exactly one of them.
  for (const gate of ["on", "off"] as const) {
    it(`gate ${gate}: throws before the gate, a subscription, a dial or an audit row`, async () => {
      const prisma = makePrisma({ gate, subs: [sub(GOOD)] });
      const err = await dispatchToUser(prisma, USER_ID, { title: "t", body: "b" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotificationRecipientError);
      expect(err).toMatchObject({ code: "NOTIFICATION_RECIPIENT_IS_ID" });
      expect(prisma.offLanAllowlistChannel.findUnique).not.toHaveBeenCalled();
      expect(prisma.pushSubscription.count).not.toHaveBeenCalled();
      expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
      await flush();
      expect(audited).toHaveLength(0);
    });
  }

  it.each(["dev", "_service:mcp", "alice"])("%s is a username and is dialled", async (username) => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const prisma = makePrisma({ gate: "on", subs: [sub(GOOD)] });
    await expect(dispatchToUser(prisma, username, { title: "t", body: "b" })).resolves.toMatchObject({ sent: 1 });
    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({ where: { username } });
  });
});

/** A box with one camera, and the given people interested in its `person`
 *  events — each an owner/admin (so the grant check passes) with DISTINCT,
 *  UUID-shaped `User.id` and a username. */
function detectionPrisma(opts: {
  gate: "on" | "off";
  people: Array<{ id: string; username: string; subscribed: boolean }>;
}) {
  const base = makePrisma({ gate: opts.gate });
  const subscribed = new Set(opts.people.filter((p) => p.subscribed).map((p) => p.username));
  base.camera = {
    findUnique: vi.fn(async () => ({ id: "cam-1", name: "front_door", displayName: "Front door" })),
  };
  base.cameraNotificationPref = {
    findMany: vi.fn(async () => opts.people.map((p) => ({ userId: p.id, cameraId: "cam-1", onPerson: true }))),
  };
  base.user = {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      opts.people
        .filter((p) => where.id.in.includes(p.id))
        .map((p) => ({ id: p.id, role: "admin", username: p.username })),
    ),
  };
  base.pushSubscription.count = vi.fn(async ({ where }: { where: { username: { in: string[] } } }) =>
    where.username.in.filter((u) => subscribed.has(u)).length,
  );
  base.pushSubscription.findMany = vi.fn(async ({ where }: { where: { username: string } }) =>
    subscribed.has(where.username) ? [sub(`https://fcm.googleapis.com/fcm/send/${where.username}`)] : [],
  );
  return base;
}

const EVENT = { eventId: "ev-1", cameraName: "front_door", label: "person", score: 0.9 };
const PEOPLE = [
  { id: "0d9c5c1e-2f4a-4b6d-8e10-3a5c7e9b1d2f", username: "stefan", subscribed: true },
  { id: "7a1b3c5d-9e0f-4a2b-8c4d-6e8f0a2b4c6d", username: "romain", subscribed: true },
  { id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b", username: "sam", subscribed: false },
];

describe("WARP-2911 — a camera detection reads the web_push gate ONCE", () => {
  it("🔴 gate off: ONE refused_gate audit row per event, however many recipients are subscribed; nothing dialled", async () => {
    // `web_push` ships off, and detections are the most frequent sender. One
    // signed warning per subscribed recipient per detection would bury
    // /admin/audit; one per event says the same thing.
    const prisma = detectionPrisma({ gate: "off", people: PEOPLE });
    await dispatchDetectionEvent(prisma, EVENT);
    await flush();

    expect(prisma.offLanAllowlistChannel.findUnique).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      kind: "network",
      sub: "web_push",
      refs: { channel: "web_push", outcome: "refused_gate", source: "camera_detection", camera: "front_door", subscriptions: 2 },
    });
    // No person is named on the event row, and no endpoint is carried.
    expect(JSON.stringify(audited[0])).not.toMatch(/stefan|romain|fcm\.googleapis/);
  });

  it("gate off and nobody subscribed: no audit row at all (push ships off)", async () => {
    const prisma = detectionPrisma({
      gate: "off",
      people: PEOPLE.map((p) => ({ ...p, subscribed: false })),
    });
    await dispatchDetectionEvent(prisma, EVENT);
    await flush();
    expect(audited).toHaveLength(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("gate on: every allowed recipient is dialled on their USERNAME", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const prisma = detectionPrisma({ gate: "on", people: PEOPLE });
    await dispatchDetectionEvent(prisma, EVENT);
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
    const keys = prisma.pushSubscription.findMany.mock.calls.map(
      (c: [{ where: { username: string } }]) => c[0].where.username,
    );
    expect(keys.sort()).toEqual(["romain", "sam", "stefan"]);
  });
});
