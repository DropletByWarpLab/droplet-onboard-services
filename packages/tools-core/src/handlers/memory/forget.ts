/**
 * WARP-1425 — `memory_forget` LLM tool.
 *
 * Soft-disables a remembered fact (`active=false`) so it stops
 * influencing the model; the row is retained for the evidence chain.
 * Tier 2 (write + requires confirmation), enforced BY THE HANDLER:
 * neither the MCP server nor the agent loop enforces the
 * `requiresConfirmation` flag generically, so the first call returns
 * `confirmation_required` (no write) with the fact echoed in the
 * message. The model relays it to the user and re-issues the call with
 * `confirmed: true` only after the user explicitly approves — same
 * handler-enforced two-phase contract as `memory_extract_fact`.
 *
 * WARP-845 audience gate: a fact whose `audience` is not visible to the
 * caller's role must be indistinguishable from a missing one — the
 * handler returns the SAME `NOT_FOUND` error (identical message, never
 * echoing the fact text) so existence never leaks across the ladder.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";

const TOOL_NAME = "memory_forget";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** WARP-845 — audience ladder (mirror of the orchestrator's
 *  memory-audience.ts; tools-core cannot import orchestrator code).
 *  A caller reads audiences at or below their role rank; absent role →
 *  guest view (most restrictive). */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  service: 1,
  guest: 0,
};
const AUDIENCES = ["owner", "admin", "family", "guest"] as const;
const AUDIENCE_RANK: Record<(typeof AUDIENCES)[number], number> = {
  owner: 3,
  admin: 2,
  family: 1,
  guest: 0,
};
function visibleAudiences(
  role: string | undefined,
): (typeof AUDIENCES)[number][] {
  const rank = ROLE_RANK[role ?? ""] ?? 0;
  return AUDIENCES.filter((a) => AUDIENCE_RANK[a] <= rank) as (typeof AUDIENCES)[number][];
}

/** Shared by the missing-id, already-inactive, AND audience-gated
 *  branches — an invisible fact must read exactly like a missing one. */
const NOT_FOUND: ToolResult = {
  ok: false,
  status: "error",
  error: { code: "NOT_FOUND", message: "no active fact with that id" },
};

const inputSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description:
        "UUID of the MemoryFact to forget. Find fact ids via memory_recall.",
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the action, and the user approves from that prompt.",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (id.length === 0) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "id is required" },
    };
  }

  const fact = await ctx.prisma.memoryFact.findUnique({ where: { id } });
  if (!fact || fact.active === false) {
    return NOT_FOUND;
  }

  // WARP-845 — audience gate. A fact the caller may not read must be
  // indistinguishable from a missing one: same error, and the fact text
  // is never echoed on this branch.
  if (!visibleAudiences(ctx.role).includes(fact.audience as (typeof AUDIENCES)[number])) {
    return NOT_FOUND;
  }

  // Confirmation gate — AFTER validation and visibility (a malformed or
  // invisible id should fail loudly, not ask the user to approve it)
  // and BEFORE the write. The details block mirrors the WARP-640
  // confirmation shape (`type` discriminator) so the dashboard chip
  // renders a meaningful "needs approval" state.
  const fingerprint = confirmationFingerprint([TOOL_NAME, fact.id]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      `I'd like to forget this ${String(fact.category).toLowerCase()} fact: "${fact.fact}". ` +
        "Ask the user to approve. " +
        "You cannot approve on their behalf.",
      { type: "memory_forget", id: fact.id, category: fact.category, fact: fact.fact },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  await ctx.prisma.memoryFact.update({
    where: { id },
    data: { active: false },
  });

  return {
    ok: true,
    data: {
      type: "memory_forget",
      id: fact.id,
      forgotten: true,
      fact: fact.fact,
      category: fact.category,
    },
  };
}

const tool: Tool = {
  name: "memory_forget",
  description:
    "Permanently stop a remembered fact from influencing the model — soft-disables it (active=false; the row is retained for the evidence chain). Use when the user asks to forget, retract, or stop applying a remembered fact. Two-step: the first call returns confirmation_required with the fact — relay it to the user, and only after they explicitly approve, approval is handled outside this conversation. Find fact ids via memory_recall.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
