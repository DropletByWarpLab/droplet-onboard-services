/**
 * WARP-2991 — replaying a conversation's earlier answers to a cloud model.
 *
 * THE RULE: an off-LAN (cloud-provider) turn carries the assistant side of the
 * conversation only when the owner said yes for THIS conversation, after the
 * last answer the box produced on-box. Otherwise it carries the user's own
 * messages and nothing else.
 *
 * WHY. The dashboard replays the whole thread in `messages` on every turn, and
 * the on-box model's earlier answers can quote exactly what WARP-2746 keeps off
 * a cloud turn: memory facts, business profile, brain findings, document
 * excerpts. Without this, switching the picker to a cloud model sent all of it
 * one turn later.
 *
 * FAILS CLOSED. `not_asked`, `declined`, an on-box answer newer than the
 * consent, a turn with no persisted conversation, and a failed read all give
 * `user_only`. The dashboard dialog is the way to say yes; it is never the
 * enforcement.
 *
 * WHAT COUNTS AS ON-BOX. An assistant row whose persisted provider is local,
 * or NULL (rows from before WARP-904 stamped a provider, or an API caller that
 * sent none) — unknown provenance is treated as on-box. A conversation that
 * has only ever run on cloud models has no such rows and replays in full.
 */
import { TOOL_CATALOG, type ToolDomain } from "@droplet/tools-core";
import type { CloudHistoryConsent, PrismaClient } from "@prisma/client";

import { isLocalProvider } from "./cloud-access.service.js";

export type HistoryReplayMode = "full" | "user_only";

/** Stored-content domains named in the consent dialog, in plain words. */
const DREW_ON_LABEL: Partial<Record<ToolDomain, string>> = {
  files: "documents",
  memory: "memory",
  business: "business records",
};

const DOMAIN_BY_NAME = new Map(TOOL_CATALOG.map((t) => [t.name, t.domain]));

type ConsentPrisma = {
  chatSession: Pick<PrismaClient["chatSession"], "findFirst" | "updateMany">;
  chatMessage: Pick<PrismaClient["chatMessage"], "findMany">;
};

export interface CloudHistorySummary {
  consent: CloudHistoryConsent;
  decidedAt: string | null;
  /** On-box answers the current consent does NOT cover (the server rule). */
  uncoveredOnBoxAnswers: number;
  /** On-box answers newer than the last decision, either way. > 0 ⇒ the
   *  dashboard asks; 0 after a decline means "already answered, don't nag". */
  unaskedOnBoxAnswers: number;
  /** The user's own messages — what is sent on decline. */
  userMessages: number;
  /** Plain-word stored-content sources those uncovered answers used. */
  drewOn: string[];
}

function isOnBox(provider: string | null): boolean {
  return provider === null || isLocalProvider(provider);
}

function toolNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((c) => (c && typeof c === "object" ? (c as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
}

/**
 * What a cloud turn on this conversation would carry, for the owner's eyes.
 * `null` when the conversation does not exist or is not the caller's.
 */
export async function summarizeCloudHistory(
  prisma: ConsentPrisma,
  args: { conversationId: string; userId: string; excludeMessageId?: string | null },
): Promise<CloudHistorySummary | null> {
  const session = await prisma.chatSession.findFirst({
    where: { id: args.conversationId, userId: args.userId },
    select: { cloudHistoryConsent: true, cloudHistoryConsentAt: true },
  });
  if (!session) return null;

  const rows = await prisma.chatMessage.findMany({
    where: {
      sessionId: args.conversationId,
      role: { in: ["user", "assistant"] },
      ...(args.excludeMessageId ? { id: { not: args.excludeMessageId } } : {}),
    },
    select: { role: true, provider: true, createdAt: true, toolCalls: true },
  });

  const coveredUntil =
    session.cloudHistoryConsent === "granted" ? session.cloudHistoryConsentAt : null;
  const uncovered = rows.filter(
    (r) =>
      r.role === "assistant" &&
      isOnBox(r.provider) &&
      (coveredUntil === null || r.createdAt > coveredUntil),
  );
  const decidedAt = session.cloudHistoryConsentAt;
  const unasked = rows.filter(
    (r) =>
      r.role === "assistant" &&
      isOnBox(r.provider) &&
      (decidedAt === null || r.createdAt > decidedAt),
  ).length;
  const drewOn = new Set<string>();
  for (const r of uncovered) {
    for (const name of toolNames(r.toolCalls)) {
      const domain = DOMAIN_BY_NAME.get(name);
      const label = domain ? DREW_ON_LABEL[domain] : undefined;
      if (label) drewOn.add(label);
    }
  }

  return {
    consent: session.cloudHistoryConsent,
    decidedAt: session.cloudHistoryConsentAt?.toISOString() ?? null,
    uncoveredOnBoxAnswers: uncovered.length,
    unaskedOnBoxAnswers: unasked,
    userMessages: rows.filter((r) => r.role === "user").length,
    drewOn: [...drewOn].sort(),
  };
}

/**
 * The per-turn decision for an OFF-LAN turn. Never throws: any failure is
 * `user_only`.
 */
export async function decideHistoryReplay(
  prisma: ConsentPrisma,
  args: { conversationId: string | null; userId: string | undefined; excludeMessageId?: string | null },
): Promise<HistoryReplayMode> {
  if (!args.conversationId || !args.userId) return "user_only";
  try {
    const summary = await summarizeCloudHistory(prisma, {
      conversationId: args.conversationId,
      userId: args.userId,
      excludeMessageId: args.excludeMessageId,
    });
    return summary && summary.uncoveredOnBoxAnswers === 0 ? "full" : "user_only";
  } catch {
    return "user_only";
  }
}

/** Keep the user's own messages (and caller system prompts); drop the rest. */
export function userOnlyReplay<T extends { role: string }>(messages: readonly T[]): T[] {
  return messages.filter((m) => m.role === "user" || m.role === "system");
}

/** Record the owner's answer. Returns false when the conversation is not theirs. */
export async function recordCloudHistoryConsent(
  prisma: ConsentPrisma,
  args: {
    conversationId: string;
    userId: string;
    decision: Exclude<CloudHistoryConsent, "not_asked">;
    at?: Date;
  },
): Promise<boolean> {
  const { count } = await prisma.chatSession.updateMany({
    where: { id: args.conversationId, userId: args.userId },
    data: {
      cloudHistoryConsent: args.decision,
      cloudHistoryConsentAt: args.at ?? new Date(),
      cloudHistoryConsentBy: args.userId,
    },
  });
  return count > 0;
}

/** Appended to a cloud turn's system prompt when history was withheld. */
export const OFF_LAN_HISTORY_NOTICE =
  "Earlier replies in this conversation were produced on the Droplet and were " +
  "not sent to you; only the user's own messages are included. If the user " +
  "refers to an earlier answer, ask them to restate what they need.";
