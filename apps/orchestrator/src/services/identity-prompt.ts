/**
 * Droplet identity prompt — the "what this box is and does" block that
 * leads the server-side base system prompt for every /api/llm/chat
 * caller (dashboard chat, voice-io, external MCP clients), so all
 * surfaces share one identity and tone.
 *
 * The canonical text lives in `data/droplet-identity.md` (bundled into
 * the image next to `data/oui.csv`) so the product voice is reviewable
 * prose, not a string literal buried in a route. Loaded once, lazily;
 * a missing or oversized file degrades to the legacy one-line identity
 * so a broken deploy can't take chat down.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("identity-prompt");

/** Legacy identity line — also the fail-open fallback. */
export const FALLBACK_IDENTITY =
  "You are the Droplet AI assistant, running locally on the user's Droplet appliance.";

/**
 * Hard cap so a runaway edit can't blow the local model's context
 * window — the box's model runs with a few-thousand-token num_ctx
 * shared with the tool list, pins, history, and attachments (see the
 * WARP-854 empty-completion note in routes/llm.ts). 4k chars ≈ 1k
 * tokens, already generous for an identity block.
 */
export const IDENTITY_MAX_CHARS = 4000;

let cached: string | null = null;

export function defaultIdentityPath(): string {
  return (
    process.env.DROPLET_IDENTITY_PATH ??
    path.resolve(process.cwd(), "data/droplet-identity.md")
  );
}

/**
 * Read + cache the identity prompt. Best-effort by design: every
 * failure path returns FALLBACK_IDENTITY rather than throwing, because
 * a chat turn without the long identity beats no chat turn at all.
 */
export function loadIdentityPrompt(filePath?: string): string {
  if (cached !== null) return cached;
  const p = filePath ?? defaultIdentityPath();
  if (!existsSync(p)) {
    log.warn({ path: p }, "droplet-identity.md missing — using fallback identity");
    cached = FALLBACK_IDENTITY;
    return cached;
  }
  try {
    let text = readFileSync(p, "utf8").trim();
    if (text.length === 0) {
      log.warn({ path: p }, "droplet-identity.md empty — using fallback identity");
      cached = FALLBACK_IDENTITY;
      return cached;
    }
    if (text.length > IDENTITY_MAX_CHARS) {
      log.warn(
        { path: p, length: text.length, cap: IDENTITY_MAX_CHARS },
        "droplet-identity.md over budget — truncating",
      );
      text = text.slice(0, IDENTITY_MAX_CHARS);
    }
    cached = text;
  } catch (err) {
    log.warn({ err, path: p }, "droplet-identity.md load failed — using fallback identity");
    cached = FALLBACK_IDENTITY;
  }
  return cached;
}

/** Test hook — drops the module cache so tests can exercise each path. */
export function resetIdentityPromptCache(): void {
  cached = null;
}
