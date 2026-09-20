/**
 * WARP-1425 — `memory_forget` LLM tool.
 *
 * Soft-disables a remembered fact (`active=false`) so it stops
 * influencing the model; the row is retained for the evidence chain.
 * Tier 2 (write + requires confirmation). Since WARP-2305 the
 * `requiresConfirmation` flag IS enforced generically, in the dispatch
 * path, by the interceptor in `../../interceptor.ts`: it refuses the
 * first call, mints a single-use token bound to this tool name and these
 * exact arguments, and runs this handler only once that token comes back.
 * (Before WARP-2305 neither the MCP server nor the agent loop enforced
 * the flag, and the four lines below were the only thing standing between
 * this tool and an unconfirmed write. That is no longer true — do not
 * copy the pattern into a new tool merely to satisfy the flag. See
 * `docs/tool-confirmation-contract.md`.)
 *
 * The handler-side gate below is retained because its DECISION is
 * domain-specific, not generic: it echoes the fact text so the user can
 * see what they are approving. The interceptor does not double-prompt it
 * — on a call whose token verified, the interceptor sets `confirmed:
 * true` (this tool's schema declares it), so the gate passes and the
 * write proceeds. Same two-phase contract as `memory_extract_fact`.
 *
 * WARP-845 audience gate: a fact whose `audience` is not visible to the
 * caller's role must be indistinguishable from a missing one — the
 * handler returns the SAME `NOT_FOUND` error (identical message, never
 * echoing the fact text) so existence never leaks across the ladder.
 */
import { confirmationRequired } from "../../confirmation.js";
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
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved forgetting this exact fact in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with the fact to relay to the user for approval.",
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
  if (args.confirmed !== true) {
    return confirmationRequired(
      `I'd like to forget this ${String(fact.category).toLowerCase()} fact: "${fact.fact}". ` +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      { type: "memory_forget", id: fact.id, category: fact.category, fact: fact.fact },
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
    "Permanently stop a remembered fact from influencing the model — soft-disables it (active=false; the row is retained for the evidence chain). Use when the user asks to forget, retract, or stop applying a remembered fact. Two-step: the first call returns confirmation_required with the fact — relay it to the user, and only after they explicitly approve, re-issue the SAME call with confirmed: true. Find fact ids via memory_recall.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
