/**
 * WARP-2548 — the orchestrator's MQTT connection state, as a health signal.
 *
 * The broker crash-looped for 6,000+ restarts (a TLS key its uid couldn't
 * read) and nothing on the status page said so: every MQTT consumer just
 * quietly failed to connect. mqtt.service records connection transitions
 * here; the health monitor reads them as the soft `mqtt` component, so a
 * down broker shows as Degraded with the client's last connect error as the
 * reason.
 *
 * A separate module on purpose: many suites `vi.mock` mqtt.service with a
 * bare `{ publish }`, and the health monitor must not depend on that mock's
 * shape.
 */

export type MqttConnectionState = "not_started" | "connecting" | "connected" | "disconnected";

let state: MqttConnectionState = "not_started";
let lastError: string | undefined;

export function recordMqttState(next: MqttConnectionState, error?: string): void {
  state = next;
  if (next === "connected") lastError = undefined;
  else if (error) lastError = error;
}

/** Health probe: resolves true when connected, else throws with the reason. */
export async function mqttHealth(): Promise<boolean> {
  if (state === "connected") return true;
  throw new Error(`MQTT broker ${state.replace("_", " ")}${lastError ? `: ${lastError}` : ""}`);
}
