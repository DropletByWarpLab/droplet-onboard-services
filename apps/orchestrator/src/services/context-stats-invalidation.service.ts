/**
 * WARP-225 — context-stats cache invalidation listener.
 *
 * Subscribes to `droplet/context-stats/invalidate` over MQTT. The
 * file-indexer publishes one of these on every BrainMemoryItem
 * insert/update; the payload carries `{ userId }`. We respond by
 * SCAN+UNLINK'ing the per-user cache prefix `context-stats:<userId>:*`,
 * so the next dashboard poll bypasses the 30s/60s/5min TTL and sees
 * the fresh row.
 *
 * If MQTT is down (broker unreachable, broker restart) we lose the
 * push but keep the TTL — the dashboard eats up to one TTL window of
 * staleness on writes, which the spec calls out as acceptable.
 */

import pino from "pino";
import { invalidatePrefix } from "./cache.service.js";
import { subscribeToTopic } from "./mqtt.service.js";
import { userKeyPrefix } from "./context-stats.service.js";

const logger = pino({ name: "context-stats-invalidation" });

export const TOPIC = "droplet/context-stats/invalidate";

interface Payload {
  userId?: unknown;
}

function isValidPayload(p: unknown): p is { userId: string } {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof (p as Payload).userId === "string" &&
    ((p as Payload).userId as string).length > 0
  );
}

/**
 * Wire the subscription. Returns an unsubscribe function for tests +
 * graceful shutdown. Idempotent against multiple calls (each call
 * registers a separate handler — tests typically tear down between
 * cases).
 */
export function startContextStatsInvalidator(): () => void {
  return subscribeToTopic(TOPIC, async (_topic, payload) => {
    if (!isValidPayload(payload)) {
      logger.warn(
        { payload },
        "context-stats invalidate: dropping malformed payload",
      );
      return;
    }
    const prefix = userKeyPrefix(payload.userId);
    try {
      const removed = await invalidatePrefix(prefix);
      if (removed > 0) {
        logger.debug(
          { userId: payload.userId, removed },
          "context-stats cache invalidated",
        );
      }
    } catch (err) {
      // Swallow — cache invalidation is best-effort. The TTL still
      // bounds staleness even if the SCAN burst fails.
      logger.warn(
        { err, userId: payload.userId },
        "context-stats cache invalidate failed (non-fatal)",
      );
    }
  });
}
