/**
 * WARP-2370 — the low-concurrency outbound call scheduler.
 *
 * ## Why a CONCURRENCY ceiling and not a rate
 *
 * Atlassian publishes no rate limit for the Rovo MCP server. What is known is
 * upstream issue **#171**: clients start collecting 429s at roughly **20
 * parallel calls**, with no reported volume threshold. So the limiter that
 * matters here is concurrency-sensitive, not volume-sensitive, and a
 * token-bucket over calls-per-second would ride straight through it — twenty
 * calls issued together are twenty calls in flight however slowly the bucket
 * refills.
 *
 * {@link DEFAULT_MAX_CONCURRENT_CALLS} is therefore a *depth* ceiling, and it
 * is set well under the observed cliff rather than just under it: the cliff is
 * one report on one tenant, the vendor documents nothing, and the cost of
 * being wrong is a 429 storm against a customer's own account. Four is a
 * quarter of the reported number. Raising it is a decision to be argued in a
 * PR, which is why it is a named constant and not an inline literal.
 *
 * ## No scheduling loop
 *
 * The repo bans `while (true)` for scheduling. There is none: a finished call
 * pulls the next waiter off the queue directly (`#drain`), so the queue is
 * event-driven — it advances because something completed, never because a
 * ticker fired.
 *
 * ## Rule 19
 *
 * Response headers reach {@link RemoteCallScheduler.noteRateLimitHeaders} and
 * nothing else. Only the four rate-limit headers are read; no header value is
 * stored, logged or returned, so an `Authorization` echo or a `Set-Cookie` in
 * the same map cannot leave through here.
 */

/**
 * The concurrency ceiling. Deliberately far under upstream #171's observed
 * ~20-parallel-call cliff — see the module header before changing it.
 */
export const DEFAULT_MAX_CONCURRENT_CALLS = 4;

/** Longest pause this scheduler will honour from a server header. A vendor
 *  asking us to sleep for an hour is a vendor we should surface as unavailable,
 *  not one we should silently obey. */
export const MAX_HONOURED_PAUSE_MS = 60_000;

/**
 * The ONLY header names anything in this component is permitted to read off a
 * remote response (rule 19).
 *
 * Declared here, beside the one method that consumes them, so the allowed set
 * and its consumer cannot drift — `streamable-http.ts` filters a live
 * `Response` through {@link pickRateLimitHeaders} before the map ever reaches
 * a callback, which is what keeps an `Authorization` echo or a `Set-Cookie` in
 * the same response out of reach rather than merely unread.
 */
export const RATE_LIMIT_HEADER_NAMES: readonly string[] = [
  "retry-after",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

/**
 * Narrow an arbitrary header source down to {@link RATE_LIMIT_HEADER_NAMES}.
 *
 * Takes a LOOKUP rather than a map so it works against a `Headers` object, a
 * plain record, or anything else, without the caller first materialising every
 * header into a structure the rest of the process could reach.
 *
 * Returns `null` when none are present, so a caller can skip the work rather
 * than hand {@link RemoteCallScheduler.noteRateLimitHeaders} an empty map on
 * every healthy response.
 */
export function pickRateLimitHeaders(
  get: (name: string) => string | null | undefined,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const value = get(name);
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface RemoteCallSchedulerOptions {
  /** @default DEFAULT_MAX_CONCURRENT_CALLS */
  maxConcurrent?: number;
  /** Injected so tests never sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock, same reason. */
  now?: () => number;
  /** @default MAX_HONOURED_PAUSE_MS */
  maxPauseMs?: number;
}

/** What the scheduler observed while running — for a health payload. Counters
 *  only; never a header value (rule 19). */
export interface RemoteCallSchedulerStats {
  /** Highest number of calls simultaneously in flight since construction. */
  peakInFlight: number;
  /** Calls currently in flight. */
  inFlight: number;
  /** Calls waiting for a slot. */
  queued: number;
  /** Times a server header put the scheduler to sleep. */
  pauses: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && t !== null && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
  });
}

/**
 * Serialise outbound calls behind a depth ceiling, and obey the server when it
 * asks for a pause.
 *
 * Not Atlassian-specific: it holds no host, no tool name and no credential.
 * Atlassian is simply the first server whose documented failure mode is
 * concurrency (see {@link DEFAULT_MAX_CONCURRENT_CALLS}).
 */
export class RemoteCallScheduler {
  readonly #maxConcurrent: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxPauseMs: number;

  #inFlight = 0;
  #peakInFlight = 0;
  #pauses = 0;
  /** Epoch ms before which no new call may start. `0` means "not paused" —
   *  an explicit value, never `null`-as-a-state. */
  #pausedUntil = 0;
  readonly #waiters: (() => void)[] = [];

  constructor(opts: RemoteCallSchedulerOptions = {}) {
    this.#maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CALLS;
    if (this.#maxConcurrent < 1) {
      throw new Error("RemoteCallScheduler: maxConcurrent must be at least 1");
    }
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#now = opts.now ?? (() => Date.now());
    this.#maxPauseMs = opts.maxPauseMs ?? MAX_HONOURED_PAUSE_MS;
  }

  stats(): RemoteCallSchedulerStats {
    return {
      peakInFlight: this.#peakInFlight,
      inFlight: this.#inFlight,
      queued: this.#waiters.length,
      pauses: this.#pauses,
    };
  }

  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  /**
   * Run `fn` once a slot is free and any server-requested pause has elapsed.
   *
   * The slot is released in a `finally`, so a throwing call cannot leak
   * capacity — a leaked slot is a scheduler that quietly tightens to zero and
   * a session that stops answering with no error anywhere.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      await this.#awaitPause();
      return await fn();
    } finally {
      this.#release();
    }
  }

  /**
   * Feed a response's headers in. Recognises, in priority order:
   *
   *   - `Retry-After` — seconds, or an HTTP-date. The explicit instruction, so
   *     it wins.
   *   - `X-RateLimit-Remaining: 0` together with `X-RateLimit-Reset` — the
   *     budget is spent and the reset says until when. Read only when
   *     `remaining` is exactly zero: pausing on a positive remaining would
   *     halt a healthy connection.
   *
   * Header names are matched case-insensitively (HTTP header names are, and
   * undici lowercases them while a hand-built test fixture may not).
   */
  noteRateLimitHeaders(headers: Record<string, string | undefined>): void {
    const get = (name: string): string | undefined => {
      const want = name.toLowerCase();
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === want && v !== undefined) return v;
      }
      return undefined;
    };

    const retryAfter = parseRetryAfter(get("retry-after"), this.#now());
    if (retryAfter !== null) {
      this.#pauseFor(retryAfter);
      return;
    }

    const remaining = get("x-ratelimit-remaining");
    if (remaining !== undefined && Number(remaining) === 0) {
      const reset = parseRateLimitReset(get("x-ratelimit-reset"), this.#now());
      if (reset !== null) this.#pauseFor(reset);
    }
  }

  #pauseFor(ms: number): void {
    if (ms <= 0) return;
    const bounded = Math.min(ms, this.#maxPauseMs);
    const until = this.#now() + bounded;
    if (until > this.#pausedUntil) {
      this.#pausedUntil = until;
      this.#pauses += 1;
    }
  }

  async #awaitPause(): Promise<void> {
    const remaining = this.#pausedUntil - this.#now();
    if (remaining > 0) await this.#sleep(remaining);
  }

  async #acquire(): Promise<void> {
    if (this.#inFlight < this.#maxConcurrent) {
      this.#take();
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(() => {
        this.#take();
        resolve();
      });
    });
  }

  #take(): void {
    this.#inFlight += 1;
    if (this.#inFlight > this.#peakInFlight) this.#peakInFlight = this.#inFlight;
  }

  #release(): void {
    this.#inFlight -= 1;
    // Event-driven hand-off: the completing call wakes exactly one waiter.
    // No poll, no ticker, no `while` — see the module header.
    const next = this.#waiters.shift();
    if (next) next();
  }
}

/** `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
function parseRetryAfter(raw: string | undefined, now: number): number | null {
  if (raw === undefined) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * `X-RateLimit-Reset` has no standard. Both shapes are in the wild, and they
 * are distinguished by MAGNITUDE rather than by guessing from the vendor:
 * a value large enough to be a Unix timestamp is one, anything smaller is a
 * delta in seconds. The boundary is the year 2001 in epoch seconds — no
 * plausible delta reaches it and no plausible timestamp falls below it.
 */
const EPOCH_SECONDS_FLOOR = 1_000_000_000;

function parseRateLimitReset(raw: string | undefined, now: number): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return null;
  if (value >= EPOCH_SECONDS_FLOOR) return Math.max(0, value * 1000 - now);
  return value * 1000;
}
