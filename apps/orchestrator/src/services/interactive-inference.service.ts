/**
 * WARP-2979 (ADR-059 P4 §6.9.2, D17) — how the box knows chat is busy.
 *
 * An in-flight counter on the two interactive LLM routes, `POST
 * /api/llm/chat` (typed chat and voice) and `POST /api/llm/complete`,
 * mounted in app.ts immediately before the LLM router. Background model work
 * — Droplet's incident summaries first of all — reads it and yields:
 *
 *   · `interactiveInferenceIdle(now)`: nothing in flight AND the last
 *     interactive request ended at least 30 s ago (people ask follow-ups);
 *   · `onInteractiveInferenceStart(fn)`: `fn` runs synchronously when an
 *     interactive request starts, so a background call already running can
 *     abort at once.
 *
 * Why the ROUTE and not the model calls: a chat turn is several model calls
 * with tool runs between them. A counter on the calls would let background
 * work slip into those gaps and make the turn's next step wait behind it.
 * Why not the gateway's metrics: they cannot say whether the active request
 * is someone chatting.
 *
 * Not counted (all background, each behind the gateway queue at its own
 * priority): agent runs, filing, the brain pass, and model warm-up.
 *
 * Exactly once: +1 when the request enters, −1 on the FIRST of the
 * response's `finish` (it was sent) or `close` (the client went away, or the
 * socket died) — success, a thrown error handled by the error middleware, a
 * refusal before the handler, and a client abort alike. In memory: one
 * orchestrator process per box.
 */
import type { NextFunction, Request, Response } from "express";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("interactive-inference");

/** How long after the last interactive request ends before background model work may start. */
export const INTERACTIVE_QUIET_MS = 30_000;

export interface InteractiveInferenceState {
  inFlight: number;
  lastStartedAt: number | null;
  lastEndedAt: number | null;
}

const state: InteractiveInferenceState = { inFlight: 0, lastStartedAt: null, lastEndedAt: null };
const startListeners = new Set<() => void>();

/** A snapshot, for health and tests. */
export function interactiveInferenceState(): Readonly<InteractiveInferenceState> {
  return { ...state };
}

/** Test seam — module state survives between tests otherwise. */
export function _resetInteractiveInferenceForTests(): void {
  state.inFlight = 0;
  state.lastStartedAt = null;
  state.lastEndedAt = null;
  startListeners.clear();
}

/** Express middleware: +1 on a POST, −1 exactly once on `finish` or `close`. */
export function trackInteractiveInference(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "POST") {
    next();
    return;
  }
  state.inFlight += 1;
  state.lastStartedAt = Date.now();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.lastEndedAt = Date.now();
  };
  res.on("finish", release);
  res.on("close", release);
  for (const fn of [...startListeners]) {
    try {
      fn();
    } catch (err) {
      // A listener's bug must never cost someone their chat.
      logger.warn({ err }, "interactive inference start listener threw");
    }
  }
  next();
}

/** True when nothing is in flight and the last interactive request ended ≥ `quietMs` ago. */
export function interactiveInferenceIdle(now: number, quietMs: number = INTERACTIVE_QUIET_MS): boolean {
  if (state.inFlight > 0) return false;
  return state.lastEndedAt === null || now - state.lastEndedAt >= quietMs;
}

/** Called synchronously when an interactive request starts; returns an unsubscribe. */
export function onInteractiveInferenceStart(fn: () => void): () => void {
  startListeners.add(fn);
  return () => {
    startListeners.delete(fn);
  };
}
