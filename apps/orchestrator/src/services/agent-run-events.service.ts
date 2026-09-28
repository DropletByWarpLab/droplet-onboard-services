/**
 * WARP-3301 — live background-run events on the event socket.
 *
 * Topic:   `droplet/agent-runs/<username>`
 * QoS:     0 (best-effort, like every ws-bridge topic; a client that missed
 *          one re-reads `GET /api/agent-runs/:id`, which carries the same
 *          fields)
 * Payload: {
 *   runId:         string
 *   sessionId:     string | null   // the chat that started it, if one did
 *   status:        AgentRunStatus
 *   iteration:     number          // steps taken so far
 *   maxIter:       number
 *   lastTool:      string | null   // tool NAME only, never its arguments
 *   queuePosition: number | null   // queued runs only; 1 = next to be worked on
 *   waitingFor:    "none" | "queue" | "chat"
 *   title:         string
 *   summary?:      string | null   // terminal states only
 * }
 *
 * Published at every status change and at every checkpoint (at most one per
 * step). ws-bridge subscribes each socket to its own user's topic only, so a
 * person never receives another person's runs.
 *
 * Fire-and-forget: a publish failure is logged and never fails the run.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { publish } from "./mqtt.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("agent-run-events");

export const AGENT_RUN_EVENTS_TOPIC = (username: string): string => `droplet/agent-runs/${username}`;

export type AgentRunWaitingFor = "none" | "queue" | "chat";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * What a run waits for. Only a queued run waits on anything; its reason is
 * the explicit `queueWait` column, written at every transition to `queued`.
 */
export function waitingForOf(status: string, queueWait: string | null | undefined): AgentRunWaitingFor {
  if (status !== "queued") return "none";
  return queueWait === "chat" ? "chat" : "queue";
}

/**
 * Position of every queued run, in the worker's claim order (`runAfter`,
 * then `createdAt`). Running runs hold the slot, so they count as ahead:
 * 1 = the next run to be worked on.
 */
// ponytail: reads the whole queued list per call; fine while a box queues a
// handful of runs (3 per person). Use a window function if queues grow.
export async function queuePositions(prisma: Db): Promise<Map<string, number>> {
  const [running, queued] = await Promise.all([
    prisma.agentRun.count({ where: { status: "running" } }),
    prisma.agentRun.findMany({
      where: { status: "queued" },
      orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    }) as Promise<Array<{ id: string }>>,
  ]);
  return new Map(queued.map((r, i) => [r.id, running + i + 1]));
}

/** The last tool each in-flight run called, fed by the worker's `onEvent`. */
const lastTools = new Map<string, string>();

/** The last payload sent per live run. Box finding (2026-09-28): the claim and the first checkpoint both published "running, step 0"; an unchanged state is not news. */
const lastSent = new Map<string, string>();

export function noteAgentRunTool(runId: string, tool: string): void {
  lastTools.set(runId, tool);
}

export async function publishAgentRunEvent(prisma: Db, runId: string): Promise<void> {
  try {
    const run = (await prisma.agentRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        userId: true,
        sessionId: true,
        status: true,
        iteration: true,
        maxIter: true,
        title: true,
        summary: true,
        queueWait: true,
      },
    })) as {
      id: string;
      userId: string;
      sessionId: string | null;
      status: string;
      iteration: number;
      maxIter: number;
      title: string;
      summary: string | null;
      queueWait: string;
    } | null;
    if (!run) return;
    const user = (await prisma.user.findUnique({
      where: { id: run.userId },
      select: { username: true },
    })) as { username: string } | null;
    if (!user) return;
    const terminal = TERMINAL.has(run.status);
    const queuePosition = run.status === "queued" ? ((await queuePositions(prisma)).get(run.id) ?? null) : null;
    const payload = {
      runId: run.id,
      sessionId: run.sessionId,
      status: run.status,
      iteration: run.iteration,
      maxIter: run.maxIter,
      lastTool: lastTools.get(run.id) ?? null,
      queuePosition,
      waitingFor: waitingForOf(run.status, run.queueWait),
      title: run.title,
      ...(terminal ? { summary: run.summary } : {}),
    };
    const key = JSON.stringify(payload);
    if (lastSent.get(run.id) === key) return;
    publish(AGENT_RUN_EVENTS_TOPIC(user.username), payload);
    if (terminal) {
      lastTools.delete(run.id);
      lastSent.delete(run.id);
    } else lastSent.set(run.id, key);
  } catch (err) {
    logger.warn({ err, runId }, "agent_run_event_publish_failed");
  }
}
