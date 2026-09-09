/**
 * WARP-2838 (ADR-051 §9) — is the brain on, and who is allowed to say so.
 *
 * THE PROBLEM THIS EXISTS FOR. `/brief` shipped in the sidebar of every box
 * with an empty state reading "Turn the brain on to start reading your
 * business", and nothing in the product could. `BRAIN_ENABLED` was read in one
 * place (`config.ts`), written nowhere, and present in no deployment file — an
 * owner told to do something with no affordance to do it, which reads as a
 * broken feature rather than an unmade decision. WARP-2733 had already fixed
 * the identical shape for auto-filing by giving the off state its own door.
 *
 * TWO SOURCES, ONE ANSWER. The environment and the database both have a claim
 * on this, and every caller must get the same resolution or the box will act on
 * one while the screen reports the other:
 *
 *   BRAIN_ENABLED set   the environment decides, in BOTH directions, and the
 *                       row is not consulted. Fleet policy outranks a local
 *                       click, and a box pinned OFF must stay off no matter who
 *                       presses what.
 *   BRAIN_ENABLED unset the `BrainSetting` row decides. Absent row = off.
 *
 * 🔴 A PINNED BOX REFUSES THE WRITE — it does not accept it and quietly not
 * read it. Storing `enabled: true` under a pin would leave a consent record
 * saying the owner switched the brain on, on a box where nothing runs, and the
 * next person to read that row would believe it. `setBrainEnabled` throws
 * `brain_switch_pinned` and the route answers 409.
 *
 * 🔴 THE ROW IS NEVER CREATED BY A READ. `readBrainSwitch` does not upsert. A
 * consent record that exists because something looked at it is not consent, and
 * `enabledById`/`enabledAt` would have nothing truthful to hold.
 */
import type { PrismaClient } from "@prisma/client";

import { config } from "../../config.js";

/** Singleton primary key, the `AutoFilingSetting` shape. */
export const BRAIN_SETTING_ID = "singleton";

/** Thrown by `setBrainEnabled` when `BRAIN_ENABLED` is pinned by the operator.
 *  A stable string, mapped to HTTP by `routes/brain.ts` — the `crm.ts` idiom. */
export const BRAIN_SWITCH_PINNED = "brain_switch_pinned";

export interface BrainSwitch {
  /** The effective answer. The only value a caller should branch on. */
  enabled: boolean;
  /** True when `BRAIN_ENABLED` decides and the row cannot. The dashboard shows
   *  the state without a control rather than a control that 409s. */
  pinnedByOperator: boolean;
  /** Consent attribution. Null under a pin: the environment has no actor, and
   *  inventing one would put a name against a decision nobody made here. */
  enabledById: string | null;
  enabledAt: Date | null;
}

/**
 * Resolve the switch.
 *
 * Reads the row even when pinned, because `enabledById`/`enabledAt` are still
 * the honest history of what an owner asked for — but returns them as null so
 * no caller renders a consent stamp beside a state that stamp did not produce.
 */
export async function readBrainSwitch(prisma: PrismaClient): Promise<BrainSwitch> {
  if (config.brain.enabledPinnedByOperator) {
    return {
      enabled: config.brain.enabled,
      pinnedByOperator: true,
      enabledById: null,
      enabledAt: null,
    };
  }
  const row = await prisma.brainSetting.findUnique({ where: { id: BRAIN_SETTING_ID } });
  return {
    enabled: row?.enabled ?? false,
    pinnedByOperator: false,
    enabledById: row?.enabledById ?? null,
    enabledAt: row?.enabledAt ?? null,
  };
}

/**
 * The one question the passes ask.
 *
 * Called per tick rather than per boot. The passes are SCHEDULED whenever the
 * brain could be turned on (see `index.ts`); this is what decides whether a
 * given tick does anything. Gating the schedule on the boot-time value is what
 * made the owner-facing switch a lie in the first draft: flipping it changed a
 * row nothing would read until the next restart.
 */
export async function isBrainEnabled(prisma: PrismaClient): Promise<boolean> {
  return (await readBrainSwitch(prisma)).enabled;
}

/**
 * Should the passes be registered on the cron runtime at all?
 *
 * Everything except a box pinned OFF. A pinned-off box registers nothing, so
 * its inference slot and its database are untouched by a feature its operator
 * has forbidden — the pin is a policy, not a per-tick early return.
 */
export function brainPassesSchedulable(): boolean {
  return !(config.brain.enabledPinnedByOperator && !config.brain.enabled);
}

/**
 * Turn the brain on or off, recording who and when.
 *
 * 🔴 THE ACTOR PAIR IS WRITTEN AND CLEARED IN THE SAME STATEMENT AS `enabled`.
 * `BrainSetting_enabled_has_actor` is a biconditional: an enabled row must name
 * an actor, and a disabled row must carry none. Turning the brain off while
 * leaving the pair populated is `false = true` — a 23514 that rolls back and
 * leaves a row still saying the brain is on, so the off switch would not turn
 * it off. That is not hypothetical; `AutoFilingSetting` shipped it once.
 *
 * `actorId` is the session's user id, stamped by the route. It is never read
 * from the body: a consent record an HTTP client can address to somebody else
 * is not a consent record.
 */
export async function setBrainEnabled(
  prisma: PrismaClient,
  input: { enabled: boolean; actorId: string },
): Promise<BrainSwitch> {
  if (config.brain.enabledPinnedByOperator) throw new Error(BRAIN_SWITCH_PINNED);

  const stamp = input.enabled ? { enabledById: input.actorId, enabledAt: new Date() } : null;

  await prisma.brainSetting.upsert({
    where: { id: BRAIN_SETTING_ID },
    create: {
      id: BRAIN_SETTING_ID,
      enabled: input.enabled,
      enabledById: stamp?.enabledById ?? null,
      enabledAt: stamp?.enabledAt ?? null,
    },
    update: {
      enabled: input.enabled,
      // Re-stamped on every enabling write, not only on the off -> on edge.
      // Unlike `AutoFilingSetting.enabledAt` this is not a backlog boundary —
      // the corpus cursor is on `BrainPass` and is untouched by it — so the
      // most recent consent is the useful one and re-affirming costs nothing.
      enabledById: stamp?.enabledById ?? null,
      enabledAt: stamp?.enabledAt ?? null,
    },
  });

  return readBrainSwitch(prisma);
}
