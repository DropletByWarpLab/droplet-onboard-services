/**
 * WARP-456 — bridge file-indexer MQTT events into ActivityRow.
 *
 * The file-indexer (Python, services/file-indexer/) publishes one
 * topic per filesystem event per user:
 *   - `droplet/index/<user>/indexed`  → file added or re-indexed
 *   - `droplet/index/<user>/deleted`  → file removed
 *
 * This bridge subscribes to both topic shapes (wildcard `+` on the
 * user segment) and emits one ActivityRow per event with
 * `kind: "file"`. Lives in the orchestrator (the control plane), not
 * in file-indexer, because the signed audit log is the orchestrator's
 * responsibility per AC4 + the architectural rule that ActivityRow
 * writes are orchestrator-only.
 *
 * The subscription is best-effort: if MQTT is down the orchestrator
 * keeps running and the rest of the activity feed continues to
 * accept signed rows from in-process emitters.
 */
import { subscribeToTopic } from "./mqtt.service.js";
import { recordActivity } from "./activity.singleton.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("activity-file-indexer-bridge");

interface IndexedPayload {
  path?: string;
  ncFileId?: number;
  chunks?: number;
}

interface DeletedPayload {
  path?: string;
  ncFileId?: number;
}

/** Extract the user segment from `droplet/index/<user>/(indexed|deleted)`. */
function userFromTopic(topic: string): string | null {
  const parts = topic.split("/");
  if (parts.length < 4) return null;
  if (parts[0] !== "droplet" || parts[1] !== "index") return null;
  return parts[2] ?? null;
}

/**
 * Wire the bridge into the running MQTT client. Returns an unsubscribe
 * function for tests; in production the subscription lives for the
 * orchestrator's lifetime.
 */
export function attachFileIndexerActivityBridge(): () => void {
  const offIndexed = subscribeToTopic(
    "droplet/index/+/indexed",
    (topic, payloadRaw) => {
      const user = userFromTopic(topic);
      if (!user) return;
      const payload = payloadRaw as IndexedPayload;
      const filename = payload.path ? lastSegment(payload.path) : "(unknown file)";
      const subParts: string[] = [`for ${user}`];
      if (typeof payload.chunks === "number") {
        subParts.push(`${payload.chunks} chunks`);
      }
      void recordActivity({
        kind: "file",
        severity: "info",
        sourceIcon: "file-plus",
        what: `Indexed ${filename}`,
        // WARP-181: MQTT bridge rows are box housekeeping; the topic's
        // `user` segment is a Nextcloud username (kept in refs), not a
        // canonical UUID.
        actor: { type: "system" },
        sub: subParts.join(" • "),
        refs: stripUndefined({
          userId: user,
          path: payload.path,
          ncFileId: payload.ncFileId,
          chunks: payload.chunks,
        }),
      }).catch((err) => {
        logger.warn(
          { err, topic },
          "indexed-event activity recorder threw (swallowed)",
        );
      });
    },
  );

  const offDeleted = subscribeToTopic(
    "droplet/index/+/deleted",
    (topic, payloadRaw) => {
      const user = userFromTopic(topic);
      if (!user) return;
      const payload = payloadRaw as DeletedPayload;
      const filename = payload.path ? lastSegment(payload.path) : "(unknown file)";
      void recordActivity({
        kind: "file",
        severity: "warn",
        sourceIcon: "file-minus",
        what: `Removed ${filename}`,
        actor: { type: "system" },
        sub: `for ${user}`,
        refs: stripUndefined({
          userId: user,
          path: payload.path,
          ncFileId: payload.ncFileId,
        }),
      }).catch((err) => {
        logger.warn(
          { err, topic },
          "deleted-event activity recorder threw (swallowed)",
        );
      });
    },
  );

  return () => {
    offIndexed();
    offDeleted();
  };
}

function lastSegment(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
