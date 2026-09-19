/**
 * WARP-2904 — `dispatchToUser` is the ONE dial site for web push, and the
 * `web_push` off-LAN gate is read there, on every call, before `findMany`.
 *
 * `scripts/check-egress-allowlist.py` cannot see a destination that lives in a
 * database row, so THIS FILE is the guard: with the gate false (or throwing)
 * `webpush.sendNotification` is never called, no PushSubscription row is
 * pruned, no `lastFiredAt` is bumped, and the refusal is audited. The
 * mutation rule applies — remove the gate read from `dispatchToUser` and the
 * first describe block must go red.
 *
 * No hostnames in this file: the egress gate extracts literals. Endpoints are
 * built from shapes (a public IP literal, a private IP literal, a plain-http
 * scheme) so nothing here can be mistaken for a destination.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { RecordParams } from "../services/activity.service.js";

const sendNotificationMock = vi.fn();
vi.mock("web-push", () => ({
  default: {
    sendNotification: (...a: unknown[]) => sendNotificationMock(...a),
    setVapidDetails: vi.fn(),
    generateVAPIDKeys: vi.fn(() => ({ publicKey: "pub", privateKey: "priv" })),
  },
}));

// Operator-pinned pair → `initPushDispatch` takes the synchronous env path and
// never touches SystemFlag, so the prisma stub needs no `systemFlag` delegate.
vi.mock("../config.js", () => ({
  config: {
    VAPID_PUBLIC_KEY: "pinned-public",
    VAPID_PRIVATE_KEY: "pinned-private",
    VAPID_CONTACT_EMAIL: "",
  },
}));

const gateMock = vi.fn<() => Promise<boolean>>();
vi.mock("../services/off-lan-gate.service.js", () => ({
  webPushGate: () => gateMock(),
}));

const recorded: RecordParams[] = [];
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn(async (p: RecordParams) => {
    recorded.push(p);
    return null;
  }),
}));

import { dispatchToUser } from "../services/push-dispatch.service.js";

// Endpoint SHAPES. A public unicast literal outside every blocked range, a
// loopback literal, an RFC1918 literal, and a plain-http public literal.
const PUBLIC_HTTPS = "https://203.0.113.10/wpush/abc";
const PUBLIC_HTTPS_2 = "https://203.0.113.11/wpush/def";
const LOOPBACK_HTTPS = "https://127.0.0.1/wpush/evil";
const PRIVATE_HTTPS = "https://192.168.1.20/wpush/lan";
const PUBLIC_HTTP = "http://203.0.113.12/wpush/plain";

function sub(endpoint: string) {
  return { id: `s-${endpoint.slice(-3)}`, userId: "owner", endpoint, p256dhKey: "p", authKey: "a" };
}

function makePrisma(rows: ReturnType<typeof sub>[]) {
  const stub = {
    pushSubscription: {
      findMany: vi.fn(async () => rows),
      deleteMany: vi.fn(async ({ where }: { where: { endpoint: { in: string[] } } }) => ({
        count: where.endpoint.in.length,
      })),
      updateMany: vi.fn(async () => ({ count: rows.length })),
    },
  };
  return stub as unknown as PrismaClient & typeof stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.length = 0;
  gateMock.mockResolvedValue(true);
});

describe("dispatchToUser — the web_push gate is read before anything is loaded (WARP-2904)", () => {
  it("gate false → nothing is loaded, nothing is dialled, nothing is pruned or bumped", async () => {
    gateMock.mockResolvedValue(false);
    const prisma = makePrisma([sub(PUBLIC_HTTPS)]);

    const result = await dispatchToUser(prisma, "owner", { title: "t", body: "b" });

    expect(result).toEqual({ sent: 0, pruned: 0, subscriptions: 0, refused: "egress_disabled" });
    expect(gateMock).toHaveBeenCalledTimes(1);
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(prisma.pushSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("gate throws → treated exactly like gate false (fail-closed at the dial site too)", async () => {
    gateMock.mockRejectedValue(new Error("gate exploded"));
    const prisma = makePrisma([sub(PUBLIC_HTTPS)]);

    const result = await dispatchToUser(prisma, "owner", { title: "t", body: "b" });

    expect(result.refused).toBe("egress_disabled");
    expect(result.sent).toBe(0);
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(prisma.pushSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("gate false → returns data, never throws (sendNotification's push block must stay best-effort)", async () => {
    gateMock.mockResolvedValue(false);
    const prisma = makePrisma([]);
    await expect(dispatchToUser(prisma, "owner", { title: "t", body: "b" })).resolves.toMatchObject({
      refused: "egress_disabled",
    });
  });

  it("a refusal writes ONE fail-soft ActivityRow: kind network, channel web_push, outcome refused_gate, the target username", async () => {
    gateMock.mockResolvedValue(false);
    const prisma = makePrisma([sub(PUBLIC_HTTPS)]);

    await dispatchToUser(prisma, "owner", { title: "t", body: "b" });

    expect(recorded).toHaveLength(1);
    const row = recorded[0];
    expect(row.kind).toBe("network");
    expect(row.severity).toBe("warn");
    expect(row.sub).toBe("push_egress");
    expect(row.actor).toEqual({ type: "system" });
    expect(row.refs).toMatchObject({ channel: "web_push", outcome: "refused_gate", userId: "owner" });
    // Never the payload, never an endpoint (the row had not even been read).
    expect(JSON.stringify(row)).not.toContain("wpush");
    expect(JSON.stringify(row)).not.toContain('"title"');
  });

  it("the gate is re-read on EVERY call — a flip to off takes effect on the next dispatch", async () => {
    const prisma = makePrisma([sub(PUBLIC_HTTPS)]);
    sendNotificationMock.mockResolvedValue(undefined);

    gateMock.mockResolvedValueOnce(true);
    await dispatchToUser(prisma, "owner", { title: "t", body: "b" });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);

    gateMock.mockResolvedValueOnce(false);
    await dispatchToUser(prisma, "owner", { title: "t", body: "b" });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(gateMock).toHaveBeenCalledTimes(2);
  });
});

describe("dispatchToUser — gate open (WARP-2904 audit + endpoint hardening)", () => {
  it("dials every public https subscription and audits each dial with the HOST only", async () => {
    const prisma = makePrisma([sub(PUBLIC_HTTPS), sub(PUBLIC_HTTPS_2)]);
    sendNotificationMock.mockResolvedValue(undefined);

    const result = await dispatchToUser(prisma, "owner", { title: "Standup", body: "10am" });

    expect(result).toEqual({ sent: 2, pruned: 0, subscriptions: 2 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    expect(prisma.pushSubscription.updateMany).toHaveBeenCalledTimes(1);

    const dials = recorded.filter((r) => (r.refs as { outcome?: string }).outcome === "sent");
    expect(dials).toHaveLength(2);
    for (const row of dials) {
      expect(row.kind).toBe("network");
      expect(row.severity).toBe("info");
      expect(row.sub).toBe("push_egress");
      expect(row.refs).toMatchObject({ channel: "web_push", userId: "owner" });
      const dst = (row.refs as { dst: string }).dst;
      expect(["203.0.113.10", "203.0.113.11"]).toContain(dst);
      // Host only — never the per-subscriber capability path, never the payload.
      const json = JSON.stringify(row);
      expect(json).not.toContain("/wpush/");
      expect(json).not.toContain("Standup");
      expect(json).not.toContain("10am");
    }
  });

  it("no subscriptions → { sent: 0, subscriptions: 0 }, no refused marker, no dial row", async () => {
    const prisma = makePrisma([]);
    const result = await dispatchToUser(prisma, "owner", { title: "t", body: "b" });
    expect(result).toEqual({ sent: 0, pruned: 0, subscriptions: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("a pre-existing private-address row is never dialled — skipped, pruned, audited as blocked_destination", async () => {
    const prisma = makePrisma([sub(LOOPBACK_HTTPS), sub(PRIVATE_HTTPS), sub(PUBLIC_HTTPS)]);
    sendNotificationMock.mockResolvedValue(undefined);

    const result = await dispatchToUser(prisma, "owner", { title: "t", body: "b" });

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock.mock.calls[0][0]).toMatchObject({ endpoint: PUBLIC_HTTPS });
    expect(result).toEqual({ sent: 1, pruned: 2, subscriptions: 3 });
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: { in: [LOOPBACK_HTTPS, PRIVATE_HTTPS] } },
    });
    // lastFiredAt is bumped only for the rows that were actually dialled.
    expect(prisma.pushSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner", endpoint: { notIn: [LOOPBACK_HTTPS, PRIVATE_HTTPS] } },
      }),
    );
    const blocked = recorded.filter(
      (r) => (r.refs as { outcome?: string }).outcome === "blocked_destination",
    );
    expect(blocked).toHaveLength(2);
    for (const row of blocked) {
      expect(row.severity).toBe("warn");
      expect(row.refs).toMatchObject({ channel: "web_push", userId: "owner" });
    }
  });

  it("a plain-http row is refused at dispatch too (Web Push endpoints are always https)", async () => {
    const prisma = makePrisma([sub(PUBLIC_HTTP)]);
    const result = await dispatchToUser(prisma, "owner", { title: "t", body: "b" });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, pruned: 1, subscriptions: 1 });
    expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: { in: [PUBLIC_HTTP] } },
    });
  });

  it("a 410 from the push service prunes the row and audits it as gone; other failures audit as failed", async () => {
    const prisma = makePrisma([sub(PUBLIC_HTTPS), sub(PUBLIC_HTTPS_2)]);
    sendNotificationMock.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint === PUBLIC_HTTPS) throw Object.assign(new Error("gone"), { statusCode: 410 });
      throw new Error("push service unreachable");
    });

    const result = await dispatchToUser(prisma, "owner", { title: "t", body: "b" });

    expect(result).toEqual({ sent: 0, pruned: 1, subscriptions: 2 });
    const outcomes = recorded.map((r) => (r.refs as { outcome: string }).outcome).sort();
    expect(outcomes).toEqual(["failed", "gone"]);
  });
});
