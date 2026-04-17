/**
 * Typed fetch helper for the dashboard. Reads the JSON body; on non-ok response,
 * throws an Error carrying `.code` (from `body.error.code` if present, else "UNKNOWN")
 * and `.status` (the HTTP status). Also exposes the full response body on the
 * thrown error via `.body`, so callers that need to inspect non-typed envelope
 * fields (e.g. `requiresConfirmation`) can do so without re-fetching.
 *
 * Used across device / group / block mutations so rollback + toast copy
 * handlers can key on typed error codes consistently.
 */
export interface TypedError extends Error {
  code?: string;
  status?: number;
  body?: unknown;
}

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
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
