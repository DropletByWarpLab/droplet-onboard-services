import mqtt, { MqttClient } from "mqtt";
import pino from "pino";
import { config } from "../config.js";

const logger = pino({ name: "mqtt" });

let client: MqttClient | null = null;

/**
 * Per-topic handler registry. Multiple callers (e.g. two browser sessions
 * connected to the WS bridge) can subscribe to the same MQTT topic; we keep
 * one broker-level subscription per unique topic and fan out to all local
 * handlers in memory.
 */
type TopicHandler = (topic: string, payload: Record<string, unknown>) => void;
const handlersByTopic = new Map<string, Set<TopicHandler>>();

export async function connectMqtt(): Promise<void> {
  return new Promise((resolve, reject) => {
    client = mqtt.connect(config.MQTT_BROKER);

    client.on("connect", () => {
      logger.info("Connected to MQTT broker");
      resolve();
    });

    client.on("error", (err) => {
      logger.error({ err }, "MQTT connection error");
      reject(err);
    });

    // Dispatch every incoming message to any matching local handler.
    client.on("message", (t, message) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(message.toString());
      } catch (err) {
        logger.warn({ err, topic: t }, "Failed to parse MQTT message");
        return;
      }
      for (const [subscription, handlers] of handlersByTopic) {
        if (topicMatches(subscription, t)) {
          for (const handler of handlers) {
            try {
              handler(t, payload);
            } catch (err) {
              logger.warn({ err, topic: t }, "Topic handler threw");
            }
          }
        }
      }
    });

    // Resolve after timeout if broker isn't available (non-fatal)
    setTimeout(() => resolve(), 3000);
  });
}

export function publish(topic: string, payload: Record<string, unknown>): void {
  if (!client?.connected) {
    logger.warn("MQTT not connected, skipping publish to %s", topic);
    return;
  }
  client.publish(topic, JSON.stringify(payload));
}

/**
 * @deprecated — kept for backwards compatibility with any caller using the
 * single-handler-per-topic API. Prefer `subscribeToTopic` which returns an
 * unsubscribe function.
 */
export function subscribe(
  topic: string,
  handler: (payload: Record<string, unknown>) => void
): void {
  subscribeToTopic(topic, (_, payload) => handler(payload));
}

/**
 * Subscribe to an MQTT topic (supports `+` / `#` wildcards) and return a
 * function that tears down just this subscription. If multiple callers
 * subscribe to the same topic, the broker-level subscription is only
 * unsubscribed when the last local handler is removed.
 *
 * Used by the WebSocket bridge to give each browser session its own
 * per-user topic subscription without leaking handlers across connections.
 */
export function subscribeToTopic(
  topic: string,
  handler: TopicHandler
): () => void {
  let set = handlersByTopic.get(topic);
  if (!set) {
    set = new Set();
    handlersByTopic.set(topic, set);
    // First subscriber for this topic — tell the broker.
    client?.subscribe(topic, (err) => {
      if (err) logger.warn({ err, topic }, "MQTT subscribe failed");
    });
  }
  set.add(handler);

  return () => {
    const s = handlersByTopic.get(topic);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) {
      handlersByTopic.delete(topic);
      client?.unsubscribe(topic, (err) => {
        if (err) logger.warn({ err, topic }, "MQTT unsubscribe failed");
      });
    }
  };
}

/**
 * MQTT wildcard matcher. Supports `+` (single segment) and `#` (rest).
 * Exposed for the WS bridge unit tests.
 */
export function topicMatches(subscription: string, incoming: string): boolean {
  const subParts = subscription.split("/");
  const inParts = incoming.split("/");
  for (let i = 0; i < subParts.length; i++) {
    const s = subParts[i];
    if (s === "#") return true;
    if (s === "+") {
      if (inParts[i] === undefined) return false;
      continue;
    }
    if (s !== inParts[i]) return false;
  }
  return subParts.length === inParts.length;
}
