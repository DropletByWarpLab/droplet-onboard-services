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

import { dispatchToUser } from "../services/push-dispatch.service.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

const audited: RecordParams[] = [];

// Test-fixture hosts only (RFC 2606 `.test`); the real push services are
// named in docs/security/allowed-egress.yaml, never in code.
const GOOD = "https://push.vendor.test/send/abc123";

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
      dst: "push.vendor.test",
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
    ["plain http", "http://push.vendor.test/send/x"],
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
