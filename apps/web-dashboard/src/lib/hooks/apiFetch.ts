/**
 * Typed fetch helper for the dashboard. Reads the JSON body; on non-ok response,
 * throws an Error carrying `.code` (from `body.error.code` if present, else "UNKNOWN")
 * and `.status` (the HTTP status). Also exposes the full response body on the
 * thrown error via `.body`, so callers that need to inspect non-typed envelope
 * fields (e.g. `requiresConfirmation`) can do so without re-fetching.
 *
 * Used across device / group / block mutations so rollback + toast copy
 * handlers can key on typed error codes consistently.
 *
 * WARP-303: every request is bounded by an `AbortSignal.timeout()` (default
 * 20 s, configurable per call via `timeoutMs`). A caller-supplied `signal` is
 * combined with the timeout signal so component unmounts AND timeouts can both
 * cancel the in-flight request. Timeouts surface as `TypedError` with
 * `code: "TIMEOUT"`, network failures as `"NETWORK_ERROR"`, and explicit
 * aborts as `"ABORTED"` — distinct from the HTTP-envelope codes so callers
 * (and toasts) can tell "the server said no" from "the server never replied".
 */
export interface TypedError extends Error {
  code?: string;
  status?: number;
  body?: unknown;
}

export interface ApiFetchOptions extends RequestInit {
  /**
   * Per-request timeout in milliseconds. Defaults to {@link DEFAULT_API_FETCH_TIMEOUT_MS}.
   * Pass `0` to disable (only do this for true long-poll/SSE/streaming calls).
   */
  timeoutMs?: number;
}

export const DEFAULT_API_FETCH_TIMEOUT_MS = 20_000;

/**
 * Compose two AbortSignals into one that aborts whenever either source does.
 * Prefers the native `AbortSignal.any` (Node ≥ 20.3, Chrome 116+, Safari 17.4+)
 * and falls back to an AbortController-based polyfill for jsdom 24 and any
 * older runtime — so unit tests don't crash on `AbortSignal.any is not a function`.
 */
function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: typeof AbortSignal.any }).any === "function") {
    return AbortSignal.any([a, b]);
  }
  const ctrl = new AbortController();
  if (a.aborted) ctrl.abort((a as AbortSignal & { reason?: unknown }).reason);
  else a.addEventListener("abort", () => ctrl.abort((a as AbortSignal & { reason?: unknown }).reason), { once: true });
  if (b.aborted) ctrl.abort((b as AbortSignal & { reason?: unknown }).reason);
  else b.addEventListener("abort", () => ctrl.abort((b as AbortSignal & { reason?: unknown }).reason), { once: true });
  return ctrl.signal;
}

export async function apiFetch<T = unknown>(
  path: string,
  init?: ApiFetchOptions,
): Promise<T> {
  const { timeoutMs = DEFAULT_API_FETCH_TIMEOUT_MS, signal: callerSignal, ...rest } = init ?? {};

  // Build the effective signal: timeout, caller, or both combined.
  const timeoutSignal: AbortSignal | null = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  let signal: AbortSignal | undefined;
  if (callerSignal && timeoutSignal) {
    signal = composeSignals(callerSignal, timeoutSignal);
  } else {
    signal = callerSignal ?? timeoutSignal ?? undefined;
  }

  let r: Response;
  try {
    r = await fetch(path, { ...rest, signal });
  } catch (err) {
    // Classify the abort source so callers can distinguish timeout from
    // user-initiated cancel from raw network failure. `signal.aborted` on the
    // individual signals is reliable across runtimes; relying on
    // `DOMException.name` is not (Node and browsers disagree on TimeoutError
    // vs AbortError naming).
    if (timeoutSignal?.aborted) {
      const e: TypedError = new Error(`Request timed out after ${timeoutMs}ms: ${path}`);
      e.code = "TIMEOUT";
      e.status = 0;
      throw e;
    }
    if (callerSignal?.aborted) {
      const e: TypedError = new Error(`Request aborted: ${path}`);
      e.code = "ABORTED";
      e.status = 0;
      throw e;
    }
    const e: TypedError = new Error(err instanceof Error ? err.message : "Network error");
    e.code = "NETWORK_ERROR";
    e.status = 0;
    throw e;
  }

  const body = await r.json().catch(() => ({} as unknown));
  if (!r.ok) {
    const typed =
      (body as { error?: { code?: string; message?: string } })?.error ?? {
        code: "UNKNOWN",
        message: `HTTP ${r.status}`,
      };
    const e: TypedError = new Error(typed.message ?? `HTTP ${r.status}`);
    e.code = typed.code;
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return body as T;
}
