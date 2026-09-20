/**
 * WARP-2823 (ADR-002 admin console, slice 3) — the system prompt a given
 * person's assistant is actually handed.
 *
 * ── Composed, never described ──────────────────────────────────────────────
 *
 * Every block below is produced by calling the SHIPPED composer, on the
 * TARGET's role, and then assembled through `buildBaseSystemPrompt` — the same
 * function `routes/llm.ts` calls. Nothing here re-states what a block
 * "usually" contains. The moment this file describes a block instead of
 * composing it, the page starts being right by coincidence.
 *
 * ── The fail-open inversion, which is the whole subtlety ───────────────────
 *
 * 🔴 On a chat turn every composer FAILS OPEN: a persona read that throws
 * yields "" and the turn proceeds without a persona block. That is correct
 * for a turn — an unreadable ornament must not cost the user their answer —
 * and `prompt-block-fixtures.ts` pins it.
 *
 * For an inspector it is a lie. "No persona block" and "the persona block is
 * broken" render identically as an absence, and the second is precisely the
 * condition an admin opened this page to find. So every composer here is
 * called inside its own boundary and a throw becomes `status: "errored"`,
 * never `""`. This is the one place the inspector deliberately does NOT
 * inherit the turn's behaviour, and the reason is that it has a different job.
 *
 * ── What it is not ─────────────────────────────────────────────────────────
 *
 * Read-only. It resolves the TARGET's identity and composes at the TARGET's
 * role; it never falls back to the caller's. A page that quietly showed an
 * admin their own prompt while captioned with somebody else's name would be
 * the most convincing possible way to be wrong.
 */
import type { PrismaClient } from "@prisma/client";

import {
  buildBaseSystemPrompt,
  buildMemoryFactsBlock,
} from "./system-prompt.service.js";
import { loadIdentityPrompt, IDENTITY_MAX_CHARS } from "./identity-prompt.js";
import { composeToolGuidance } from "./tool-guidance.service.js";
import { getPersona, composePersonaBlock } from "./persona.service.js";
import {
  getBusinessProfile,
  composeBusinessBlock,
  type WorkspaceTypeName,
} from "./business-profile.service.js";
import { buildBrainBlock, BRAIN_BLOCK_CHAR_BUDGET } from "./brain/brain-block.service.js";
import { INTERVIEW_CONDUCTOR_BLOCK } from "./business-onboarding.service.js";
import { OFF_LAN_WITHHELD_NOTICE } from "./stored-content-egress.service.js";
import { CONTEXT_PIN_BLOCK_MAX_CHARS } from "./context-pin-prompt.js";
import { MEMORY_FACTS_CHAR_BUDGET } from "./tool-budget.service.js";
import {
  PERSONA_PROMPT_MAX_CHARS,
  BUSINESS_CONTEXT_MAX_CHARS,
  TOOL_GUIDANCE_MAX_CHARS,
  INTERVIEW_PROMPT_MAX_CHARS,
} from "./prompt-budget.consts.js";
import {
  resolveAttributedToolAccess,
  type AttributionFailure,
} from "./tool-access.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("prompt-inspect");

export type PromptBlockStatus =
  /** Composed, non-empty — this text is in the prompt. */
  | "present"
  /** Composed and legitimately empty: no persona set, HOME box, no facts. */
  | "absent"
  /** The composer THREW. On a turn this would silently be an absence. */
  | "errored"
  /** Present, but the budget gate would drop it on this turn. */
  | "dropped"
  /** Real, and outside what this inspector can reconstruct — see `note`. */
  | "not_modelled";

export interface PromptBlockView {
  /** Stable machine key. The UI's grouping and the tests both key on this. */
  key: string;
  /** What to call it on screen. */
  label: string;
  status: PromptBlockStatus;
  /** The composed text. Null for every status except `present`/`dropped`. */
  text: string | null;
  chars: number;
  /** The block's own char budget, or null where it has none. */
  cap: number | null;
  /**
   * True for blocks `degradeToFit` can never drop. Stated per block rather
   * than inferred from a list in the UI, because "which blocks survive an
   * overflow" is exactly the kind of fact that rots when it lives in a second
   * place.
   */
  neverDropped: boolean;
  /** Set when `status` is `errored` or `not_modelled`. */
  note?: string;
}

export interface PromptInspectResult {
  targetUserId: string;
  /** The tier the blocks were composed at, read off the User row. */
  tier: string | null;
  unresolved: AttributionFailure | null;
  blocks: PromptBlockView[];
  /**
   * The assembled base system message, exactly as `routes/llm.ts` would build
   * it for this person on this turn — identity + persona + business + tool
   * guidance, then memory, brain, interview and the off-LAN notice.
   *
   * The literal string, not a rendering of it. An admin reading a summary of
   * the prompt is reading somebody's opinion about the prompt.
   */
  assembled: string;
  assembledChars: number;
  /** Any composer that threw. Non-empty means the page is reporting a defect. */
  erroredBlocks: string[];
}

export interface PromptInspectInput {
  targetUserId: string;
  /**
   * The tool names to compose tool guidance from — the TARGET's advertised
   * set, produced by `tool-inspect.service.ts`.
   *
   * 🔴 Passed in rather than recomputed. `composeToolGuidance` must never name
   * a tool the person cannot call (WARP-642: a small local model instructed to
   * use a stripped tool walks straight into the hallucinated-tool guard), and
   * the only set that satisfies that is the one the tool inspector already
   * derived. Recomputing it here would be a second answer to a question that
   * already has one.
   *
   * `undefined` means "privileged caller, every tool", matching
   * `buildBaseSystemPrompt`'s own contract for the parameter.
   */
  allowedToolNames?: string[];
  /** Model an interview turn. */
  interview?: boolean;
  /** Model an off-LAN turn. */
  offLan?: boolean;
}

/**
 * Run one composer under its own boundary.
 *
 * The catch is the point of the whole function: see the header. The error is
 * reported by CLASS and not by message — a Prisma error message can carry
 * fragments of the row it failed on, and this response is rendered on a screen
 * and copied into tickets. The class plus the block name is enough to know
 * where to look; the message is in the box logs, which is where a value
 * belongs.
 */
async function compose(
  key: string,
  label: string,
  cap: number | null,
  neverDropped: boolean,
  fn: () => string | Promise<string>,
): Promise<PromptBlockView> {
  try {
    const text = await fn();
    return {
      key,
      label,
      status: text.length > 0 ? "present" : "absent",
      text: text.length > 0 ? text : null,
      chars: text.length,
      cap,
      neverDropped,
    };
  } catch (err) {
    logger.error({ err, block: key }, "prompt_inspect_composer_failed");
    return {
      key,
      label,
      status: "errored",
      text: null,
      chars: 0,
      cap,
      neverDropped,
      note:
        `This block could not be composed (${err instanceof Error ? err.name : "unknown error"}). ` +
        `On a real conversation it would be silently missing. The details are in the box logs.`,
    };
  }
}

/**
 * The prompt one person's assistant receives, block by block.
 *
 * Composed at the TARGET's tier throughout. Where the identity cannot be
 * established the result carries `unresolved` and no blocks are composed at
 * all — guessing a tier in order to render something would produce a prompt
 * nobody ever receives, which is worse than an empty page that says why.
 */
export async function inspectPromptForPerson(
  prisma: PrismaClient,
  input: PromptInspectInput,
): Promise<PromptInspectResult> {
  const attributed = await resolveAttributedToolAccess(prisma, input.targetUserId);
  const tier = attributed.tier;

  if (attributed.unresolved) {
    return {
      targetUserId: input.targetUserId,
      tier: null,
      unresolved: attributed.unresolved,
      blocks: [],
      assembled: "",
      assembledChars: 0,
      erroredBlocks: [],
    };
  }

  const role = tier ?? undefined;
  const interview = input.interview ?? false;
  const offLan = input.offLan ?? false;

  const identity = await compose(
    "identity",
    "Who Droplet is",
    IDENTITY_MAX_CHARS,
    true,
    () => loadIdentityPrompt(),
  );
  const persona = await compose(
    "persona",
    "Personality",
    PERSONA_PROMPT_MAX_CHARS,
    false,
    async () => composePersonaBlock(await getPersona(prisma)),
  );
  const business = await compose(
    "business",
    "About this business",
    BUSINESS_CONTEXT_MAX_CHARS,
    false,
    async () => {
      // The route's own gate, in the route's own order: a HOME box composes
      // nothing, and a missing singleton reads as BUSINESS (WARP-1341).
      const workspace = await prisma.workspace.findUnique({ where: { id: 1 } });
      const workspaceType = (workspace?.type ?? "BUSINESS") as WorkspaceTypeName;
      if (workspaceType !== "BUSINESS") return "";
      return composeBusinessBlock(role, await getBusinessProfile(prisma), workspaceType);
    },
  );
  const toolGuidance = await compose(
    "tool_guidance",
    "How to use its tools",
    TOOL_GUIDANCE_MAX_CHARS,
    true,
    () => composeToolGuidance(input.allowedToolNames),
  );
  const memory = await compose(
    "memory",
    "Things it was told to remember",
    MEMORY_FACTS_CHAR_BUDGET,
    true,
    () => buildMemoryFactsBlock(prisma, role),
  );
  const brain = await compose(
    "brain",
    "What it worked out about this business",
    BRAIN_BLOCK_CHAR_BUDGET,
    false,
    () => buildBrainBlock(prisma, { id: input.targetUserId, role: role ?? "" }),
  );
  const interviewBlock = await compose(
    "interview",
    "Setup conductor",
    INTERVIEW_PROMPT_MAX_CHARS,
    true,
    () => (interview ? INTERVIEW_CONDUCTOR_BLOCK : ""),
  );
  const offLanBlock = await compose(
    "off_lan_notice",
    "Off-network notice",
    null,
    true,
    () => (offLan ? OFF_LAN_WITHHELD_NOTICE : ""),
  );

  // Context pins are real and they are NOT reconstructed here. They are pinned
  // per conversation, and rendering them needs the pin rows plus the resolved
  // targets the route loads for that conversation — inputs a person-level
  // inspector does not have. Reporting them as "absent" would be a false
  // negative on a person whose every turn carries four pins, so the block says
  // what it is instead of guessing.
  const pins: PromptBlockView = {
    key: "context_pins",
    label: "Pinned context",
    status: "not_modelled",
    text: null,
    chars: 0,
    cap: CONTEXT_PIN_BLOCK_MAX_CHARS,
    neverDropped: true,
    note:
      "Pins belong to a conversation, not to a person, and are prepended as " +
      "their own system message. This view is per person, so it does not show them.",
  };

  const blocks = [
    identity,
    persona,
    business,
    toolGuidance,
    memory,
    brain,
    interviewBlock,
    offLanBlock,
    pins,
  ];

  // Assembled through the shipped builder, in the shipped order. The
  // concatenation below mirrors `routes/llm.ts`'s `baseSystemMessage`; keeping
  // the same shape is what makes a difference between this string and the real
  // one a bug in one of them rather than an expected divergence.
  const assembled =
    buildBaseSystemPrompt(
      input.allowedToolNames,
      persona.text ?? "",
      business.text ?? "",
    ) +
    (memory.text ?? "") +
    (brain.text ?? "") +
    (interviewBlock.text ? "\n\n" + interviewBlock.text : "") +
    (offLanBlock.text ? "\n\n" + offLanBlock.text : "");

  return {
    targetUserId: input.targetUserId,
    tier,
    unresolved: null,
    blocks,
    assembled,
    assembledChars: assembled.length,
    erroredBlocks: blocks.filter((b) => b.status === "errored").map((b) => b.key),
  };
}
