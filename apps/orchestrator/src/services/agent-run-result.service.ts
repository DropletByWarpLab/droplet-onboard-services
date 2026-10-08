/**
 * WARP-3300 — a background run started from chat reports back into that chat.
 *
 * Two halves, both for `origin = "chat"` runs only:
 *
 *   chatRunBrief()      — the run's first user message. The run sees a fixed
 *                         brief (objective, deliverable, how to finish), never
 *                         the chat history: the parent's 16k window cannot be
 *                         forked into a 16k child and leave room to work.
 *   deliverRunResults() — called from the worker tick. Every finished chat run
 *                         whose result has not reached its conversation gets
 *                         ONE `agent_run_result` message there: a bounded
 *                         summary plus the files it made. The content is plain
 *                         assistant text, so older clients show it and the
 *                         next chat turn replays it to the model with no
 *                         polling tool and no new injection path.
 *
 * Delivery is a sweep, not a hook on each terminal write: a run ends in the
 * worker (several paths), in the cancel route, or in reclaim, and a sweep over
 * `resultDelivery` covers all of them from one place. `resultDelivery` is the
 * explicit state (no-guessing rule); `turnId = agent-run:<id>` makes a repeat
 * post after a crash between insert and update a no-op (appendMessages dedups
 * on it).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { ChatPersistenceService } from "./chat-persistence.service.js";
import { publish as mqttPublish } from "./mqtt.service.js";

// The fields of the worker's `AgentRunTraceEntry` this module reads. Declared
// here, not imported: the worker imports this module, and the import-cycle
// gate (WARP-3193) counts type-only imports too.
type TraceEntry = {
  tool: string;
  args?: Record<string, unknown>;
  text?: string;
  isError?: boolean;
  unknownOutcome?: boolean;
  confirmation?: string;
};

/** Matches `AgentRun.summary @db.VarChar(2000)`. */
export const SUMMARY_MAX_CHARS = 2000;
/** A `failed` delivery is retried on later ticks up to this many posts. */
export const RESULT_DELIVERY_MAX_ATTEMPTS = 5;
/** Deliveries per tick. The tick is 5 s; a backlog drains in a few ticks. */
const DELIVERY_BATCH = 10;

export interface AgentRunArtifact {
  kind: "file";
  ref: string;
  title: string;
}

export interface AgentRunResultMeta {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  title: string;
  summary: string;
  artifacts: AgentRunArtifact[];
}

export function chatRunBrief(run: { goal: string; title: string; deliverable: string }): string {
  return [
    `Background task: ${run.title || "(untitled)"}`,
    "",
    "Objective:",
    run.goal,
    "",
    "Deliverable:",
    run.deliverable || "A short written answer to the objective.",
    "",
    "How to finish: the person who started this task is not watching. Your final",
    "message is posted back into their chat, where a model with a very small",
    "context reads it. End with:",
    "1. A summary of what you found or did, at most 300 words.",
    "2. Every file or note you created, with its path.",
    "If you could not finish, say what is missing and what you did get done.",
  ].join("\n");
}

/** Cut to the column's 2,000 characters at a word boundary, with an ellipsis. */
export function boundSummary(text: string): string {
  const t = text.trim();
  if (t.length <= SUMMARY_MAX_CHARS) return t;
  const slice = t.slice(0, SUMMARY_MAX_CHARS - 1);
  const space = slice.lastIndexOf(" ");
  return (space > SUMMARY_MAX_CHARS / 2 ? slice.slice(0, space) : slice) + "…";
}

/**
 * The files a run made, from its trace. Conservative on purpose: only the
 * tools below, only a call whose outcome was recorded and was not an error, a
 * park or a refusal. A path the model merely mentioned in prose is not an
 * artifact.
 */
const ARTIFACT_PATH_ARG: Readonly<Record<string, string>> = {
  write_file: "path",
  create_document: "path",
  create_pdf_report: "path",
  create_slide_deck: "path",
  create_spreadsheet: "path",
  create_word_document: "path",
  copy_file: "to_path",
};

export function runArtifacts(trace: unknown): AgentRunArtifact[] {
  if (!Array.isArray(trace)) return [];
  const seen = new Set<string>();
  const out: AgentRunArtifact[] = [];
  function add(ref: unknown) {
    if (typeof ref !== "string" || !ref.startsWith("/") || /[\u0000-\u001f\\]/.test(ref) || ref.split("/").includes("..") || seen.has(ref)) return;
    seen.add(ref);
    out.push({ kind: "file", ref, title: ref.split("/").pop() || ref });
  }
  for (const e of trace as TraceEntry[]) {
    const arg = ARTIFACT_PATH_ARG[e.tool];
    if ((!arg && !["analyze_data", "generate_media", "office_file", "create_artifact", "create_audio"].includes(e.tool)) || e.text === undefined || e.isError || e.unknownOutcome) continue;
    if (e.confirmation === "parked" || e.confirmation === "denied") continue;
    if (!succeeded(e.text)) continue;
    if (arg && e.tool !== "create_slide_deck") { add(e.args?.[arg]); continue; }
    // Derived names come from acknowledged storage results. A pending media
    // job is not a file, whatever destination the caller originally requested.
    try {
      const value = JSON.parse(e.text);
      const data = value?.data ?? value;
      if (e.tool === "create_slide_deck") {
        if (Array.isArray(data?.artifacts)) {
          for (const item of data.artifacts) add(item?.path);
        } else if (typeof data?.path === "string") add(data.path);
        else if (e.args?.both !== true) add(e.args?.path); // Legacy single-format traces.
      } else if (e.tool === "analyze_data" && Array.isArray(data?.artifacts)) {
        for (const item of data.artifacts) add(item?.path);
      } else if (e.tool === "generate_media" && data?.status === "succeeded") add(data.path);
      else if (e.tool === "office_file" && data?.action === "revise") add(data.path);
      else if (e.tool === "create_artifact" || e.tool === "create_audio") add(data?.path);
    } catch { /* No structured saved-file result, so no derived artifact. */ }
  }
  return out;
}

function succeeded(text: string): boolean {
  try {
    const v = JSON.parse(text) as { status?: unknown; ok?: unknown };
    return v.status !== "error" && v.status !== "confirmation_required" && v.ok !== false;
  } catch {
    return true; // plain-text success output
  }
}

type FinishedRun = {
  id: string;
  status: "succeeded" | "failed" | "cancelled";
  title: string;
  goal: string;
  result: string | null;
  error: string | null;
  stopReason: string | null;
  trace: unknown;
};

/** What the run got done, for every terminal status. */
export function runSummary(run: FinishedRun): string {
  if (run.status === "succeeded" && run.result?.trim()) return boundSummary(run.result);
  const steps = Array.isArray(run.trace)
    ? (run.trace as TraceEntry[]).filter((e) => e.text !== undefined && !e.isError).length
    : 0;
  const why =
    run.status === "cancelled"
      ? "It was stopped before it finished."
      : `It stopped before it finished (${run.error ?? run.stopReason ?? "no reason recorded"}).`;
  const partial = run.result?.trim() ? ` Last output: ${run.result.trim()}` : "";
  return boundSummary(`${why} ${steps} step${steps === 1 ? "" : "s"} completed.${partial}`);
}

export function resultMessageText(meta: AgentRunResultMeta): string {
  const verb =
    meta.status === "succeeded" ? "finished" : meta.status === "cancelled" ? "was stopped" : "did not finish";
  const files = meta.artifacts.length ? `\n\nFiles: ${meta.artifacts.map((a) => a.ref).join(", ")}` : "";
  return `Background task "${meta.title}" ${verb}: ${meta.summary}${files}`;
}

export interface DeliverDeps {
  prisma: PrismaClient;
  now?: () => Date;
  publish?: (topic: string, payload: Record<string, unknown>) => void;
}

/** Post every pending chat-run result. Returns how many were delivered. */
export async function deliverRunResults(deps: DeliverDeps): Promise<number> {
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());
  const publish = deps.publish ?? mqttPublish;
  const persistence = new ChatPersistenceService(prisma);

  const due = (await prisma.agentRun.findMany({
    where: {
      origin: "chat",
      status: { in: ["succeeded", "failed", "cancelled"] },
      OR: [
        { resultDelivery: "pending" },
        { resultDelivery: "failed", resultDeliveryAttempts: { lt: RESULT_DELIVERY_MAX_ATTEMPTS } },
      ],
    },
    orderBy: { endedAt: "asc" },
    take: DELIVERY_BATCH,
    select: {
      id: true, status: true, title: true, goal: true, result: true, error: true,
      stopReason: true, trace: true, sessionId: true,
    },
  })) as Array<FinishedRun & { sessionId: string | null }>;

  let delivered = 0;
  for (const run of due) {
    const fence = { id: run.id, resultDelivery: { in: ["pending", "failed"] } } as Prisma.AgentRunWhereInput;
    const session = run.sessionId
      ? ((await prisma.chatSession.findUnique({
          where: { id: run.sessionId },
          select: { id: true, userId: true },
        })) as { id: string; userId: string } | null)
      : null;
    if (!session) {
      await prisma.agentRun.updateMany({ where: fence, data: { resultDelivery: "conversation_gone" } });
      continue;
    }
    const meta: AgentRunResultMeta = {
      runId: run.id,
      status: run.status,
      title: run.title || run.goal.split("\n")[0].slice(0, 120),
      summary: runSummary(run),
      artifacts: runArtifacts(run.trace),
    };
    const turnId = `agent-run:${run.id}`;
    try {
      await persistence.appendMessages(session.id, [
        {
          role: "assistant",
          content: resultMessageText(meta),
          turnId,
          kind: "agent_run_result",
          meta: meta as unknown as Prisma.InputJsonValue,
        },
      ]);
      await prisma.agentRun.updateMany({
        where: fence,
        data: {
          summary: meta.summary,
          artifacts: meta.artifacts as unknown as Prisma.InputJsonValue,
          resultDelivery: "delivered",
          resultDeliveryAttempts: { increment: 1 },
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[agent-run-result] delivery failed for run ${run.id}:`, err);
      await prisma.agentRun
        .updateMany({ where: fence, data: { resultDelivery: "failed", resultDeliveryAttempts: { increment: 1 } } })
        .catch(() => undefined);
      continue;
    }
    delivered += 1;
    // Same topic and payload as a finished chat turn (routes/llm.ts, WARP-329):
    // the dashboard reloads the open conversation and a background tab
    // notifies, with no client change needed to see the message land.
    const row = (await prisma.chatMessage.findFirst({
      where: { sessionId: session.id, turnId, role: "assistant" },
      select: { id: true },
    })) as { id: string } | null;
    try {
      publish(`droplet/chat/${session.userId}/turn-completed`, {
        conversationId: session.id,
        messageId: row?.id ?? "",
        status: "completed",
        snippet: resultMessageText(meta).slice(0, 140),
        completedAt: now().toISOString(),
      });
    } catch {
      // Best effort, QoS 0 like the chat path; the message is already stored.
    }
  }
  return delivered;
}
