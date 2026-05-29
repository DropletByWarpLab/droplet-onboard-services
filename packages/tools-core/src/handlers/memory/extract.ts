/**
 * WARP-461 — `memory_extract_fact` LLM tool.
 *
 * Persists a durable memory fact extracted from the current conversation.
 * Tier 2 (write + requires confirmation) — the agent loop emits a
 * `confirm_action` card to the user before calling this handler; the
 * handler ONLY runs after user confirmation.
 *
 * `category` is constrained to the same five-value enum as the recall
 * tool. `evidenceChatId` is recommended so the fact's row carries a
 * back-link to the source conversation (FEATURES.md §5 spec field).
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: ["Tone", "Workflow", "Scope", "Schedule", "Other"],
      description: "Which bucket the fact belongs to.",
    },
    fact: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description:
        "The fact itself — a short imperative or declarative sentence (e.g. 'You prefer recaps under 200 words').",
    },
    evidenceChatId: {
      type: "string",
      description:
        "UUID of the ChatSession this fact was extracted from. Optional but recommended for traceability.",
    },
  },
  required: ["category", "fact"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const category = args.category;
  if (
    typeof category !== "string" ||
    !["Tone", "Workflow", "Scope", "Schedule", "Other"].includes(category)
  ) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "category must be one of Tone|Workflow|Scope|Schedule|Other" },
    };
  }
  const fact = typeof args.fact === "string" ? args.fact.trim() : "";
  if (fact.length === 0 || fact.length > 2000) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "fact must be 1-2000 characters" },
    };
  }
  const evidenceChatId =
    typeof args.evidenceChatId === "string" ? args.evidenceChatId : null;

  const created = await ctx.prisma.memoryFact.create({
    data: {
      category: category as "Tone" | "Workflow" | "Scope" | "Schedule" | "Other",
      fact,
      evidenceChatId,
      addedBy: ctx.userId ?? "agent",
    },
  });

  return {
    ok: true,
    data: {
      id: created.id,
      category: created.category,
      fact: created.fact,
      addedAt: created.addedAt.toISOString(),
    },
  };
}

const tool: Tool = {
  name: "memory_extract_fact",
  description:
    "Persist a durable memory fact about the user or workspace. Use when the conversation reveals a preference, recurring workflow, scope assumption, or schedule the user has stated. Tier-2 write — requires operator confirmation. Pair with memory_recall to check if the fact already exists before extracting.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
