/**
 * WARP-3193 QUAL-6 — the send loop the per-vendor REST connectors share.
 *
 * Each of the eight hand-written REST connectors (brevo, hubspot, klaviyo,
 * mailchimp, pipedrive, shopify, stripe, xero) carried its own copy of the
 * same security-relevant transport: never follow a redirect, always carry a
 * timeout, refuse to run without a fetch, bound the 429 retry loop. A ninth
 * connector copying one of them could drop any of those and every happy-path
 * test would still pass. This class owns exactly those properties, once.
 *
 * What it deliberately does NOT own, because it differs per vendor and is
 * pinned by each vendor's own tests: the host guard and path allowlist (run by
 * the caller BEFORE building the URL, so a refused target costs zero fetch
 * calls), the credential header, budgets and pacing, the 429 wait (Retry-After,
 * a vendor reset header, jitter, a daily-quota short-circuit), and the
 * classification of every non-429 status. Those arrive through
 * {@link SafeRestPolicy} or stay in the caller.
 *
 * The declarative track (`rest/connector.ts`, ADR-046) is a separate path and
 * is not routed through here.
 */

/** Matches the connectors' own `FetchLike`. */
export type TransportFetch = (input: string, init?: Record<string, unknown>) => Promise<Response>;

export interface SafeRestRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Omitted from the fetch init entirely when undefined. */
  readonly body?: string;
}

export interface SafeRestPolicy {
  /** Total attempts, the first included. */
  readonly maxAttempts: number;
  /** The vendor's error when no fetch implementation exists at all. */
  noFetch(): Error;
  /** The vendor's error for a request that never produced a response (DNS,
   *  TLS, timeout, a refused redirect). */
  unreachable(err: Error): Error;
  /**
   * A 429 on attempt `attempt` (0-based). `final` is true when no attempt is
   * left: throw the vendor's error. Otherwise return the milliseconds to wait
   * before the next attempt (or throw to stop early, e.g. a daily quota).
   */
  rateLimited(res: Response, attempt: number, final: boolean): number | Promise<number>;
  /** Runs before every attempt, retries included (e.g. a request governor). */
  beforeAttempt?(): Promise<void>;
}

export interface SafeRestTransportDeps {
  /** Resolved per send, falling back to `globalThis.fetch`. */
  readonly fetchImpl?: TransportFetch;
  readonly timeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export class SafeRestTransport {
  constructor(private readonly deps: SafeRestTransportDeps) {}

  /** Send until a non-429 response arrives and return it, unclassified. */
  async send(req: SafeRestRequest, policy: SafeRestPolicy): Promise<Response> {
    const doFetch = this.deps.fetchImpl ?? (globalThis.fetch as unknown as TransportFetch | undefined);
    if (!doFetch) throw policy.noFetch();

    for (let attempt = 0; ; attempt += 1) {
      if (policy.beforeAttempt) await policy.beforeAttempt();

      let res: Response;
      try {
        res = await doFetch(req.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body !== undefined ? { body: req.body } : {}),
          // Never follow a 3xx: the fetch spec strips Authorization on
          // cross-origin redirects, but a credential's safety must not rest on
          // every runtime implementing that correctly — and a custom header
          // (`api-key`, `X-Shopify-Access-Token`) is not stripped at all. None
          // of these APIs has a legitimate redirect, so one is a fault.
          redirect: "error",
          signal: AbortSignal.timeout(this.deps.timeoutMs),
        });
      } catch (err) {
        throw policy.unreachable(err as Error);
      }

      if (res.status !== 429) return res;
      const wait = await policy.rateLimited(res, attempt, attempt >= policy.maxAttempts - 1);
      await this.deps.sleep(wait);
    }
  }
}
