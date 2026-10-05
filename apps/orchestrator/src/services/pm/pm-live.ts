/**
 * Live updates for the Projects surface (WARP-3536, Work Suite WS-19,
 * ADR-069 §7).
 *
 * The `pm-live` consumer on the PmActivity outbox (pm-outbox.ts): when a row
 * appears, everyone who can read that work item is told, on their own topic,
 * that it changed — and the browser re-reads through the normal, authorized API.
 *
 *   Topic:   `droplet/pm/<username>`  (one per person, like
 *            `droplet/team-chat/<username>`; ws-bridge forwards each socket its
 *            own user's only)
 *   QoS:     0, best-effort. A client that missed one is no worse off than it
 *            was before this existed: the next focus, navigation or reconnect
 *            re-reads the same routes.
 *   Payload: IDs and a kind only — never a title, a name, a comment or a value:
 *              { type: "pm.changed", projectId, workItemId, verb }
 *            `verb` is the PmActivityVerb of the row (`state_changed`,
 *            `commented`, …). The frame is built field by field, so nothing
 *            else on the row can ever reach the wire.
 *
 * Who is told is pm-live-audience.ts. Nothing is published for a person who
 * cannot read the item, so there is nothing to withhold from the frame itself.
 *
 * ── Failure ────────────────────────────────────────────────────────────────
 *
 * This is advisory, so it must never be the reason something else is noisy or
 * stuck:
 *   • Broker down: the row is consumed and nothing else happens — no lookup, no
 *     publish, no error, no warning. `publish()` itself logs a warning per
 *     message while disconnected, and a frame per reader per change would be a
 *     page of them, which is why the state is read first (mqtt-status.ts). One
 *     debug line marks the start and the end of an outage. Frames from the
 *     outage are not replayed: they are stale by the time the broker is back.
 *   • A publish that throws is swallowed for that reader; the next reader and
 *     the row go on. One warning per run of failures, not one per frame.
 *   • A DATABASE error is rethrown, so the outbox keeps its cursor before the
 *     row and tries it again a second later (a restart must not lose rows). A
 *     row that never succeeds is dead-lettered after five minutes by the
 *     framework, as for any consumer.
 *
 * ── Timing ─────────────────────────────────────────────────────────────────
 *
 * `settleMs` matches Prisma's 5 s interactive-transaction ceiling plus margin,
 * so a later commit cannot move the cursor past a still-open delete tombstone.
 * With the nudge, a change is published after roughly 6 s; with a lost nudge,
 * within `settleMs + intervalMs`. The browser adds its 250 ms debounce and one
 * fetch.
 *
 * Idempotent, as the framework requires: replaying a row publishes the same
 * frame again, and a repeated frame is one more refetch.
 */
import type { PrismaClient } from "@prisma/client";
import { publish } from "../mqtt.service.js";
import { mqttConnected } from "../mqtt-status.js";
import { createLogger } from "../../lib/logger.js";
import type { OutboxConsumer } from "./pm-outbox.js";
import type { PmLiveAudience } from "./pm-live-audience.js";

const defaultLogger = createLogger("pm-live");

export const PM_LIVE_CONSUMER = "pm-live";

/** The backstop tick; the nudge makes the common case faster. */
const PM_LIVE_INTERVAL_MS = 1_000;

/** Rows are read once they have been still this long. See "Timing". */
// Match the outbox's 5 s interactive transaction ceiling plus margin. A later
// row must not advance the cursor past a tombstone whose delete transaction is
// still uncommitted.
const PM_LIVE_SETTLE_MS = 6_000;

/** Work item → project is remembered, bounded. A work item never changes project. */
const MAX_REMEMBERED_ITEMS = 2_000;

export const PM_LIVE_TOPIC = (username: string): string => `droplet/pm/${username}`;

export interface PmChangedEvent {
  type: "pm.changed";
  projectId: string;
  workItemId: string;
  verb: string;
}

export type PmLiveSend = (topic: string, payload: Record<string, unknown>) => void;

/**
 * Send one `pm.changed` frame to each of `usernames`. The frame is built here,
 * field by field, and nowhere else. A send that throws is reported to `onError`
 * and does not stop the rest.
 */
export function publishPmChanged(
  send: PmLiveSend,
  usernames: readonly string[],
  event: Omit<PmChangedEvent, "type">,
  onError?: (err: unknown) => void,
): void {
  for (const username of usernames) {
    const payload: PmChangedEvent = {
      type: "pm.changed",
      projectId: event.projectId,
      workItemId: event.workItemId,
      verb: event.verb,
    };
    try {
      send(PM_LIVE_TOPIC(username), payload as unknown as Record<string, unknown>);
    } catch (err) {
      onError?.(err);
    }
  }
}

export interface PmLiveDeps {
  prisma: Pick<PrismaClient, "pmWorkItem">;
  audience: PmLiveAudience;
  /** Seam: is the broker up? Default: the health record's own answer. */
  connected?: () => boolean;
  /** Seam: the one publish. Default: the shared MQTT client's. */
  send?: PmLiveSend;
  logger?: {
    debug(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}

/** The `pm-live` outbox consumer; index.ts registers it. */
export function createPmLiveConsumer(deps: PmLiveDeps): OutboxConsumer {
  const connected = deps.connected ?? mqttConnected;
  const send = deps.send ?? publish;
  const log = deps.logger ?? defaultLogger;

  const projectOf = new Map<string, string>();
  let brokerDown = false;
  let publishing = true;

  return {
    name: PM_LIVE_CONSUMER,
    intervalMs: PM_LIVE_INTERVAL_MS,
    settleMs: PM_LIVE_SETTLE_MS,
    handle: async (row) => {
      if (!connected()) {
        if (!brokerDown) {
          brokerDown = true;
          log.debug({}, "pm-live: the broker is down; live updates are paused until it is back");
        }
        return;
      }
      if (brokerDown) {
        brokerDown = false;
        log.debug({}, "pm-live: the broker is back; live updates resumed");
      }

      if (row.deletedWorkItemId && row.deletedProjectId) {
        const usernames = await deps.audience.usernamesForDeleted(row.deletedGuestUserIds);
        if (usernames.length === 0) return;
        let failed = false;
        publishPmChanged(send, usernames, {
          projectId: row.deletedProjectId,
          workItemId: row.deletedWorkItemId,
          verb: "deleted",
        }, (err) => {
          failed = true;
          if (publishing) {
            publishing = false;
            log.warn({ err }, "pm-live: a frame could not be published; live updates are best-effort and the next refresh catches up");
          }
        });
        if (!failed) publishing = true;
        return;
      }
      // Non-tombstone rows always retain their work-item FK. Null is guarded
      // here as a fail-closed fallback for malformed legacy/manual rows.
      if (!row.workItemId) return;

      let projectId = projectOf.get(row.workItemId);
      if (projectId === undefined) {
        const item = await deps.prisma.pmWorkItem.findUnique({
          where: { id: row.workItemId },
          select: { projectId: true },
        });
        // Deleted since the write. Its activity rows go with it, so there is
        // nothing left to announce (and a row we could not place is not cached).
        if (!item) return;
        if (projectOf.size >= MAX_REMEMBERED_ITEMS) projectOf.clear();
        projectOf.set(row.workItemId, item.projectId);
        projectId = item.projectId;
      }

      const usernames = await deps.audience.usernamesFor(row.workItemId);
      if (usernames.length === 0) return;

      let failed = false;
      publishPmChanged(send, usernames, { projectId, workItemId: row.workItemId, verb: row.verb }, (err) => {
        failed = true;
        if (publishing) {
          publishing = false;
          log.warn({ err }, "pm-live: a frame could not be published; live updates are best-effort and the next refresh catches up");
        }
      });
      if (!failed) publishing = true;
    },
  };
}
