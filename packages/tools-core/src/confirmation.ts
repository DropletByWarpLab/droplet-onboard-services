/**
 * Tier-2 confirmation for LLM tools (WARP-640, WARP-2002).
 *
 * ## Why a server-minted token and not a boolean
 *
 * Until WARP-2002, eleven write tools enforced `requiresConfirmation: true` by
 * reading a `confirmed` boolean out of their OWN input schema — i.e. out of the
 * JSON the model emits. Nothing between the model and the handler checked that
 * a human had ever said yes, and the agent loop classifies
 * `confirmation_required` as `ok: true` ("a UX pause, not a failure") and
 * appends it to the conversation, so the model could re-issue the identical
 * call with `confirmed: true` inside the same turn. That is self-attestation,
 * not confirmation.
 *
 * The decision now lives in a token this process mints and holds. A handler
 * resolves its target, mints a token bound to (toolName, fingerprint), and
 * returns `confirmation_required`. Only a caller presenting that exact token
 * can execute, once, before it expires.
 *
 * ## The token must never reach the model
 *
 * A minted token is only a control if the model cannot read it. The agent loop
 * feeds the raw tool-result JSON back to the model as the tool's reply
 * (`llm-agent.service.ts`, `messages.push({ role: "tool", content: text })`),
 * and the same `error.details` object is what the dashboard chip reads. So the
 * token is placed in `details` for the chip, and the orchestrator REDACTS it
 * from the model-visible copy (`redactConfirmationTokens`). Both halves are
 * required: minting without redacting reproduces the original bug with extra
 * steps.
 *
 * ## Scope
 *
 * The store is per-orchestrator-process, deliberately — a box runs one
 * orchestrator, and the pending set is small and short-lived. This is the same
 * posture as `pendingSceneConfirms` in `routes/scenes.ts`. Do not reach for
 * Redis without a second orchestrator to justify it.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ToolResult } from "./types.js";

/** Long enough for a human to read a chip and click; short enough that a
 *  forgotten prompt cannot be executed an hour later. */
export const CONFIRMATION_TTL_MS = 5 * 60_000;

/** Hard cap on outstanding confirmations, mirroring MAX_PENDING_SCENE_CONFIRMS.
 *  Bounds memory against a model that spams confirmable calls in a loop. */
export const MAX_PENDING_CONFIRMATIONS = 200;

interface PendingConfirmation {
  toolName: string;
  fingerprint: string;
  expiresAt: number;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

/**
 * Stable hash of a RESOLVED side-effect target — node id, event id, path,
 * thread id. Binding the token to this is what stops a token minted for
 * device A from executing against device B.
 *
 * It is a hash, not the raw value, because the fingerprint is compared against
 * data that may be credential material (a Matter pairing code) and because
 * `error.details` is echoed into the SSE stream and the chat transcript.
 */
export function confirmationFingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Drop expired entries. Opportunistic — there is no timer to leak. */
function collectExpired(now: number): void {
  for (const [token, pending] of pendingConfirmations) {
    if (pending.expiresAt <= now) pendingConfirmations.delete(token);
  }
}

/**
 * Mint a single-use token bound to this tool and this resolved target.
 *
 * Returns `null` when the pending set is at its cap, which the caller must
 * surface as a refusal — never as a silent execution.
 */
export function mintToolConfirmation(
  toolName: string,
  fingerprint: string,
): { confirmationToken: string; expiresAt: number } | null {
  const now = Date.now();
  collectExpired(now);
  if (pendingConfirmations.size >= MAX_PENDING_CONFIRMATIONS) return null;

  const confirmationToken = randomBytes(32).toString("hex");
  const expiresAt = now + CONFIRMATION_TTL_MS;
  pendingConfirmations.set(confirmationToken, { toolName, fingerprint, expiresAt });
  return { confirmationToken, expiresAt };
}

/**
 * Validate and burn a token. True ONLY when it exists, is unexpired, was minted
 * for THIS tool, and was minted for THIS target.
 *
 * The entry is deleted BEFORE validation, so a token is spent even when the
 * check fails. That makes replay impossible and denies an attacker a probe that
 * leaves the token usable. Accepts `unknown` because it comes straight off the
 * model-supplied argument bag.
 */
export function consumeToolConfirmation(
  token: unknown,
  toolName: string,
  fingerprint: string,
): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const pending = pendingConfirmations.get(token);
  if (!pending) return false;
  pendingConfirmations.delete(token);
  return (
    pending.expiresAt > Date.now() &&
    pending.toolName === toolName &&
    pending.fingerprint === fingerprint
  );
}

/** Test seam only — the store is process-global, so suites must isolate. */
export function __resetToolConfirmations(): void {
  pendingConfirmations.clear();
}

/** What a handler passes to mint a token alongside its prompt. */
export interface ConfirmationMint {
  toolName: string;
  fingerprint: string;
}

/**
 * Build a `confirmation_required` result.
 *
 * With `mint`, a token is issued and embedded in `error.details` so the
 * dashboard's "Approve & run" chip renders. The orchestrator strips it from
 * whatever it hands back to the model.
 */
export function confirmationRequired(
  message: string,
  details?: unknown,
  mint?: ConfirmationMint,
): ToolResult {
  let payload = details;

  if (mint) {
    const minted = mintToolConfirmation(mint.toolName, mint.fingerprint);
    if (!minted) {
      // At cap: refuse loudly. Returning confirmation_required with no token
      // would strand the user on a chip that can never be approved.
      return {
        ok: false,
        status: "error",
        error: {
          code: "TOO_MANY_PENDING_CONFIRMATIONS",
          message:
            "Too many actions are waiting for approval right now. " +
            "Approve or dismiss the pending ones and try again.",
        },
      };
    }
    const base =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    payload = {
      ...base,
      confirmationToken: minted.confirmationToken,
      confirmationExpiresAt: new Date(minted.expiresAt).toISOString(),
    };
  }

  return {
    ok: false,
    status: "confirmation_required",
    error: {
      code: "CONFIRMATION_REQUIRED",
      message,
      details: payload,
    },
  };
}

export function isConfirmationResponse(res: Response): boolean {
  return res.status === 202;
}

export async function passThroughConfirmation(res: Response): Promise<ToolResult> {
  const body = await res.json().catch(() => ({}));
  const message =
    typeof body === "object" && body && "reason" in body && typeof body.reason === "string"
      ? body.reason
      : "This action requires user confirmation in the Droplet dashboard.";
  return confirmationRequired(message, body);
}
