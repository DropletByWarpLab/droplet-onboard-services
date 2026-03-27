import mqtt, { MqttClient } from "mqtt";
import pino from "pino";
import { config } from "../config.js";

const logger = pino({ name: "mqtt" });

let client: MqttClient | null = null;

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

export function subscribe(
  topic: string,
  handler: (payload: Record<string, unknown>) => void
): void {
  if (!client) return;
  client.subscribe(topic);
  client.on("message", (t, message) => {
    if (t === topic) {
      try {
        handler(JSON.parse(message.toString()));
      } catch (e) {
        logger.error({ err: e }, "Failed to parse MQTT message");
      }
    }
  });
}
