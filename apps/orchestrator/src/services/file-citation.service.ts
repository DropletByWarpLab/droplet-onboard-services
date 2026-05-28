/**
 * WARP-473 — file-citation enqueue (fire-and-forget).
 *
 * The agent loop hands every tool-emitted file path off to this
 * service. Persisting one row per `(filePath, messageId)` would be
 * costly on the hot path; instead we schedule the insert on the
 * macrotask queue (`setImmediate`) so the agent loop returns
 * immediately and never observes the latency.
 *
 * Errors are logged at WARN — the citation table is best-effort
 * audit data, not load-bearing state. A wedged DB must NEVER take
 * a chat turn down with it.
 */
import type { PrismaClient } from "@prisma/client";
import pino from "pino";

const logger = pino({ name: "file-citation" });

export interface FileCitationContext {
  threadId: string;
  messageId: string;
}

export interface FileCitationService {
  /**
   * Schedule citation inserts for every path in `filePaths`. Returns
   * synchronously; the actual write happens on the next macrotask.
   */
  enqueue(filePaths: string[], context: FileCitationContext): void;
}

export function createFileCitationService(
  prisma: PrismaClient,
): FileCitationService {
  return {
    enqueue(filePaths, context) {
      if (filePaths.length === 0) return;
      // setImmediate is the canonical Node "don't block, just queue
      // this for after the current event-loop tick" primitive.
      setImmediate(async () => {
        try {
          await prisma.fileCitation.createMany({
            data: filePaths.map((filePath) => ({
              filePath,
              threadId: context.threadId,
              messageId: context.messageId,
            })),
          });
        } catch (err) {
          logger.warn(
            { err, filePaths: filePaths.length, ...context },
            "file-citation insert failed (best-effort; chat turn not affected)",
          );
        }
      });
    },
  };
}
