/**
 * WARP-538 — update-agent settings persistence.
 *
 * Three operator knobs (surfaced by the WARP-540 dashboard page later):
 *   - `channel`         — release channel the poller accepts, and (since
 *                         WARP-1670) the one it DISCOVERS from: `stable`
 *                         boxes read GitHub's `latest` release, `stage`
 *                         boxes read the newest `ota-stage-*` prerelease.
 *                         Which branch a box tracks is this one value.
 *   - `applyWindowCron` — cron spec of the maintenance window
 *                         (`0 3 * * *` = 03:00 daily, per the design).
 *   - `autoApply`       — whether the window handler applies a pending
 *                         update unattended (WARP-539) or waits for an
 *                         explicit apply-now (WARP-540).
 *
 * Storage is one `SystemFlag` row (`update-agent.settings`) — a JSON
 * value keyed by a stable name, exactly what SystemFlag exists for. No
 * new table, no env: env vars configure the DEPLOYMENT (poll URL/token/
 * interval, src/config.ts); these are OPERATOR settings that must
 * survive image swaps and be editable from the dashboard.
 *
 * Reads are tolerant (unknown/invalid stored fields fall back to
 * defaults — a corrupt row must never brick the update agent); writes
 * are strict (invalid input is refused loudly).
 */
import type { PrismaClient } from "@prisma/client";
import type pino from "pino";
import cron from "node-cron";
import { createLogger } from "../../lib/logger.js";

const defaultLog = createLogger("update-agent");

export const UPDATE_AGENT_SETTINGS_KEY = "update-agent.settings";

/**
 * WARP-1670 — the release channels a box may subscribe to, one per
 * release branch. Must stay in lockstep with `ALLOWED_CHANNELS` in
 * scripts/release/gen-release-manifest.py and the branch alternation in
 * scripts/lib/apply-update.sh's cosign identity regexp.
 *
 *   stable — refs/heads/main; GitHub's `latest` release
 *   stage  — refs/heads/stage; newest `ota-stage-*` prerelease
 */
export const RELEASE_CHANNELS = ["stable", "stage"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export function isReleaseChannel(value: string): value is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly string[]).includes(value);
}

export interface UpdateAgentSettings {
  channel: string;
  applyWindowCron: string;
  autoApply: boolean;
}

export const DEFAULT_UPDATE_AGENT_SETTINGS: UpdateAgentSettings = {
  channel: "stable",
  applyWindowCron: "0 3 * * *",
  autoApply: true,
};

/** Tolerant merge of a stored JSON blob over the defaults. */
function sanitizeStored(stored: unknown): UpdateAgentSettings {
  const out = { ...DEFAULT_UPDATE_AGENT_SETTINGS };
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return out;
  }
  const rec = stored as Record<string, unknown>;
  if (typeof rec.channel === "string" && rec.channel.trim() !== "") {
    out.channel = rec.channel;
  }
  if (
    typeof rec.applyWindowCron === "string" &&
    cron.validate(rec.applyWindowCron)
  ) {
    out.applyWindowCron = rec.applyWindowCron;
  }
  if (typeof rec.autoApply === "boolean") {
    out.autoApply = rec.autoApply;
  }
  return out;
}

export async function getUpdateAgentSettings(
  prisma: PrismaClient,
): Promise<UpdateAgentSettings> {
  const row = await prisma.systemFlag.findUnique({
    where: { key: UPDATE_AGENT_SETTINGS_KEY },
  });
  return sanitizeStored(row?.valueJson);
}

/**
 * Strictly-validated partial update. Throws on invalid input — the
 * WARP-540 route layer turns that into a 400; nothing invalid ever
 * reaches the stored row.
 */
export async function saveUpdateAgentSettings(
  prisma: PrismaClient,
  patch: Partial<UpdateAgentSettings>,
  logger: pino.Logger = defaultLog,
): Promise<UpdateAgentSettings> {
  if (patch.channel !== undefined) {
    if (typeof patch.channel !== "string" || patch.channel.trim() === "") {
      throw new Error("update-agent settings: channel must be a non-empty string");
    }
    // WARP-1670: writes are strict about the channel set even though reads
    // stay tolerant. A typo'd channel is not a harmless setting — it decides
    // which branch's builds this box installs, so it fails at the write,
    // where an operator is present to read the error.
    if (!isReleaseChannel(patch.channel)) {
      throw new Error(
        `update-agent settings: unknown channel ${patch.channel}; known channels: ${RELEASE_CHANNELS.join(", ")}`,
      );
    }
  }
  if (patch.applyWindowCron !== undefined) {
    if (
      typeof patch.applyWindowCron !== "string" ||
      !cron.validate(patch.applyWindowCron)
    ) {
      throw new Error(
        `update-agent settings: applyWindowCron is not a valid cron expression: ${String(patch.applyWindowCron)}`,
      );
    }
  }
  if (patch.autoApply !== undefined && typeof patch.autoApply !== "boolean") {
    throw new Error("update-agent settings: autoApply must be a boolean");
  }

  const current = await getUpdateAgentSettings(prisma);
  const next: UpdateAgentSettings = {
    channel: patch.channel ?? current.channel,
    applyWindowCron: patch.applyWindowCron ?? current.applyWindowCron,
    autoApply: patch.autoApply ?? current.autoApply,
  };

  await prisma.systemFlag.upsert({
    where: { key: UPDATE_AGENT_SETTINGS_KEY },
    create: { key: UPDATE_AGENT_SETTINGS_KEY, valueJson: { ...next } },
    update: { valueJson: { ...next } },
  });

  // WARP-541 audit event — these knobs steer what the box will install
  // (channel) and when (window/autoApply), so a change is lifecycle
  // signal, not chatter. Values are operator config, never secrets.
  if (
    next.channel !== current.channel ||
    next.applyWindowCron !== current.applyWindowCron ||
    next.autoApply !== current.autoApply
  ) {
    logger.info(
      { event: "update.settings_changed", previous: current, next },
      "update-agent settings changed",
    );
  }

  return next;
}
