/**
 * WARP-353 — orchestrator side of the ADR-014 desktop tool-host WS bridge.
 *
 * Paired clients (DeviceClient rows) talk to the box over the existing
 * MQTT-backed bridge. Four topics (ADR-014 "Core mechanism"):
 *
 *   - `droplet/client-hello/{deviceId}`      (client → box) capability hello.
 *       Validated against the row's stored per-tool consent map (default-
 *       deny, ADR-014 §③): every advertised tool must be consented
 *       (`allow` | `confirm`). Valid hello bumps `lastSeenWsAt`.
 *   - `droplet/client-presence/{deviceId}`   (client → box) heartbeat.
 *       Bumps `lastSeenWsAt` + persists the pause toggle.
 *   - `droplet/llm-tool-dispatch/{deviceId}` (box → client) tool dispatch.
 *       Published by `dispatchClientToolCall()`.
 *   - `droplet/llm-tool-response/{deviceId}` (client → box) signed outcome.
 *       ed25519 over the canonical string
 *       `"{requestId}|{outcome}|{deviceId}|{timestamp}"`, verified against
 *       the row's stored `clientPublicKey` (WARP-1298), then checked
 *       against a 5-minute `(deviceId, requestId)` replay cache, audited
 *       via the signed ActivityRow chain (`kind: "tool_call"` with
 *       `refs.targetDeviceId` — ADR-014 explicitly does NOT add a new
 *       activity kind), and finally returned to the awaiting dispatcher.
 *
 * Bad envelopes are rejected and logged; nothing in this module trusts a
 * payload field over the topic segment it arrived on.
 *
 * Pause state is held in-process (see `isClientPaused`) — a durable column
 * would need a migration, which is deferred to the WARP-1299 audit-axis
 * ticket by design.
 */
import { createPublicKey, verify } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { publish, subscribeToTopic } from "./mqtt.service.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("client-dispatch");

// ── Topics ──

export const CLIENT_HELLO_TOPIC_FILTER = "droplet/client-hello/+";
export const CLIENT_PRESENCE_TOPIC_FILTER = "droplet/client-presence/+";
export const LLM_TOOL_RESPONSE_TOPIC_FILTER = "droplet/llm-tool-response/+";

/** Box → client dispatch topic for one paired device. */
export function llmToolDispatchTopic(deviceId: string): string {
  return `droplet/llm-tool-dispatch/${deviceId}`;
}

/** Extract `{deviceId}` from `droplet/<area>/<deviceId>`. */
function deviceIdFromTopic(topic: string, area: string): string | null {
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== "droplet" || parts[1] !== area) {
    return null;
  }
  return parts[2] || null;
}

// ── Envelopes ──

// Segments that end up inside the `|`-joined canonical string (or an MQTT
// topic) must never contain a pipe or a topic separator — the charset
// whitelist makes the canonical form injective.
const idSegment = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "must be [A-Za-z0-9._-]");

const helloEnvelope = z.object({
  /** Tools the client advertises for this session. */
  tools: z.array(z.string().min(1).max(64)).max(64),
});

const presenceEnvelope = z.object({
  /** User toggled the client-side "pause AI" switch. */
  paused: z.boolean(),
});

const toolResponseEnvelope = z.object({
  requestId: idSegment,
  /** Consent/execution outcome — lowercase word, pipe-free by charset. */
  outcome: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/, "must be [a-z][a-z0-9_]*"),
  deviceId: idSegment,
  /** Client clock, epoch milliseconds — signature-covered. */
  timestamp: z.number().int().positive(),
  /** base64 ed25519 signature over the canonical string. */
  signature: z.string().min(1).max(512),
});

export type ClientToolResponse = z.infer<typeof toolResponseEnvelope>;

/** ADR-014: the exact byte string the client signs. */
export function canonicalResponseString(r: {
  requestId: string;
  outcome: string;
  deviceId: string;
  timestamp: number;
}): string {
  return `${r.requestId}|${r.outcome}|${r.deviceId}|${r.timestamp}`;
}

// ── ed25519 verification ──

/** DER SPKI prefix for a raw 32-byte ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verify an ed25519 signature against a stored `DeviceClient.clientPublicKey`
 * (raw 32-byte key, base64 — the WARP-1298 wire form). Returns false on any
 * malformed input rather than throwing: a garbage key or signature is an
 * authentication failure, not a server error.
 */
export function verifyClientSignature(
  clientPublicKeyBase64: string,
  canonical: string,
  signatureBase64: string,
): boolean {
  try {
    const raw = Buffer.from(clientPublicKeyBase64, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    const sig = Buffer.from(signatureBase64, "base64");
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(canonical, "utf8"), key, sig);
  } catch {
    return false;
  }
}

// ── Replay cache ──

/** ADR-014: 5-minute `(deviceId, requestId)` replay window. */
export const REPLAY_TTL_MS = 5 * 60 * 1000;
/** Hard entry cap so a hostile client can't grow the map unboundedly. */
const REPLAY_MAX_ENTRIES = 10_000;
/**
 * Responses older (or newer — client clock skew) than the replay TTL are
 * rejected outright: after the LRU evicts an entry the timestamp check is
 * what keeps a >5-minute-old capture unreplayable.
 */
export const RESPONSE_MAX_SKEW_MS = REPLAY_TTL_MS;

/** Insertion-ordered TTL+size-bounded seen-set (Map preserves order). */
class ReplayCache {
  private entries = new Map<string, number>();

  has(key: string, now: number): boolean {
    const insertedAt = this.entries.get(key);
    if (insertedAt === undefined) return false;
    if (now - insertedAt > REPLAY_TTL_MS) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, now: number): void {
    // Refresh position so eviction stays oldest-first.
    this.entries.delete(key);
    this.entries.set(key, now);
    while (this.entries.size > REPLAY_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

const replayCache = new ReplayCache();

function replayKey(deviceId: string, requestId: string): string {
  // Both segments are charset-whitelisted (no "\n"), so this is injective.
  return `${deviceId}\n${requestId}`;
}

// ── Pause state (in-process; durable column deferred to WARP-1299) ──

const pausedByDevice = new Map<string, boolean>();

/** Latest pause toggle a client reported via `client-presence`. */
export function isClientPaused(deviceId: string): boolean {
  return pausedByDevice.get(deviceId) ?? false;
}

// ── Dispatch registry ──

export interface ClientDispatchCall {
  /** Correlates dispatch → response; must be pipe-free (charset above). */
  requestId: string;
  /** Tool name from the V1 catalog (safety-rules CLIENT_TOOL_* sets). */
  tool: string;
  params?: Record<string, unknown>;
  /**
   * WARP-353 target-axis token for Tier-2 tools. The client's verified
   * `tool_response` is what redeems it (safety-tier `confirmCommand` with
   * the matching `targetDeviceId`) — there is no dashboard round-trip.
   */
  confirmationToken?: string;
}

export type ClientDispatchResult =
  | { ok: true; outcome: string; timestamp: number }
  | { ok: false; error: "timeout" };

interface PendingDispatch {
  deviceId: string;
  resolve: (result: ClientDispatchResult) => void;
  timer: NodeJS.Timeout;
}

const pendingDispatches = new Map<string, PendingDispatch>();

/** Default wait for a signed response — matches the Tier-2 confirm TTL. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 60_000;

/**
 * Publish a tool call to `droplet/llm-tool-dispatch/{deviceId}` and await
 * the verified, replay-checked `tool_response` for the same requestId.
 * Resolves `{ ok: false, error: "timeout" }` if none arrives in time.
 */
export function dispatchClientToolCall(
  deviceId: string,
  call: ClientDispatchCall,
  opts: { timeoutMs?: number } = {},
): Promise<ClientDispatchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingDispatches.delete(call.requestId);
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
    // Don't let an in-flight dispatch hold the process open on shutdown.
    timer.unref?.();
    pendingDispatches.set(call.requestId, { deviceId, resolve, timer });
    publish(llmToolDispatchTopic(deviceId), {
      requestId: call.requestId,
      tool: call.tool,
      params: call.params ?? {},
      ...(call.confirmationToken
        ? { confirmationToken: call.confirmationToken }
        : {}),
      issuedAt: Date.now(),
    });
  });
}

// ── Handlers ──

type ConsentValue = "allow" | "confirm" | "block";

function consentMap(row: { toolConsent: unknown }): Record<string, ConsentValue> {
  const consent = row.toolConsent;
  if (consent === null || typeof consent !== "object" || Array.isArray(consent)) {
    return {};
  }
  return consent as Record<string, ConsentValue>;
}

async function loadActiveClient(
  prisma: PrismaClient,
  deviceId: string,
): Promise<{
  id: string;
  userId: string;
  status: string;
  toolConsent: unknown;
  clientPublicKey: string | null;
} | null> {
  const row = await prisma.deviceClient.findUnique({ where: { id: deviceId } });
  if (!row || row.status !== "active") return null;
  return row;
}

async function handleClientHello(
  prisma: PrismaClient,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const deviceId = deviceIdFromTopic(topic, "client-hello");
  if (!deviceId) return;

  const parsed = helloEnvelope.safeParse(payload);
  if (!parsed.success) {
    logger.warn(
      { deviceId, issues: parsed.error.issues },
      "rejected client-hello: bad envelope",
    );
    return;
  }

  const client = await loadActiveClient(prisma, deviceId);
  if (!client) {
    logger.warn({ deviceId }, "rejected client-hello: unknown or revoked device");
    return;
  }

  // ADR-014 §③ / §37: hello tools ⊆ the stored consent map. Default-deny —
  // an empty map (fresh pairing) consents to nothing, and `block` entries
  // don't count. One unconsented tool rejects the whole hello so the client
  // can't smuggle capability past the AI-permissions surface.
  const consent = consentMap(client);
  const unconsented = parsed.data.tools.filter(
    (t) => consent[t] !== "allow" && consent[t] !== "confirm",
  );
  if (unconsented.length > 0) {
    logger.warn(
      { deviceId, unconsented },
      "rejected client-hello: advertised tools exceed stored consent",
    );
    return;
  }

  await prisma.deviceClient.update({
    where: { id: deviceId },
    data: { lastSeenWsAt: new Date() },
  });
  logger.info(
    { deviceId, tools: parsed.data.tools },
    "client-hello accepted",
  );
}

async function handleClientPresence(
  prisma: PrismaClient,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const deviceId = deviceIdFromTopic(topic, "client-presence");
  if (!deviceId) return;

  const parsed = presenceEnvelope.safeParse(payload);
  if (!parsed.success) {
    logger.warn(
      { deviceId, issues: parsed.error.issues },
      "rejected client-presence: bad envelope",
    );
    return;
  }

  const client = await loadActiveClient(prisma, deviceId);
  if (!client) {
    logger.warn(
      { deviceId },
      "rejected client-presence: unknown or revoked device",
    );
    return;
  }

  pausedByDevice.set(deviceId, parsed.data.paused);
  await prisma.deviceClient.update({
    where: { id: deviceId },
    data: { lastSeenWsAt: new Date() },
  });
}

async function handleToolResponse(
  prisma: PrismaClient,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const topicDeviceId = deviceIdFromTopic(topic, "llm-tool-response");
  if (!topicDeviceId) return;

  const parsed = toolResponseEnvelope.safeParse(payload);
  if (!parsed.success) {
    logger.warn(
      { deviceId: topicDeviceId, issues: parsed.error.issues },
      "rejected tool_response: bad envelope",
    );
    return;
  }
  const response = parsed.data;

  // The topic segment is what the broker routed on; a payload that claims a
  // different device is either a bug or an impersonation attempt.
  if (response.deviceId !== topicDeviceId) {
    logger.warn(
      { topicDeviceId, payloadDeviceId: response.deviceId },
      "rejected tool_response: deviceId does not match topic",
    );
    return;
  }

  const now = Date.now();

  // Freshness bound: beyond the replay-cache TTL the cache alone can't
  // prove non-replay, so stale (or far-future) timestamps are rejected.
  if (Math.abs(now - response.timestamp) > RESPONSE_MAX_SKEW_MS) {
    logger.warn(
      { deviceId: response.deviceId, requestId: response.requestId, timestamp: response.timestamp },
      "rejected tool_response: timestamp outside freshness window",
    );
    return;
  }

  // ADR-014: 5-minute (deviceId, requestId) replay cache.
  const key = replayKey(response.deviceId, response.requestId);
  if (replayCache.has(key, now)) {
    logger.warn(
      { deviceId: response.deviceId, requestId: response.requestId },
      "rejected tool_response: replayed (deviceId, requestId)",
    );
    void recordActivity({
      kind: "tool_call",
      severity: "warn",
      sourceIcon: "shield-alert",
      what: "Client tool response replay rejected",
      sub: null,
      actor: { type: "ai", id: null },
      refs: {
        targetDeviceId: response.deviceId,
        requestId: response.requestId,
        rejected: "replay",
      },
    }).catch(() => {});
    return;
  }

  const client = await loadActiveClient(prisma, response.deviceId);
  if (!client || !client.clientPublicKey) {
    logger.warn(
      { deviceId: response.deviceId, requestId: response.requestId },
      "rejected tool_response: unknown, revoked, or keyless device",
    );
    return;
  }

  const canonical = canonicalResponseString(response);
  if (!verifyClientSignature(client.clientPublicKey, canonical, response.signature)) {
    logger.warn(
      { deviceId: response.deviceId, requestId: response.requestId },
      "rejected tool_response: bad ed25519 signature",
    );
    void recordActivity({
      kind: "tool_call",
      severity: "warn",
      sourceIcon: "shield-alert",
      what: "Client tool response signature rejected",
      sub: null,
      actor: { type: "ai", id: null },
      refs: {
        targetDeviceId: response.deviceId,
        requestId: response.requestId,
        rejected: "signature",
      },
    }).catch(() => {});
    return;
  }

  // Only a VERIFIED response consumes the replay slot — garbage with a
  // guessed requestId must not be able to block the genuine response.
  replayCache.add(key, now);

  // ADR-014 §116: client dispatch reuses the existing `tool_call` kind
  // (a "client" kind is absent from KNOWN_KINDS and would throw);
  // `refs.targetDeviceId` is the discriminator. `client.userId` is a
  // Nextcloud username, not a canonical UUID, so it stays in refs.
  void recordActivity({
    kind: "tool_call",
    severity: "ok",
    sourceIcon: "monitor-check",
    what: `Client tool response: ${response.outcome}`,
    sub: `for ${client.userId}`,
    actor: { type: "ai", id: null },
    refs: {
      targetDeviceId: response.deviceId,
      requestId: response.requestId,
      outcome: response.outcome,
      userId: client.userId,
    },
  }).catch(() => {});

  const pending = pendingDispatches.get(response.requestId);
  if (pending && pending.deviceId === response.deviceId) {
    pendingDispatches.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve({
      ok: true,
      outcome: response.outcome,
      timestamp: response.timestamp,
    });
  }
}

// ── Bridge wiring ──

/**
 * Subscribe the three inbound client-dispatch topics. Call once at boot,
 * after `connectMqtt()` — best-effort like the other MQTT bridges: if the
 * broker is down the orchestrator keeps running. Returns a detach function
 * for tests.
 */
export function attachClientDispatchBridge(prisma: PrismaClient): () => void {
  const wrap =
    (fn: (p: PrismaClient, t: string, pl: Record<string, unknown>) => Promise<void>) =>
    (topic: string, payload: Record<string, unknown>) => {
      void fn(prisma, topic, payload).catch((err) => {
        logger.warn({ err, topic }, "client-dispatch handler threw (swallowed)");
      });
    };

  const offHello = subscribeToTopic(
    CLIENT_HELLO_TOPIC_FILTER,
    wrap(handleClientHello),
  );
  const offPresence = subscribeToTopic(
    CLIENT_PRESENCE_TOPIC_FILTER,
    wrap(handleClientPresence),
  );
  const offResponse = subscribeToTopic(
    LLM_TOOL_RESPONSE_TOPIC_FILTER,
    wrap(handleToolResponse),
  );

  return () => {
    offHello();
    offPresence();
    offResponse();
  };
}

/** Test-only: reset module state between cases. */
export function _resetClientDispatchForTests(): void {
  replayCache.clear();
  pausedByDevice.clear();
  for (const [, pending] of pendingDispatches) {
    clearTimeout(pending.timer);
  }
  pendingDispatches.clear();
}
