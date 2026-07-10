/**
 * WARP-461 — `memory_extract_fact` LLM tool.
 *
 * Persists a durable memory fact extracted from the current conversation.
 * Tier 2 (write + requires confirmation), enforced BY THE HANDLER:
 * neither the MCP server nor the agent loop enforces the
 * `requiresConfirmation` flag generically, so the first call returns
 * `confirmation_required` (no write) with the proposed fact echoed in
 * the message. The model relays it to the user and re-issues the call
 * with `confirmed: true` only after the user explicitly approves —
 * same in-chat completion shape as the firewall tools' supervised
 * path, without run_scene's single-use REST token (saving a text fact
 * doesn't need replay protection; the write is RBAC-gated upstream).
 *
 * `category` is constrained to the same five-value enum as the recall
 * tool. `evidenceChatId` is recommended so the fact's row carries a
 * back-link to the source conversation (FEATURES.md §5 spec field).
 */
import { confirmationRequired } from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: ["Tone", "Workflow", "Scope", "Schedule", "Other", "Business"],
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
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved saving this exact fact in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with the fact to relay to the user for approval.",
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
    !["Tone", "Workflow", "Scope", "Schedule", "Other", "Business"].includes(category)
  ) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "category must be one of Tone|Workflow|Scope|Schedule|Other|Business" },
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

  // Confirmation gate — AFTER validation (a malformed call should fail
  // loudly, not ask the user to approve garbage) and BEFORE any write.
  // The details block mirrors the WARP-640 confirmation shape (`type`
  // discriminator) so the dashboard chip renders a meaningful "needs
  // approval" state and a future one-click approve can extend it.
  if (args.confirmed !== true) {
    return confirmationRequired(
      `I'd like to remember this ${category.toLowerCase()} fact: "${fact}". ` +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      { type: "memory_fact_save", category, fact, evidenceChatId },
    );
  }

  const created = await ctx.prisma.memoryFact.create({
    data: {
      category: category as
        | "Tone"
        | "Workflow"
        | "Scope"
        | "Schedule"
        | "Other"
        | "Business",
      fact,
      evidenceChatId,
      addedBy: ctx.userId ?? "agent",
      // WARP-845 — model-extracted facts default to the household
      // (family) audience. Widening to guest or narrowing to
      // admin/owner is a human decision made in the Memory panel, not
      // something the model controls.
      audience: "family",
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
    "Persist a durable memory fact about the user or workspace. Use when the conversation reveals a preference, recurring workflow, scope assumption, or schedule the user has stated. Two-step: the first call returns confirmation_required with the proposed fact — relay it to the user, and only after they explicitly approve, re-issue the SAME call with confirmed: true. Pair with memory_recall to check if the fact already exists before extracting.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
