/**
 * WARP-353 — client-dispatch bridge unit tests (ADR-014 desktop tool-host).
 *
 * Covers the acceptance criteria:
 *   - hello/presence envelopes are received on the new topics and
 *     validated (bad envelope → rejected + logged, no DB write);
 *   - hello tool lists are checked against the stored default-deny
 *     consent map (ADR-014 §③);
 *   - ed25519 signature verification over the canonical
 *     "{requestId}|{outcome}|{deviceId}|{timestamp}" string rejects bad
 *     signatures AND replayed (deviceId, requestId) pairs;
 *   - verified outcomes are audited (kind "tool_call" +
 *     refs.targetDeviceId/requestId per ADR-014 §116) and returned to
 *     the awaiting dispatcher.
 *
 * `mqtt.service` is mocked so the tests can capture the bridge's topic
 * subscriptions and inject inbound messages without a broker (same
 * pattern as ws-bridge.topics.test.ts); `activity.singleton` is mocked
 * to observe audit emissions; DeviceClient rows come from a local
 * delegate stub (setup.ts's global prisma mock has no deviceClient).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

// ── mqtt.service mock: capture subscriptions + publishes ──

type TopicHandler = (topic: string, payload: Record<string, unknown>) => void;
const subscriptions = new Map<string, TopicHandler>();
const publishMock = vi.fn();

vi.mock("../services/mqtt.service.js", () => ({
  subscribeToTopic: (topic: string, handler: TopicHandler) => {
    subscriptions.set(topic, handler);
    return () => subscriptions.delete(topic);
  },
  publish: (topic: string, payload: Record<string, unknown>) =>
    publishMock(topic, payload),
}));

// ── activity.singleton mock: observe audit rows ──

const recordActivityMock = vi.fn().mockResolvedValue(null);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (params: unknown) => recordActivityMock(params),
}));

import {
  attachClientDispatchBridge,
  dispatchClientToolCall,
  canonicalResponseString,
  verifyClientSignature,
  llmToolDispatchTopic,
  isClientPaused,
  _resetClientDispatchForTests,
  CLIENT_HELLO_TOPIC_FILTER,
  CLIENT_PRESENCE_TOPIC_FILTER,
  LLM_TOOL_RESPONSE_TOPIC_FILTER,
} from "../services/client-dispatch.service.js";

// ── ed25519 fixtures ──

function makeClientKeypair(): { publicKeyBase64: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // WARP-1298 wire form: raw 32-byte public key, base64. The SPKI DER is a
  // fixed 12-byte prefix + the raw key.
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    publicKeyBase64: spki.subarray(spki.length - 32).toString("base64"),
    privateKey,
  };
}

function signCanonical(privateKey: KeyObject, canonical: string): string {
  return sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
}

// ── DeviceClient delegate stub ──

interface ClientRow {
  id: string;
  userId: string;
  status: string;
  toolConsent: Record<string, string>;
  clientPublicKey: string | null;
  lastSeenWsAt: Date | null;
}

function makePrismaStub(rows: ClientRow[]) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<ClientRow> }) => {
      const row = store.get(where.id);
      if (!row) throw new Error("P2025");
      Object.assign(row, data);
      return row;
    },
  );
  const prisma = {
    deviceClient: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.get(where.id) ?? null,
      ),
      update,
    },
  } as unknown as PrismaClient;
  return { prisma, store, update };
}

const DEVICE_ID = "dc-stefans-macbook";
const keys = makeClientKeypair();

function activeRow(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    id: DEVICE_ID,
    userId: "stefan",
    status: "active",
    toolConsent: { open_file: "confirm", notify: "allow" },
    clientPublicKey: keys.publicKeyBase64,
    lastSeenWsAt: null,
    ...overrides,
  };
}

function emit(topic: string, payload: Record<string, unknown>): void {
  // Route through whichever wildcard subscription matches, like the real
  // mqtt.service fan-out would.
  const area = topic.split("/")[1];
  const filter = `droplet/${area}/+`;
  const handler = subscriptions.get(filter);
  if (!handler) throw new Error(`no subscription for ${filter}`);
  handler(topic, payload);
}

/** Let the async handler chains settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let detach: (() => void) | null = null;

afterEach(() => {
  detach?.();
  detach = null;
  _resetClientDispatchForTests();
  subscriptions.clear();
  publishMock.mockClear();
  recordActivityMock.mockClear();
});

beforeEach(() => {
  vi.useRealTimers();
});

describe("attachClientDispatchBridge — topic subscriptions", () => {
  it("subscribes the three inbound ADR-014 topics", () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);
    expect([...subscriptions.keys()]).toEqual(
      expect.arrayContaining([
        CLIENT_HELLO_TOPIC_FILTER,
        CLIENT_PRESENCE_TOPIC_FILTER,
        LLM_TOOL_RESPONSE_TOPIC_FILTER,
      ]),
    );
    expect(CLIENT_HELLO_TOPIC_FILTER).toBe("droplet/client-hello/+");
    expect(CLIENT_PRESENCE_TOPIC_FILTER).toBe("droplet/client-presence/+");
    expect(LLM_TOOL_RESPONSE_TOPIC_FILTER).toBe("droplet/llm-tool-response/+");
    expect(llmToolDispatchTopic(DEVICE_ID)).toBe(
      `droplet/llm-tool-dispatch/${DEVICE_ID}`,
    );
  });
});

describe("client-hello", () => {
  it("accepts a hello whose tools are all consented and bumps lastSeenWsAt", async () => {
    const { prisma, update } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/client-hello/${DEVICE_ID}`, { tools: ["open_file", "notify"] });
    await settle();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: DEVICE_ID },
      data: { lastSeenWsAt: expect.any(Date) },
    });
  });

  it("REJECTS a hello advertising a tool outside the stored consent (default-deny §③)", async () => {
    const { prisma, update } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/client-hello/${DEVICE_ID}`, {
      tools: ["open_file", "screenshot"], // screenshot not in consent map
    });
    await settle();

    expect(update).not.toHaveBeenCalled();
  });

  it("REJECTS a hello whose consent entry is 'block'", async () => {
    const { prisma, update } = makePrismaStub([
      activeRow({ toolConsent: { open_file: "block" } }),
    ]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/client-hello/${DEVICE_ID}`, { tools: ["open_file"] });
    await settle();

    expect(update).not.toHaveBeenCalled();
  });

  it("REJECTS a bad envelope (tools not an array) without touching the DB", async () => {
    const { prisma, update } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/client-hello/${DEVICE_ID}`, { tools: "open_file" });
    await settle();

    expect(update).not.toHaveBeenCalled();
    expect(
      (prisma as any).deviceClient.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("REJECTS a hello from a revoked device", async () => {
    const { prisma, update } = makePrismaStub([activeRow({ status: "revoked" })]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/client-hello/${DEVICE_ID}`, { tools: ["notify"] });
    await settle();

    expect(update).not.toHaveBeenCalled();
  });
});

describe("client-presence", () => {
  it("bumps lastSeenWsAt and persists the pause toggle", async () => {
    const { prisma, update } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/client-presence/${DEVICE_ID}`, { paused: true });
    await settle();

    expect(update).toHaveBeenCalledTimes(1);
    expect(isClientPaused(DEVICE_ID)).toBe(true);

    emit(`droplet/client-presence/${DEVICE_ID}`, { paused: false });
    await settle();
    expect(isClientPaused(DEVICE_ID)).toBe(false);
  });

  it("REJECTS a bad presence envelope (paused not boolean)", async () => {
    const { prisma, update } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/client-presence/${DEVICE_ID}`, { paused: "yes" });
    await settle();

    expect(update).not.toHaveBeenCalled();
    expect(isClientPaused(DEVICE_ID)).toBe(false);
  });
});

describe("tool_response — ed25519 verification + replay cache", () => {
  function signedResponse(
    overrides: Partial<{
      requestId: string;
      outcome: string;
      deviceId: string;
      timestamp: number;
    }> = {},
    signWith: KeyObject = keys.privateKey,
  ) {
    const body = {
      requestId: "req-0001",
      outcome: "confirmed",
      deviceId: DEVICE_ID,
      timestamp: Date.now(),
      ...overrides,
    };
    return { ...body, signature: signCanonical(signWith, canonicalResponseString(body)) };
  }

  it("returns a verified outcome to the awaiting dispatcher", async () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    const resultPromise = dispatchClientToolCall(DEVICE_ID, {
      requestId: "req-0001",
      tool: "open_file",
      params: { path: "/tmp/x" },
      confirmationToken: "tok-abc",
    });

    // The dispatch was published to the device's dispatch topic.
    expect(publishMock).toHaveBeenCalledWith(
      `droplet/llm-tool-dispatch/${DEVICE_ID}`,
      expect.objectContaining({
        requestId: "req-0001",
        tool: "open_file",
        confirmationToken: "tok-abc",
      }),
    );

    emit(`droplet/llm-tool-response/${DEVICE_ID}`, signedResponse());
    const result = await resultPromise;
    expect(result).toEqual({
      ok: true,
      outcome: "confirmed",
      timestamp: expect.any(Number),
    });
  });

  it("audit-logs the verified response with targetDeviceId + requestId (ADR-014 §116)", async () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/llm-tool-response/${DEVICE_ID}`, signedResponse());
    await settle();

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const row = recordActivityMock.mock.calls[0][0];
    // Reuses the existing tool_call kind — a "client" kind would throw in
    // the KNOWN_KINDS guard.
    expect(row.kind).toBe("tool_call");
    expect(row.refs).toMatchObject({
      targetDeviceId: DEVICE_ID,
      requestId: "req-0001",
      outcome: "confirmed",
    });
  });

  it("REJECTS a bad signature (no audit 'ok' row, dispatcher keeps waiting)", async () => {
    const other = makeClientKeypair();
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    const resultPromise = dispatchClientToolCall(
      DEVICE_ID,
      { requestId: "req-0001", tool: "open_file" },
      { timeoutMs: 50 },
    );

    emit(
      `droplet/llm-tool-response/${DEVICE_ID}`,
      signedResponse({}, other.privateKey), // signed by the WRONG key
    );
    await settle();

    // Rejection is audited as a warn row, not an ok outcome.
    const kinds = recordActivityMock.mock.calls.map((c) => c[0].severity);
    expect(kinds).toContain("warn");
    expect(kinds).not.toContain("ok");

    // The dispatcher never receives the forged outcome — it times out.
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, error: "timeout" });
  });

  it("REJECTS a tampered outcome (signature covers the canonical string)", async () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    const genuine = signedResponse({ outcome: "denied" });
    emit(`droplet/llm-tool-response/${DEVICE_ID}`, {
      ...genuine,
      outcome: "confirmed", // flip after signing
    });
    await settle();

    const okRows = recordActivityMock.mock.calls.filter(
      (c) => c[0].severity === "ok",
    );
    expect(okRows).toHaveLength(0);
  });

  it("REJECTS a replayed (deviceId, requestId) pair", async () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    const response = signedResponse();
    emit(`droplet/llm-tool-response/${DEVICE_ID}`, response);
    await settle();
    emit(`droplet/llm-tool-response/${DEVICE_ID}`, response); // replay
    await settle();

    const calls = recordActivityMock.mock.calls.map((c) => c[0]);
    expect(calls.filter((c) => c.severity === "ok")).toHaveLength(1);
    const replayRow = calls.find((c) => c.refs?.rejected === "replay");
    expect(replayRow).toBeDefined();
    expect(replayRow.refs).toMatchObject({
      targetDeviceId: DEVICE_ID,
      requestId: "req-0001",
    });
  });

  it("REJECTS a stale timestamp even when the LRU no longer remembers it", async () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    emit(
      `droplet/llm-tool-response/${DEVICE_ID}`,
      signedResponse({ timestamp: Date.now() - 6 * 60 * 1000 }), // > 5 min old
    );
    await settle();

    expect(recordActivityMock.mock.calls.filter((c) => c[0].severity === "ok")).toHaveLength(0);
  });

  it("REJECTS a payload whose deviceId does not match the topic segment", async () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    // Signed correctly for DEVICE_ID, but arrives on another device's topic.
    emit(`droplet/llm-tool-response/dc-other`, signedResponse());
    await settle();

    expect(recordActivityMock.mock.calls.filter((c) => c[0].severity === "ok")).toHaveLength(0);
  });

  it("REJECTS a response from a device with no stored public key", async () => {
    const { prisma } = makePrismaStub([activeRow({ clientPublicKey: null })]);
    detach = attachClientDispatchBridge(prisma);

    emit(`droplet/llm-tool-response/${DEVICE_ID}`, signedResponse());
    await settle();

    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("REJECTS a bad envelope (missing signature)", async () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    const { signature: _drop, ...noSig } = signedResponse();
    emit(`droplet/llm-tool-response/${DEVICE_ID}`, noSig);
    await settle();

    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("times out when no response arrives", async () => {
    const { prisma } = makePrismaStub([activeRow()]);
    detach = attachClientDispatchBridge(prisma);

    const result = await dispatchClientToolCall(
      DEVICE_ID,
      { requestId: "req-lost", tool: "notify" },
      { timeoutMs: 20 },
    );
    expect(result).toEqual({ ok: false, error: "timeout" });
  });
});

describe("verifyClientSignature — unit", () => {
  it("verifies a signature produced over the canonical string", () => {
    const canonical = canonicalResponseString({
      requestId: "r1",
      outcome: "confirmed",
      deviceId: "d1",
      timestamp: 1234,
    });
    expect(canonical).toBe("r1|confirmed|d1|1234");
    const sig = signCanonical(keys.privateKey, canonical);
    expect(verifyClientSignature(keys.publicKeyBase64, canonical, sig)).toBe(true);
  });

  it("returns false (never throws) on malformed keys and signatures", () => {
    const canonical = "r1|confirmed|d1|1234";
    const sig = signCanonical(keys.privateKey, canonical);
    expect(verifyClientSignature("not-base64!!!", canonical, sig)).toBe(false);
    expect(verifyClientSignature(Buffer.alloc(16).toString("base64"), canonical, sig)).toBe(false);
    expect(verifyClientSignature(keys.publicKeyBase64, canonical, "AAAA")).toBe(false);
    expect(verifyClientSignature(keys.publicKeyBase64, canonical + "x", sig)).toBe(false);
  });
});
