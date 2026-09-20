/**
 * WARP-1480 — render a thrown value, INCLUDING its cause chain.
 *
 * The `HANDLER_THREW` envelope in `server.ts` used to be built from
 * `err instanceof Error ? err.message : String(err)`, which throws away
 * `err.cause`. For every fetch-backed tool handler that is the single most
 * discriminating value in the system: undici raises `TypeError("fetch failed")`
 * — two words that are identical for a reset socket, a DNS failure and a
 * headers timeout — and puts the actual diagnosis (`ECONNRESET`,
 * `ENOTFOUND`, `UND_ERR_HEADERS_TIMEOUT`) on the cause.
 *
 * `read_file`'s handler does not catch, so a dying fetch lands here. WARP-1480
 * is an INTERMITTENT `read_file` failure, which makes this the value the whole
 * investigation turns on.
 *
 * Pure, total, and never throws — it runs inside a catch block that is the last
 * thing standing between a handler bug and a dead tool call.
 */

/** Depth ceiling on the cause walk. Real chains are 1-2 deep. */
const MAX_CAUSE_DEPTH = 4;
/** Per-link bound, so one giant message can't crowd out the links after it. */
const MAX_PART_LEN = 512;
/** Total bound on the returned string. */
const MAX_TOTAL_LEN = 2048;

const JOINER = " <- caused by: ";

/** A string `code` if the value carries one (Node's ErrnoException, undici's error classes). */
function codeOf(value: unknown): string | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    // A thrown object with a hostile `toString`. Do not let it escape.
    return "<unstringifiable>";
  }
}

/**
 * Render `err` as `"<message> <- caused by: <cause> <- caused by: ..."`.
 *
 * Each link prefers the value's `code` (the errno) over its message, because
 * the errno is the low-cardinality, actionable half. The thrown error's own
 * code is appended in brackets when its message doesn't already contain it —
 * undici's `HeadersTimeoutError` says "Headers Timeout Error" and hides
 * `UND_ERR_HEADERS_TIMEOUT` on the property.
 *
 * Cycle-safe (an identity set, not just the depth cap) and length-bounded.
 */
export function describeThrown(err: unknown): string {
  const head = messageOf(err).slice(0, MAX_PART_LEN);
  const headCode = codeOf(err);
  const parts: string[] = [
    headCode !== undefined && !head.includes(headCode)
      ? `${head} [${headCode}]`
      : head,
  ];

  const seen = new Set<unknown>([err]);
  let cause: unknown = (err as { cause?: unknown } | null | undefined)?.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (cause === null || cause === undefined || seen.has(cause)) break;
    seen.add(cause);
    const code = codeOf(cause);
    parts.push((code ?? messageOf(cause)).slice(0, MAX_PART_LEN));
    cause = (cause as { cause?: unknown } | null | undefined)?.cause;
  }

  return parts.join(JOINER).slice(0, MAX_TOTAL_LEN);
}
