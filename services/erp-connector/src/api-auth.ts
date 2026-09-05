/**
 * WARP-1294 — auth + outbound HTTP for the Patterson Eaglesoft REST API.
 *
 * Auth handshake (from the Patterson SDK "Sample Application" doc): the client
 * calls `Authenticate(integrationKey, userId, password)` and receives a session
 * token that is attached to every subsequent call. The `integrationKey` is the
 * Patterson-issued vendor credential (CLIENTID/SERIALKEY bundle); `userId` /
 * `password` is an Eaglesoft **Provider** whose module privileges are the RBAC
 * boundary the API enforces. All three resolve from ONE secret_ref pointer —
 * never cleartext in code, config, rows, or logs.
 *
 * Transport = `fetch()` (the repo convention — no axios/got), with an
 * `AbortSignal.timeout` on every call. TLS trust of the Patterson private CA
 * (PdcoTechCA) is supplied by an injected `dispatcher` (an undici Agent the
 * caller builds from the resolved CA cert); this module never disables cert
 * verification.
 *
 * WARP-2626 — WHICH fetch is load-bearing, and it is not a style choice.
 * A `dispatcher` is an undici extension to `RequestInit`, and it is only
 * honoured by the undici that MINTED it. Node's built-in `fetch` is its own
 * bundled copy of undici:
 *
 *   - Node 20 (`.nvmrc`, `engines.node`, every workflow's `setup-node`) bundles
 *     undici 6 and accepts an `Agent` from the npm `undici@6` this repo installs.
 *   - Node >= 22 bundles undici 7, whose handler interface changed, and rejects
 *     the v6 `Agent` outright with `UND_ERR_INVALID_ARG: invalid onError method`
 *     before a byte is sent. Every call then surfaces as a bare `fetch failed`,
 *     which is indistinguishable from an unreachable practice box — the REST
 *     track reports `connected: false` against a perfectly healthy one.
 *
 * So whenever a caller supplies a dispatcher, this module uses the npm
 * `undici`'s OWN `fetch`: the dispatcher and the fetch consuming it then always
 * come from the same undici, and the pairing survives any host Node. With no
 * dispatcher there is nothing to pair and the built-in `fetch` is used as
 * before. Same rule, same reason as `apps/orchestrator/src/lib/internal-tls.ts`.
 */
import { fetch as undiciFetch } from "undici";
import { type AuthRouteSpec, type DiscoveredRoute } from "./api-route-map.js";

/** Credentials resolved from a secret_ref (never persisted on the connector). */
export interface ResolvedCredentials {
  /** Patterson vendor key (CLIENTID/SERIALKEY bundle). */
  integrationKey: string;
  /** Eaglesoft Provider login — the per-practice RBAC boundary. */
  userId: string;
  password: string;
}

/** Resolve a secret_ref pointer into live credentials. Injected by the caller;
 *  the default refuses because no secret-store client is wired into this
 *  package (mirrors the SQL connector's stubbed secret resolution). */
export type SecretResolver = (ref: string) => Promise<ResolvedCredentials>;

/** Internal transport/auth error. Mapped to `ConnectorBlockedError` at the
 *  `Connector`-method boundary so the orchestrator's honest-degradation branch
 *  (`instanceof ConnectorBlockedError`) keeps working unchanged. */
export class EaglesoftApiError extends Error {
  readonly code = "EAGLESOFT_API_ERROR";
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "EaglesoftApiError";
  }
}

/** The default resolver: no secret store here, so it blocks honestly. */
export const blockedSecretResolver: SecretResolver = async () => {
  throw new EaglesoftApiError(
    "secret store not wired: cannot resolve the Eaglesoft integrationKey / provider credentials in this slice",
  );
};

/** `fetch`-like signature so tests can inject a mock and production defaults to
 *  the runtime global `fetch` at call time. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiTransport {
  /** e.g. "https://eaglesoft.lan:9888" — built from config, never a baked host. */
  baseUrl: string;
  /** Injected mock in tests. Absent → resolved per call by {@link resolveFetch}. */
  fetchImpl?: FetchLike;
  /** undici Agent carrying the PdcoTechCA trust; injected by the caller when a
   *  CA cert has been resolved. Passed through fetch's `dispatcher` option.
   *
   *  Must be an Agent from the npm `undici` package — supplying one switches
   *  the transport to that same undici's `fetch`, because a dispatcher is only
   *  honoured by the undici that minted it (WARP-2626). The caller does NOT
   *  have to pass a matching `fetchImpl`; that pairing is this module's job. */
  dispatcher?: unknown;
  /** Per-call timeout (ms). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Read a dotted path out of a JSON value (`a.b.c`); `""`/undefined = the root. */
export function pluck(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Resolve the fetch implementation at call time (so a `global.fetch` swap in
 * tests is honored).
 *
 * Order, and why (WARP-2626):
 *   1. An injected `fetchImpl` always wins — that is the test seam, and a
 *      caller who supplies its own transport owns the pairing.
 *   2. A `dispatcher` with no injected fetch means the npm `undici`'s own
 *      `fetch`, because only that undici honours its own Agent. Handing it to
 *      the runtime's built-in `fetch` is the WARP-2626 defect: it happens to
 *      work on the pinned Node 20 and throws `UND_ERR_INVALID_ARG` on Node >= 22,
 *      turning a healthy box into `connected: false`.
 *   3. No dispatcher, no pairing to preserve — the built-in `fetch`, as before.
 *
 * Pinned by `__tests__/api-auth.dispatcher.test.ts` (a real request through a
 * real dispatcher on whatever Node is installed) and by the import-boundary
 * guard in `apps/orchestrator/src/__tests__/undici-fetch-pairing.guard.test.ts`.
 */
export function resolveFetch(t: ApiTransport): FetchLike {
  if (t.fetchImpl) return t.fetchImpl;
  if (t.dispatcher) return undiciFetch as unknown as FetchLike;
  const g = (globalThis as { fetch?: FetchLike }).fetch;
  if (!g) throw new EaglesoftApiError("no fetch implementation available");
  return g;
}

interface RequestOptions {
  /** Query params appended for verbs without a body (GET/DELETE). */
  query?: Record<string, unknown>;
  /** JSON body for POST/PUT/PATCH. */
  body?: unknown;
  /** Session token attached as `Authorization` when present. */
  token?: string | null;
}

/**
 * Make one authenticated Web-API-2 request against a DISCOVERED route. Builds
 * the URL from `baseUrl` + `route.template`, attaches the timeout signal, the
 * session header, and (when injected) the CA-trusting dispatcher. Non-2xx and
 * network/timeout failures throw {@link EaglesoftApiError}; the JSON body is
 * returned on success.
 */
export async function apiRequest(
  transport: ApiTransport,
  route: DiscoveredRoute,
  opts: RequestOptions = {},
): Promise<unknown> {
  const fetchImpl = resolveFetch(transport);
  const url = new URL(route.template, transport.baseUrl.endsWith("/") ? transport.baseUrl : `${transport.baseUrl}/`);
  const hasBody = route.verb === "POST" || route.verb === "PUT" || route.verb === "PATCH";
  if (!hasBody && opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers.Authorization = opts.token;
  if (hasBody) headers["Content-Type"] = "application/json";

  // `dispatcher` is an undici (Node) extension to RequestInit; cast to attach it
  // without a DOM-typed `RequestInit` complaint.
  const init = {
    method: route.verb,
    headers,
    signal: AbortSignal.timeout(transport.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ...(hasBody ? { body: JSON.stringify(opts.body ?? {}) } : {}),
    ...(transport.dispatcher ? { dispatcher: transport.dispatcher } : {}),
  } as RequestInit;

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), init);
  } catch (err) {
    // Network error / timeout / abort — never leak the URL creds; give a stable
    // message the connector maps to a blocked state.
    throw new EaglesoftApiError(
      `request to ${route.controller}.${route.method} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new EaglesoftApiError(
      `${route.controller}.${route.method} returned HTTP ${res.status}`,
      res.status,
    );
  }
  return res.json().catch(() => ({}));
}

/**
 * Run the `Authenticate(integrationKey, userId, password)` handshake and return
 * the session token. The credentials are posted as the request body; the token
 * is plucked from the response per `authRoute.tokenPath` (default `"token"`).
 * Nothing here is logged.
 */
export async function authenticate(
  transport: ApiTransport,
  authRoute: DiscoveredRoute & { tokenPath?: string },
  creds: ResolvedCredentials,
): Promise<string> {
  const payload = await apiRequest(transport, authRoute, {
    body: {
      integrationKey: creds.integrationKey,
      userId: creds.userId,
      password: creds.password,
    },
  });
  const raw = pluck(payload, authRoute.tokenPath ?? "token");
  const token = typeof raw === "string" ? raw : typeof payload === "string" ? payload : "";
  if (!token) {
    throw new EaglesoftApiError("authentication succeeded but no session token was returned");
  }
  return token;
}

/** Build the API base URL from a host + port. Kept here (not a baked literal)
 *  so the office host only ever comes from runtime config. */
export function buildBaseUrl(host: string, httpsPort: number): string {
  return `https://${host}:${httpsPort}`;
}

export type { AuthRouteSpec };
