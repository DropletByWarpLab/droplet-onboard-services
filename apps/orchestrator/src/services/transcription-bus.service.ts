/**
 * WARP-218 — thin wrapper around MQTT publish for the file-indexer's
 * "run one transcription now" command path.
 *
 * The orchestrator's `transcribe-now` route validates the request
 * (auth, ownership, state, retry cap) and then calls into here. The
 * file-indexer subscribes to `droplet/transcription/run-one` and runs
 * the worker against the named itemId out-of-band from the daily
 * scheduled run.
 *
 * Keeping the publish behind a TranscriptionPublisher interface lets
 * tests swap a captured-array fake for the real MQTT client.
 */

export const RUN_ONE_TOPIC = "droplet/transcription/run-one";

export interface TranscriptionPublisher {
  publish(topic: string, payload: unknown): void;
}

export interface RunOnePayload {
  itemId: string;
  userId: string;
}

export function publishRunOne(
  publisher: TranscriptionPublisher,
  payload: RunOnePayload,
): void {
  if (!payload.itemId) {
    throw new Error("publishRunOne: itemId required");
  }
  if (!payload.userId) {
    throw new Error("publishRunOne: userId required");
  }
  publisher.publish(RUN_ONE_TOPIC, payload);
}
