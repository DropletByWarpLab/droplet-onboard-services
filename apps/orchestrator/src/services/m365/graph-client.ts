/**
 * WARP-2118 / ADR-041 — the Microsoft Graph HTTP client.
 *
 * ## The gap this closes
 *
 * WARP-2115 shipped the whole M365 lifecycle EXCEPT the thing that talks to
 * Microsoft. `m365-auth.service.ts` resolves an access token, `state.ts`
 * classifies an auth failure, `delta-cursor.service.ts` persists one cursor per
 * (person, workload, resource), and `sync-policy.ts` decides what a failure
 * means, how long to back off, and how to read a delta page's links. Every one
 * of those was written against a client that did not exist:
 * {@link extractDeltaLinks} parses a response nothing fetched, and
 * {@link graphUserAgent} builds a header nothing sent.
 *
 * `docs/security/allowed-egress.yaml` records the same gap as a standing
 * declaration on the `m365-graph-api` entry — *"the WARP-2118 sync engine has
 * no HTTP client yet, so nothing in apps/ or services/ names this host"* — with
 * a self-pruning instruction attached: the moment a `graph.microsoft.com`
 * literal lands in one of that entry's `code_refs`, the gate fails until the
 * `no_code_literal` declaration is deleted. {@link GRAPH_API_BASE_URL} below is
 * that literal. This file is therefore added to `code_refs` and the declaration
 * removed IN THE SAME CHANGE — the entry was designed to force exactly that.
 *
 * ## What this module is responsible for, and what it is not
 *
 * It owns the TRANSPORT and nothing else: one authenticated GET, the throttle
 * contract, and the error shape. It holds no cursor, decides no schedule,
 * chooses no endpoint, and persists nothing. Those belong to the sync engine
 * and to the modules above, which already exist — this file exists so they can
 * finally be joined, not so it can duplicate them.
 *
 * Concretely, it deliberately does NOT:
 *  • decide whether a failure is transient — {@link classifySyncFailure} does,
 *    and this module's job is to throw an error SHAPED so that function can;
 *  • compute a backoff — {@link computeBackoffMs} does;
 *  • parse `@odata.nextLink` / `@odata.deltaLink` — {@link extractDeltaLinks}
 *    does, and duplicating it here would create a second definition of what a
 *    delta page is.
 *
 * ## The host guard is the load-bearing control, and it guards a REPLAY
 *
 * A delta link is stored verbatim (`M365DeltaCursor.deltaLink`) and replayed as
 * a whole URL on the next tick — that is required, because the link encodes
 * `$select` and other request state, so rebuilding it by hand silently changes
 * what the next sync asks for. It also means **the next request's destination
 * comes out of the database, not out of this source file.** Every other cloud
 * track validates a base URL that an operator typed once; this one validates a
 * URL on every single request, because the value is one a stored row supplies
 * and it travels with a bearer token for the customer's whole mailbox.
 *
 * {@link assertSafeGraphUrl} is that check, in the shape ADR-042 §2 names as
 * the pattern — `QBO_ALLOWED_API_HOSTS` + `UnsafeBaseUrlError`
 * (`services/erp-connector/src/quickbooks/online-connector.ts`). Same rules,
 * same reasons: https only (a bearer token over http is a token given away),
 * no userinfo (`https://evil@graph.microsoft.com` resolves to an authority a
 * reader does not expect), an exact host from a set derived FROM the published
 * base URL, and port 443 only, which is the only port the registry declares.
 *
 * ## Redirects are never followed
 *
 * `redirect: "manual"`, and a 3xx is an error. The fetch spec strips
 * `Authorization` across origins but not within one, so a followed redirect is
 * either a silently dropped credential or a credential sent somewhere the host
 * guard never saw. Both are worse than a failed sync. Same choice, for the same
 * reason, as the HubSpot and Stripe tracks.
 */
import {
  classifySyncFailure,
  extractDeltaLinks,
  graphUserAgent,
  type DeltaLinks,
} from "./sync-policy.js";

/**
 * The Graph v1.0 base. A WHOLE-STRING literal on purpose.
 *
 * `scripts/check-egress-allowlist.py` extracts scheme-URLs from tracked source
 * and requires each host to be registered. Assembling this from parts would
 * hide the host from that scan — the Mailchimp track documents at length why
 * that is a real failure mode rather than a style question — and here there is
 * no reason to: the host is fixed and public, so it can and must be visible.
 *
 * `/beta` is deliberately unreachable from this module. Beta endpoints carry no
 * deprecation contract, and a sync engine pinned to one would break on
 * Microsoft's schedule rather than ours.
 */
export const GRAPH_API_BASE_URL = "https://graph.microsoft.com/v1.0";

/**
 * The only hosts this client will dial, derived from {@link GRAPH_API_BASE_URL}
 * rather than written out.
 *
 * Derived, so a second base URL cannot be introduced without its host becoming
 * a repo literal that the egress gate extracts and checks — the same
 * construction as `QBO_ALLOWED_API_HOSTS`, and for the same reason: a
 * hand-maintained list drifts away from what the registry screened, in the
 * direction of dialling more.
 *
 * Note what is NOT here: `login.microsoftonline.com`. It is registered egress
 * (`m365-entra-login`) and MSAL dials it, but it is never a URL this client
 * fetches. A token endpoint reachable from the data client is how a delta link
 * ends up pointed at an authorization server.
 */
export const GRAPH_ALLOWED_HOSTS: ReadonlySet<string> = new Set(
  [GRAPH_API_BASE_URL].map((u) => new URL(u).hostname),
);

/** Thrown when a stored link or caller URL names a destination this track will
 *  not dial. Mirrors `UnsafeBaseUrlError` on the QuickBooks track. */
export class UnsafeGraphUrlError extends Error {
  readonly code = "UNSAFE_GRAPH_URL";
  constructor(reason: string) {
    super(`refusing to send a Microsoft 365 token there: ${reason}`);
    this.name = "UnsafeGraphUrlError";
  }
}

/**
 * Validate a Graph URL — a caller-built one or a replayed delta link — or throw.
 *
 * Returns the URL unchanged on success (not normalised): a delta link's query
 * string is opaque state that Microsoft issued, and rewriting any part of it is
 * how a resync becomes a silent partial sync. The QuickBooks guard normalises
 * because it validates a BASE that the connector then appends to; this one
 * validates a COMPLETE URL that is about to be fetched verbatim.
 */
export function assertSafeGraphUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeGraphUrlError(`"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeGraphUrlError(`"${url.protocol}//" is not https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeGraphUrlError("the URL carries userinfo");
  }
  const host = url.hostname.toLowerCase();
  if (!GRAPH_ALLOWED_HOSTS.has(host)) {
    throw new UnsafeGraphUrlError(`"${host}" is not a registered Microsoft Graph host`);
  }
  // The URL parser drops an explicit :443 (the https default), so any port left
  // standing is one `allowed-egress.yaml` does not declare for this host.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeGraphUrlError(
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  return raw;
}

/**
 * A Graph failure, shaped so {@link classifySyncFailure} can read it.
 *
 * That function switches on `statusCode` and on Graph's own `error.code`
 * string, so both are surfaced as own properties rather than buried in a
 * message. `syncStateNotFound` arriving as prose inside `message` would be
 * classified `FATAL` instead of `RESYNC_REQUIRED`, and the cursor would stop
 * permanently instead of re-enumerating — a bug that presents as "this mailbox
 * stopped syncing" weeks later, with nothing in the logs naming the cause.
 */
export class GraphRequestError extends Error {
  readonly statusCode: number;
  /** Graph's `error.code`, when the body carried one. */
  readonly code?: string;
  /**
   * The RAW `Retry-After` header, carried through unparsed.
   *
   * Deliberately not milliseconds. `recordFailure` takes the header string and
   * hands it to {@link parseRetryAfter} itself, which supports both RFC forms
   * (delta-seconds and an HTTP-date) and needs a clock to resolve the second.
   * Parsing here would mean parsing it twice, in two places, with this one
   * having no injectable clock — so an HTTP-date form would be resolved against
   * a different "now" than the cursor is scheduled from.
   */
  readonly retryAfterHeader: string | null;

  constructor(args: {
    statusCode: number;
    code?: string;
    message: string;
    retryAfterHeader?: string | null;
  }) {
    super(args.message);
    this.name = "GraphRequestError";
    this.statusCode = args.statusCode;
    this.code = args.code;
    this.retryAfterHeader = args.retryAfterHeader ?? null;
  }
}

/** One page of a delta or list response: its items plus its links. */
export interface GraphPage {
  /** The `value` array. Empty rather than absent when Graph returns no items —
   *  a caller should never have to distinguish "no changes" from "malformed". */
  readonly items: readonly Record<string, unknown>[];
  readonly links: DeltaLinks;
  /** The raw page, for a caller that needs a field this shape does not name. */
  readonly raw: Record<string, unknown>;
}

/** Matches the house shape used by every cloud connector, so a test injects a
 *  stub the same way here as it does for Stripe or HubSpot. */
type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<Response>;

export interface GraphClientDeps {
  fetchImpl?: FetchLike;
  /** Product version for the `User-Agent` Microsoft asks integrators to send. */
  version?: string;
  /** Per-request timeout. Graph's own ceiling is far higher; this bounds a
   *  hung socket, not a slow query. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * An authenticated, host-guarded Graph reader.
 *
 * Stateless between calls by design: it holds no token (the caller resolves one
 * per request, so a refresh mid-sync is the caller's concern and a stale token
 * cannot be cached here) and no cursor. One instance may serve many users
 * precisely because it remembers nothing about any of them — the same reasoning
 * that made `entra-client.ts` construct a fresh MSAL app per operation rather
 * than pool one cache across every connected mailbox.
 */
export class GraphClient {
  private readonly fetchImpl?: FetchLike;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(deps: GraphClientDeps = {}) {
    this.fetchImpl = deps.fetchImpl;
    this.userAgent = graphUserAgent(deps.version ?? "0.0.0");
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Fetch one page — from a caller-built URL or a replayed delta link.
   *
   * `url` is validated on EVERY call, not once at construction: see the module
   * header. A delta link comes out of the database.
   */
  async getPage(url: string, accessToken: string): Promise<GraphPage> {
    const safe = assertSafeGraphUrl(url);
    const doFetch = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!doFetch) {
      throw new GraphRequestError({
        statusCode: 0,
        code: "ENOTFOUND",
        message: "no fetch implementation available",
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await doFetch(safe, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": this.userAgent,
        },
        // Never follow a 3xx — see the module header.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      // A transport failure. Surface the errno so `classifySyncFailure` sees
      // TRANSIENT rather than falling through to FATAL, and never include the
      // URL: a delta link carries a token of its own.
      const errno =
        typeof (err as { code?: unknown })?.code === "string"
          ? (err as { code: string }).code
          : (err as Error)?.name === "AbortError"
            ? "ETIMEDOUT"
            : "ECONNRESET";
      throw new GraphRequestError({
        statusCode: 0,
        code: errno,
        message: "the request to Microsoft 365 did not complete",
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      throw new GraphRequestError({
        statusCode: res.status,
        message: `Microsoft 365 returned a ${res.status} redirect, which this client never follows`,
      });
    }

    if (!res.ok) {
      throw await this.toError(res);
    }

    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      throw new GraphRequestError({
        statusCode: res.status,
        message: "Microsoft 365 returned a body that is not a JSON object",
      });
    }

    const value = body.value;
    return {
      items: Array.isArray(value) ? (value as Record<string, unknown>[]) : [],
      links: extractDeltaLinks(body),
      raw: body,
    };
  }

  /**
   * Turn a non-2xx into a {@link GraphRequestError}.
   *
   * Graph's envelope is `{ error: { code, message } }`. `code` is what
   * distinguishes a dead delta token (`syncStateNotFound`) from a dead grant,
   * so it is extracted deliberately rather than incidentally.
   *
   * The vendor's `message` is NOT propagated. It can quote request state — a
   * delta token among it — and this string reaches `lastError`, which is
   * rendered to the owner and written to a log. `code` alone is diagnostic and
   * carries nothing secret.
   */
  private async toError(res: Response): Promise<GraphRequestError> {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: unknown } } | null;
      const raw = body?.error?.code;
      if (typeof raw === "string" && raw.trim() !== "") code = raw.trim();
    } catch {
      // A non-JSON error body (an edge proxy, a 502 HTML page). The status is
      // still the useful half and `classifySyncFailure` reads it.
    }

    return new GraphRequestError({
      statusCode: res.status,
      code,
      message: `Microsoft 365 refused the request (HTTP ${res.status}${code ? `, ${code}` : ""})`,
      retryAfterHeader: res.headers.get("retry-after"),
    });
  }
}

/**
 * Re-exported so the sync engine has ONE import for "how a Graph failure is
 * read". Keeping the classifier's home in `sync-policy.ts` (pure, no I/O) and
 * its access point here means a caller cannot accidentally hand it something
 * that is not a Graph error.
 */
export { classifySyncFailure };
