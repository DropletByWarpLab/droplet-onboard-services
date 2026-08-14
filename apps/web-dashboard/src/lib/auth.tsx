"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
// NOTE: api.ts imports `authFetch` from this module, so this is a module
// cycle. It is safe: `patchSetupReady` is only INVOKED at runtime (inside the
// `completeSetup` callback), never during module evaluation, so the live
// binding is fully initialized by the time it's called. Same shape as the
// many components that import from both ./auth and ./api.
import { patchSetupReady, patchTourCompleted } from "./api";
import { HELP_PATH } from "./routing";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  // Role mirrors the orchestrator's JWT role enum. /api/auth/me returns
  // it; we keep it optional here so older cached profiles don't break
  // the type. WARP-279 added the field for the /admin/claude-activity
  // visibility check.
  role?: "owner" | "admin" | "family" | "guest";
  // WARP-824: true when this user was created by an admin with a temporary
  // password and must change it before reaching any other surface. /auth/login
  // and /auth/me return it (me reads it fresh from the row). AuthGate routes a
  // `true` user to /change-password; the orchestrator gate enforces it
  // server-side regardless. Optional so a cached pre-WARP-824 profile is
  // treated as "not gated".
  mustChangePassword?: boolean;
}

/**
 * PR #372 — explicit, resumable first-run state from `/api/setup/state`.
 * Replaces the boolean `setupRequired` (which was derived from Nextcloud's
 * `installed` flag) as the source of truth AuthGate routes off.
 *
 *   appliance         — "unclaimed" (first-run unfinished) | "ready".
 *   setupStep         — the wizard step to resume at (SetupStep enum value).
 *   userTourCompleted — post-claim product tour seen? (tour route is a
 *                       separate, gated workstream — surfaced here so it's
 *                       ready to consume when that ships).
 */
export interface SetupStateInfo {
  appliance: "unclaimed" | "ready";
  setupStep: string;
  userTourCompleted: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  // Explicit setup state (PR #372). `null` until the first
  // `/api/setup/state` fetch resolves (or if the endpoint is unreachable).
  setupState: SetupStateInfo | null;
  // Back-compat convenience: true when the appliance is unclaimed. Derived
  // from `setupState`; prefer `setupState.appliance` in new code.
  setupRequired: boolean | null;
  // M3 (PR #372 re-review) — the lifecycle probe (`GET /api/setup/state` in
  // init) is explicit about failure instead of failing open silently. When
  // the probe couldn't resolve the state, this carries the reason so the UI
  // can surface "couldn't reach the appliance" + a retry, rather than
  // guessing. `null` once a probe succeeds.
  setupProbeError: string | null;
  // M3 — re-run the lifecycle probe (used by a retry affordance).
  retrySetupProbe: () => Promise<void>;
  // WARP-667 — true while a bounded cold-boot auto-retry of the setup-state
  // probe is still pending/in-flight (the probe failed, no state yet, and
  // attempts remain). AuthGate shows a "Reconnecting…" state while true and the
  // explicit manual Retry only once it goes false (attempts exhausted).
  setupAutoRetrying: boolean;
  // M4 (PR #372 re-review) — the wizard-FINISH PATCH can fail. When it does,
  // this carries the error and the optimistic in-memory `ready` flip is
  // rolled back, so the UI shows the failure + a retry instead of silently
  // diverging from the (still `unclaimed`) server. `null` on success.
  completeSetupError: string | null;
  // PR #375 — `secondFactor` is supplied only when answering the two-factor
  // challenge. A first attempt omits it; if the account has 2FA enabled the
  // call rejects with `TotpRequiredError`, the page reveals the code field, and
  // a follow-up call passes the entered `totp` (or `recoveryCode`).
  login: (
    username: string,
    password: string,
    secondFactor?: SecondFactor,
  ) => Promise<void>;
  // PR #377: hydrate the context after a passwordless passkey sign-in. The
  // orchestrator's authenticate/verify already set the session cookie and
  // returned the user; this mirrors the tail of login() (cache + setUser)
  // without a second network round-trip.
  setUserFromPasskey: (user: AuthUser) => void;
  logout: () => Promise<void>;
  // Wizard-finish transition. Optimistically flips the in-memory appliance
  // to "ready" (no flash of the wizard) AND awaits the server PATCH that
  // durably persists `ready` — the two must agree, or a hard refresh
  // re-traps the owner in setup. On a failed PATCH it ROLLS BACK the
  // optimistic flip and records `completeSetupError` (M4); never throws, so
  // `void completeSetup()` at the call site is safe. Returns whether the
  // server persist succeeded so a caller can sequence on it.
  completeSetup: () => Promise<boolean>;
  // PR #382 — post-setup tour-finish transition. Optimistically flips the
  // in-memory `userTourCompleted` to true so AuthGate stops routing to /tour
  // immediately (no flash of the tour), AND awaits the server PATCH
  // (`markTourCompleted`) so a hard refresh reads the persisted flag instead
  // of replaying the tour. Same awaitable/never-rejects contract as
  // completeSetup. No-op-safe if `setupState` hasn't resolved yet.
  completeTour: () => Promise<void>;
  // WARP-824 — called by the forced-change screen after a successful password
  // change. Optimistically flips the in-memory `user.mustChangePassword` to
  // false so AuthGate releases the user into the dashboard without a second
  // round-trip. The server already cleared the persisted flag, so a hard
  // refresh re-reads false from /auth/me — the two agree.
  markPasswordChanged: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * A second factor answered at the login challenge — a 6-digit TOTP code OR a
 * single-use recovery code. The orchestrator accepts either alongside the
 * already-verified password (PR #375). Exactly one is set per attempt.
 */
export interface SecondFactor {
  totp?: string;
  recoveryCode?: string;
}

/**
 * PR #375 — thrown by `login()` when the password verified but the account has
 * two-factor ENABLED and no (or an incorrect) second factor was supplied. The
 * orchestrator answers `401 { code: "TOTP_REQUIRED" }` with NO session cookie;
 * the login page catches this to reveal the code field and re-submit, instead
 * of routing it through `translateError` (whose message-less 401 fallback wrongly
 * tells the user to check a password that was, in fact, correct).
 *
 * A typed class (not a bare `Error`) so the throw site is self-documenting and
 * carries the `code` field. The login page dispatches on that `code`
 * (`isTotpRequired` → `err.code === "TOTP_REQUIRED"`), NOT `instanceof`, so the
 * check survives module duplication / mocking and doesn't force every
 * `@/lib/auth` consumer to share one error-class identity. A wrong code on a
 * *retry* — also TOTP_REQUIRED — is distinguished from the first challenge by
 * the page's own state, not by re-parsing the error.
 */
export class TotpRequiredError extends Error {
  readonly code = "TOTP_REQUIRED" as const;
  constructor() {
    super("Two-factor authentication required");
    this.name = "TotpRequiredError";
  }
}

const USER_KEY = "droplet-auth-user";

/**
 * Upper bound on the first-run init probes. The two boot fetches
 * (`GET /api/setup/state` + `GET /api/auth/me`) are raced against this so a
 * cold/hung backend can't pin the app on the full-screen "Loading…" spinner
 * forever — on timeout we settle into a usable (unauthenticated) state and let
 * AuthGate route. Chosen to be comfortably longer than a warm round-trip yet
 * short enough that a stuck endpoint doesn't read as a hang to the user.
 */
const AUTH_INIT_TIMEOUT_MS = 6_000;

/**
 * WARP-667 — cold-boot self-heal. When the first-run setup-state probe can't
 * resolve because the orchestrator is still warming, auto-retry it on this
 * backoff schedule BEFORE the owner has to hit the manual Retry. Bounded: a box
 * still coming up self-heals within ~10s with no manual refresh, while a
 * genuinely-unreachable box settles to the explicit Retry after the last
 * attempt (no infinite spin, no guessing into the wizard). Only the setup-state
 * probe is retried — a failed `/api/auth/me` just means "unauthenticated",
 * which the login path already handles.
 */
const SETUP_PROBE_RETRY_DELAYS_MS = [1_500, 3_000, 6_000];

/**
 * Fresh budget for `authFetch`'s post-refresh retry (onboard#477 review). The
 * retry must NOT inherit the caller's `init.signal`: that signal (e.g.
 * `restoreSession`'s `AUTH_INIT_TIMEOUT_MS` cold-boot budget) may already be
 * consumed by the initial request + the token refresh, so reusing it fires the
 * retry with an already-aborted signal → instant `AbortError` → a valid-but-slow
 * session is wrongly treated as unauthenticated. A fresh, self-contained budget
 * keeps the single retry bounded without depending on the caller's clock.
 */
const AUTHFETCH_RETRY_TIMEOUT_MS = 6_000;

/**
 * WARP-1726 (second pass) — the bound on the two auth SINGLE-FLIGHTS
 * (`attemptRefresh` and `confirmSessionDead`).
 *
 * Both memoise their in-flight promise so an auth storm costs one round trip
 * rather than one per pending request. That sharing is only safe while the
 * promise is guaranteed to settle. A box that accepts the TCP connection and
 * then goes quiet — mid-reboot, a wedged orchestrator, a captive portal
 * swallowing the request — leaves a bare `fetch` pending indefinitely, so
 * `.finally()` never runs, the slot is never cleared, and from then on EVERY
 * `authFetch` that 401s awaits the same dead promise. The tab stops making
 * progress until the browser's own transport timeout, which is minutes.
 *
 * 6s, matching AUTH_INIT_TIMEOUT_MS / AUTHFETCH_RETRY_TIMEOUT_MS — one house
 * number for "an appliance on the LAN has had long enough to answer", rather
 * than a third budget to reason about. The upper constraint is the Network
 * tab's 10s device poll: keeping the bound under it means a silent box costs at
 * most one abandoned refresh per poll cycle instead of a growing queue of them.
 *
 * A timeout must classify as TRANSIENT, never as a dead session — see the two
 * call sites. Aborting into a logout would just be a slower version of the bug
 * this ticket removes.
 */
const AUTH_SINGLE_FLIGHT_TIMEOUT_MS = 6_000;

/**
 * An AbortSignal that fires after `ms`, with a jsdom/older-runtime fallback for
 * environments where `AbortSignal.timeout` isn't implemented (keeps unit tests
 * from crashing on `AbortSignal.timeout is not a function`).
 */
function timeoutSignal(ms: number): AbortSignal {
  const ctor = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof ctor.timeout === "function") return ctor.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException("TimeoutError", "TimeoutError")), ms);
  return ctrl.signal;
}

/**
 * Credential-aware fetch wrapper.
 *
 * All API requests include `credentials: "same-origin"` so the browser
 * automatically attaches the `droplet_session` HTTP-only cookie set by
 * the orchestrator on login.  No token is stored in JavaScript-accessible
 * storage, eliminating the XSS attack surface for session tokens.
 *
 * On a 401 from a non-auth endpoint we transparently try to refresh the
 * access token (the refresh cookie is scoped to /api/auth and outlives the
 * 15-minute access JWT). If the refresh succeeds we retry the original call
 * once; if it fails DEFINITIVELY we evict the cached user and bounce to
 * /login. Without this, an expired session leaves stale SWR data on screen and
 * every action silently fails with 401 — which is what users see as "delete is
 * broken".
 */

/**
 * WARP-1726 — the outcome of one `/api/auth/refresh` attempt.
 *
 * This used to collapse to a boolean, so the caller could not tell "someone
 * else is rotating this token right now" from "this session is over" and
 * treated both as a logout. On the Network tab — which polls devices every 10s
 * plus groups, APs, AP Wi-Fi and per-AP radios every 30s — an access-token
 * expiry 401s a handful of requests at once, and any two browser contexts
 * sharing the cookie jar race into the refresh endpoint. The loser's 401 then
 * hard-navigated to /login, AuthGate found the session serviceable and bounced
 * back, and the round trip cold-reloaded the page. That is the reload loop.
 *
 *   refreshed       — new token pair is in the cookie jar; retry the call.
 *   transient       — the refresh delivered NO verdict about the session.
 *                     Leave everything alone and let the next poll retry.
 *   unauthenticated — the refresh looks like a real end-of-session.
 *                     `confirmed` says whether the server's answer was
 *                     definitive on its own (see NO_REFRESH_TOKEN_CODE); when
 *                     it isn't, an independent probe has to agree before we act.
 */
type RefreshOutcome =
  | { kind: "refreshed" }
  | { kind: "transient"; reason: "rotation" | "network" | "unavailable" }
  | { kind: "unauthenticated"; confirmed: boolean };

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * The orchestrator's label for "another caller holds the exclusive rotation
 * claim for this refresh token" (apps/orchestrator/src/routes/auth.ts). It is
 * a 401 because the claim must reject the loser — but it says nothing about
 * whether the session is alive, and by the next poll the winner's rotation has
 * landed in the shared cookie jar.
 */
const ROTATION_IN_FLIGHT_CODE = "ROTATION_IN_FLIGHT";

/**
 * WARP-1726 (second pass) — the orchestrator's label for "you presented no
 * refresh token at all" (apps/orchestrator/src/routes/auth.ts).
 *
 * This is the one refresh 401 that needs no second opinion. Reaching it means
 * the original request 401'd (so the access token is gone or invalid) AND the
 * browser holds no refresh cookie, so there is no credential left anywhere to
 * rescue the session with — `/api/auth/me` can only echo the same 401. Skipping
 * that probe removes a request from every anonymous page load, where the
 * sequence was /api/auth/me → /api/auth/refresh → /api/auth/me.
 *
 * Deliberately narrow: ONLY this code short-circuits, and only on a 401.
 * SESSION_EXPIRED and USER_NOT_PROVISIONED still get probed — the refresh
 * cookie has its own path scope and its own rotation state, so a failure there
 * is evidence about the TOKEN, not proof about the SESSION. An unlabelled 401
 * likewise still probes.
 */
const NO_REFRESH_TOKEN_CODE = "NO_REFRESH_TOKEN";

/**
 * Endpoints that must NOT trigger the 401 → refresh → retry dance. These are
 * the auth *lifecycle* routes whose own 401 is meaningful (a bad login, an
 * already-dead refresh cookie, the OIDC callback, logout) — refreshing on their
 * 401 is pointless or recursive. Everything ELSE under /api/auth — notably
 * `/api/auth/change-password` and `/api/auth/me` (whose comment explicitly says
 * it should refresh) — DOES get the normal refresh+retry, so a merely-expired
 * access token doesn't read as "logged out" mid-session. (Previously a broad
 * `url.includes("/api/auth/")` skipped refresh for all of these.)
 *
 * Matching is by exact PATHNAME (see isAuthLifecycleUrl) — never substring.
 */
const NO_REFRESH_PATHS = [
  "/api/auth/login",
  "/api/auth/refresh",
  "/api/auth/callback",
  "/api/auth/logout",
];

/**
 * True when `url` targets one of the NO_REFRESH_PATHS lifecycle routes.
 *
 * pr-reviewer (PR #549, finding 2): a substring `url.includes(p)` here matched
 * any URL merely CONTAINING a lifecycle path — `/api/auth/login-history`
 * contains `/api/auth/login`, `/api/auth/refresh-token` contains
 * `/api/auth/refresh` — silently turning their expired-token 401s into hard
 * logouts. Compare the parsed PATHNAME instead: query strings are ignored, an
 * absolute URL still matches its path, and only an exact path (or a true
 * sub-segment, e.g. a future `/api/auth/callback/<provider>`) counts. All
 * current callers pass relative `/api/...` paths (lib/api.ts BASE = "").
 */
function isAuthLifecycleUrl(url: string): boolean {
  let pathname: string;
  try {
    const base =
      typeof window !== "undefined" ? window.location.origin : "http://localhost";
    pathname = new URL(url, base).pathname;
  } catch {
    // Unparseable input — fall back to stripping query/hash from the raw string.
    pathname = url.split(/[?#]/, 1)[0];
  }
  return NO_REFRESH_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Single-flighted token refresh. Concurrent 401s share ONE round trip and all
 * receive the same classified outcome (a plain object, not the Response — a
 * body can only be read once, and every awaiter needs the verdict).
 *
 * Classification rule, in one line: a failure is TRANSIENT when the refresh
 * endpoint never got as far as judging the session.
 *
 *   - fetch rejected (offline, DNS, TLS, aborted) — nothing was judged. This
 *     is also where the AUTH_SINGLE_FLIGHT_TIMEOUT_MS abort lands: a box that
 *     never answered told us precisely nothing about the session.
 *   - 5xx / 429 — the box is unwell or shedding load, not ending the session.
 *   - 401 + ROTATION_IN_FLIGHT — a deliberate "not you, try again" from the
 *     rotation claim.
 *
 * Everything else — a 401/403 that isn't the rotation label, or any other
 * non-OK status — is treated as `unauthenticated`, which is still only ACTED on
 * after `confirmSessionDead()` agrees, EXCEPT for the one server answer that is
 * definitive by itself (NO_REFRESH_TOKEN_CODE). Erring toward `transient` is
 * the safe direction: the cost of a false transient is one more 401 on the
 * next poll, while the cost of a false logout is the full-page bounce this
 * ticket exists to remove.
 */
async function attemptRefresh(): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      // Bounded: an unbounded single-flight that never settles poisons the slot
      // for every later caller (see AUTH_SINGLE_FLIGHT_TIMEOUT_MS).
      signal: timeoutSignal(AUTH_SINGLE_FLIGHT_TIMEOUT_MS),
      // Trace this like every other call through authFetch, so an auth incident
      // can be followed end-to-end in the orchestrator logs. Its own id: this
      // round trip is SHARED by every 401 that raced into it, so it belongs to
      // none of their requests.
      headers: { "x-request-id": crypto.randomUUID() },
    })
      .then(async (r): Promise<RefreshOutcome> => {
        if (r.ok) return { kind: "refreshed" };
        if (r.status >= 500 || r.status === 429) {
          return { kind: "transient", reason: "unavailable" };
        }
        const body = (await r.json().catch(() => null)) as { code?: unknown } | null;
        if (r.status === 401 && body?.code === ROTATION_IN_FLIGHT_CODE) {
          return { kind: "transient", reason: "rotation" };
        }
        // The browser holds no refresh credential — nothing a probe could add.
        if (r.status === 401 && body?.code === NO_REFRESH_TOKEN_CODE) {
          return { kind: "unauthenticated", confirmed: true };
        }
        return { kind: "unauthenticated", confirmed: false };
      })
      // A rejection here is the transport failing — offline, DNS, TLS, or our
      // own timeout abort — or, defensively, a throw while classifying. None of
      // those is an auth verdict.
      .catch((): RefreshOutcome => ({ kind: "transient", reason: "network" }))
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * WARP-1726 — the last-resort confirmation before we destroy a session.
 *
 * Deliberately a PLAIN `fetch`, never `authFetch`: routing it back through the
 * wrapper would re-enter the 401 → refresh → probe path recursively.
 * (`isAuthLifecycleUrl` does NOT exempt `/api/auth/me` — that path is meant to
 * refresh+retry for ordinary callers — so the plain fetch is what makes this
 * safe, not the exemption list.)
 *
 * Returns true ONLY on a definitive unauthenticated answer. A 200 means the
 * refresh failure was a false alarm; a 5xx, a rejected fetch, or a probe that
 * ran out its AUTH_SINGLE_FLIGHT_TIMEOUT_MS budget all mean we simply could not
 * find out, and an unprovable claim must never cost the user their session
 * (same posture as DASH-005 in `restoreSession` below). Note which way the
 * timeout falls here: a box that goes silent is the LEAST trustworthy moment to
 * destroy a session, so an abort keeps it. Single-flighted so an auth storm
 * costs one probe, not one per pending request — and bounded for the same
 * reason `attemptRefresh` is: an immortal promise in this slot would leave
 * every later confirmed-dead caller waiting on it forever.
 */
let sessionProbeInFlight: Promise<boolean> | null = null;

async function confirmSessionDead(): Promise<boolean> {
  if (!sessionProbeInFlight) {
    sessionProbeInFlight = fetch("/api/auth/me", {
      credentials: "same-origin",
      signal: timeoutSignal(AUTH_SINGLE_FLIGHT_TIMEOUT_MS),
      headers: { "x-request-id": crypto.randomUUID() },
    })
      .then((r) => r.status === 401 || r.status === 403)
      .catch(() => false)
      .finally(() => {
        sessionProbeInFlight = null;
      });
  }
  return sessionProbeInFlight;
}

export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const requestId = crypto.randomUUID();
  const withRid = (i?: RequestInit): RequestInit => ({
    ...i,
    headers: { ...(i?.headers as Record<string, string> | undefined), "x-request-id": requestId },
  });
  const res = await fetch(url, { ...withRid(init), credentials: "same-origin" });

  // A must-change-password user gets 403 PASSWORD_CHANGE_REQUIRED on every
  // gated call. If a stale cached profile (mustChangePassword:false) let AuthGate
  // skip the /change-password redirect, the user would otherwise sit on the
  // dashboard while every call silently 403s. Route them to remediation on the
  // FIRST gated 403. Clone the response so the caller still reads an intact body;
  // never await/consume the original. Guard against a redirect loop by checking
  // we're not already on /change-password.
  if (
    res.status === 403 &&
    typeof window !== "undefined" &&
    window.location.pathname !== "/change-password"
  ) {
    res
      .clone()
      .json()
      .then((b) => {
        if (
          b?.code === "PASSWORD_CHANGE_REQUIRED" &&
          typeof window !== "undefined" &&
          window.location.pathname !== "/change-password"
        ) {
          window.location.assign("/change-password");
        }
      })
      .catch(() => {
        /* non-JSON / unrelated 403 — leave the caller's handling intact */
      });
    return res;
  }

  if (
    res.status !== 401 ||
    typeof window === "undefined" ||
    isAuthLifecycleUrl(url)
  ) {
    return res;
  }

  const outcome = await attemptRefresh();
  if (outcome.kind === "refreshed") {
    // Give the retry a FRESH timeout instead of inheriting `init.signal`
    // (onboard#477): the caller's signal may already be spent by the initial
    // request + refresh, and spreading it here would abort the retry instantly.
    const { signal: _staleSignal, ...rest } = init ?? {};
    return fetch(url, {
      ...withRid(rest),
      signal: timeoutSignal(AUTHFETCH_RETRY_TIMEOUT_MS),
      credentials: "same-origin",
    });
  }

  // WARP-1726 — the refresh failed but told us nothing about the session.
  // Hand the caller its original 401 and change NOTHING else: no cache
  // eviction, no navigation. Every consumer of authFetch already handles a
  // 401 (SWR surfaces it as an error and re-polls), and by the next poll the
  // rotation that beat us has landed in the shared cookie jar. Tearing the
  // page down here is what produced the reload loop.
  if (outcome.kind === "transient") {
    return res;
  }

  // Looks like a real end-of-session. Before doing anything destructive, ask
  // ONE independent question — is this session actually unauthenticated? The
  // refresh cookie has its own path scope and its own rotation state, so a
  // failure there is evidence, not proof. Only a definitive answer from
  // /api/auth/me earns the logout.
  //
  // The single exception is a server answer that is already conclusive:
  // NO_REFRESH_TOKEN means the browser presented no refresh credential, so the
  // probe could only re-derive the same 401 (WARP-1726 second pass). Every
  // other unauthenticated verdict — including an unlabelled 401 — still pays
  // for the confirmation.
  if (!outcome.confirmed && !(await confirmSessionDead())) {
    return res;
  }

  // Confirmed dead. Drop cached user and bounce to login so the UI doesn't
  // keep showing stale data while every call 401s.
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore — privacy mode, etc. */
  }
  // Public pages own their anonymous flow: a refresh failure on /setup (the
  // first-run wizard probing /api/auth/me on an unclaimed box) or /login must
  // NOT hard-navigate to /login — AuthGate routes those contextually
  // client-side (unclaimed -> /setup). Without this guard every anonymous
  // cold load of /setup detoured through /login with a full page reload
  // (PR #549 review). Mirrors AuthGate's PUBLIC_PATHS + the /help semi-public
  // path added by WARP-930 (AuthGate now renders /help standalone without a
  // session; without this mirror, authFetch 401s from ShellPage would hard-
  // navigate anonymous /help visitors to /login, destroying wizard context).
  const onPublicPage =
    ["/login", "/setup"].some((p) =>
      window.location.pathname.startsWith(p),
    ) || window.location.pathname === HELP_PATH;
  if (!onPublicPage) {
    window.location.assign(
      `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    );
  }
  return res;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [setupState, setSetupState] = useState<SetupStateInfo | null>(null);
  const [setupProbeError, setSetupProbeError] = useState<string | null>(null);
  // WARP-667 — how many cold-boot auto-retries of the setup-state probe have
  // fired so far. Walks the SETUP_PROBE_RETRY_DELAYS_MS backoff and, once it
  // reaches the cap, stops the loop and lets AuthGate fall back to manual Retry.
  const [setupRetryAttempt, setSetupRetryAttempt] = useState(0);
  const [completeSetupError, setCompleteSetupError] = useState<string | null>(
    null,
  );

  /**
   * M3 — the lifecycle probe. Fetches `GET /api/setup/state` and records an
   * EXPLICIT error when it can't resolve (network failure OR non-2xx) instead
   * of silently leaving `setupState` null and letting AuthGate guess. On
   * success it clears the error and stores the state. Returns whether the
   * probe resolved, so init() (and the retry affordance) can branch on it.
   */
  const probeSetupState = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const setupRes = await fetch("/api/setup/state", { signal });
      if (!setupRes.ok) {
        setSetupProbeError(
          `Couldn't read appliance setup state (HTTP ${setupRes.status}).`,
        );
        return false;
      }
      const data = await setupRes.json();
      setSetupState({
        appliance: data.appliance,
        setupStep: data.setup_step,
        userTourCompleted: data.user_tour_completed,
      });
      setSetupProbeError(null);
      return true;
    } catch {
      setSetupProbeError(
        "Couldn't reach the appliance to read setup state. Check the connection and retry.",
      );
      return false;
    }
    },
    [],
  );

  // Restore the session probe (`GET /api/auth/me`) — split out of init() so
  // the boot path can run it CONCURRENTLY with the setup-state probe and bound
  // it with the same timeout. Both probes were previously serialized AND
  // un-timed, so a single slow/hung first response pinned `isLoading` true and
  // AuthGate showed the full-screen spinner for the whole app (blank login +
  // "needs a refresh" nav). This never throws — on timeout/network-error it
  // falls back to the cached profile for optimistic display, mirroring the
  // original behaviour.
  const restoreSession = useCallback(async (signal?: AbortSignal) => {
    try {
      // The HTTP-only cookie is sent automatically; a valid cookie returns
      // the user. authFetch handles a 401 → silent refresh → retry once.
      const meRes = await authFetch("/api/auth/me", { signal });

      if (meRes.ok) {
        const userData: AuthUser = await meRes.json();
        setUser(userData);
        // Cache user profile for fast hydration on next visit
        localStorage.setItem(USER_KEY, JSON.stringify(userData));
      } else if (meRes.status === 401 || meRes.status === 403) {
        // Definitive auth answer — cookie absent/expired. Clear stale cache.
        localStorage.removeItem(USER_KEY);
      } else {
        // DASH-005: a 5xx is the orchestrator erroring, NOT an auth verdict.
        // Fall through to the cached profile (same as the catch below) so a
        // transient orchestrator 500/503 doesn't bounce a validly-cookied user
        // to /login.
        const cached = localStorage.getItem(USER_KEY);
        if (cached) {
          try {
            setUser(JSON.parse(cached));
          } catch {
            localStorage.removeItem(USER_KEY);
          }
        }
      }
    } catch {
      // API unreachable / timed out — try local cache for optimistic display.
      const cached = localStorage.getItem(USER_KEY);
      if (cached) {
        try {
          setUser(JSON.parse(cached));
        } catch {
          localStorage.removeItem(USER_KEY);
        }
      }
    }
  }, []);

  // On mount, check stored auth and setup status
  useEffect(() => {
    async function init() {
      // Race both boot probes against a shared timeout. Running them
      // CONCURRENTLY (not serialized) halves the cold-start wait. We pass the
      // timeout's AbortSignal so a well-behaved fetch actually cancels the
      // hung request AND we race the combined probes against a timeout that
      // RESOLVES — so `isLoading` flips false even if the underlying transport
      // ignores the abort. Either way the app settles into a usable state
      // (login / unauthenticated) instead of an infinite spinner. Each probe
      // swallows its own abort/error, so neither branch of the race rejects.
      const signal = timeoutSignal(AUTH_INIT_TIMEOUT_MS);
      const probes = Promise.all([
        probeSetupState(signal),
        restoreSession(signal),
      ]);
      const timedOut = new Promise<void>((resolve) =>
        setTimeout(resolve, AUTH_INIT_TIMEOUT_MS),
      );
      try {
        await Promise.race([probes, timedOut]);
      } finally {
        setIsLoading(false);
      }
    }

    init();
  }, [probeSetupState, restoreSession]);

  // WARP-667 — bounded cold-boot auto-retry of the setup-state probe. Fires
  // only once init() has settled (isLoading false), the probe FAILED
  // (setupProbeError set) and there's still no state to route off (setupState
  // null). Each failure bumps setupRetryAttempt, which walks the backoff and
  // re-arms this effect; a success populates setupState so the guard below
  // short-circuits and the loop stops. `cancelled` guards the post-await bump so
  // an unmount mid-flight can't re-arm a torn-down provider.
  useEffect(() => {
    if (isLoading) return;
    if (setupProbeError === null || setupState !== null) return;
    if (setupRetryAttempt >= SETUP_PROBE_RETRY_DELAYS_MS.length) return;

    let cancelled = false;
    const id = setTimeout(async () => {
      const ok = await probeSetupState(timeoutSignal(AUTH_INIT_TIMEOUT_MS));
      if (cancelled || ok) return; // success → setupState set → effect stops
      setSetupRetryAttempt((n) => n + 1); // failure → walk the backoff
    }, SETUP_PROBE_RETRY_DELAYS_MS[setupRetryAttempt]);

    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [isLoading, setupProbeError, setupState, setupRetryAttempt, probeSetupState]);

  const login = useCallback(
    async (
      username: string,
      password: string,
      secondFactor?: SecondFactor,
    ) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        username,
        password,
        // PR #375: the second factor rides on the SAME login request as the
        // password — the orchestrator re-verifies the password and then the
        // code in one call. Only send the field actually being answered so an
        // empty string never reaches the strict (max-length) login schema.
        ...(secondFactor?.totp ? { totp: secondFactor.totp } : {}),
        ...(secondFactor?.recoveryCode
          ? { recoveryCode: secondFactor.recoveryCode }
          : {}),
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // PR #375 second-factor gate: a CORRECT password on a 2FA-enabled account
      // returns 401 { code: "TOTP_REQUIRED" } and sets no cookie. Surface it as
      // a typed signal so the page reveals the code field and re-submits — the
      // generic throw below would otherwise hit translateError's 401 fallback
      // ("check your username and password"), which is wrong: the password was
      // right. A wrong code on the retry returns the same shape and lands here
      // again; the page treats that as an invalid-code error via its own state.
      if (res.status === 401 && data?.code === "TOTP_REQUIRED") {
        throw new TotpRequiredError();
      }
      // Preserve the orchestrator's typed code + status so translateError can
      // map precise copy (previously only the message survived, so a 401 with
      // no message fell through to the domain fallback).
      throw Object.assign(new Error(data?.error || "Login failed"), {
        code: typeof data?.code === "string" ? data.code : undefined,
        status: res.status,
      });
    }

    const data = await res.json();
    // The server sets the HTTP-only cookie — we only store the user profile
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    // WARP-867 — re-read the AUTHORITATIVE lifecycle state before exposing
    // the user to AuthGate, instead of force-flipping the in-memory
    // appliance to "ready" (the previous behaviour). The flip was meant to
    // stop a fresh sign-in being bounced into the wizard on a stale state,
    // but on a genuinely unclaimed box — signing in mid-setup after a
    // reboot, exactly the account step's "owner already exists" resume path
    // — it parked the owner on the dashboard of a half-configured box until
    // the next refresh re-probed the truth. AuthGate now treats
    // authenticated+unclaimed as a stable wizard state, so routing off the
    // real answer is correct in both directions. The probe is bounded and
    // never throws; if it fails, the last-known state stands and AuthGate
    // routes off that.
    await probeSetupState(timeoutSignal(AUTH_INIT_TIMEOUT_MS));
    setUser(data.user);
  }, [probeSetupState]);

  const setUserFromPasskey = useCallback((u: AuthUser) => {
    // The cookie is already set server-side by authenticate/verify — same as
    // the password login, we only persist the profile for fast hydration.
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    } catch {
      /* ignore — privacy mode, etc. */
    }
    setUser(u);
    // WARP-867 — mirror login(): re-probe the authoritative lifecycle state
    // instead of force-flipping the in-memory appliance to "ready" (passkeys
    // can be enrolled at the wizard's two-factor step, so a passkey sign-in
    // on a still-unclaimed box is a real resume path). Fire-and-forget to
    // keep this setter synchronous for its callers; until the probe lands,
    // AuthGate routes off the last-known state — authenticated+unclaimed is
    // a stable wizard state now, so no flip-flop either way.
    void probeSetupState(timeoutSignal(AUTH_INIT_TIMEOUT_MS));
  }, [probeSetupState]);

  const logout = useCallback(async () => {
    try {
      await authFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore — cookie will be cleared server-side; we clean up locally regardless
    }
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  const completeSetup = useCallback(async (): Promise<boolean> => {
    setCompleteSetupError(null);
    // Snapshot the pre-flip appliance so we can ROLL BACK if the server
    // persist fails (M4) — otherwise the UI would show "ready" while the
    // server stays "unclaimed" and the next refresh re-traps the owner.
    let previousAppliance: "unclaimed" | "ready" = "unclaimed";
    setSetupState((prev) => {
      previousAppliance = prev?.appliance ?? "unclaimed";
      return prev
        ? { ...prev, appliance: "ready" }
        : { appliance: "ready", setupStep: "done", userTourCompleted: false };
    });
    // Durably persist the finish transition. The orchestrator's
    // `markApplianceReady` flips the explicit `ApplianceSetup.state` column so
    // a hard refresh reads `ready` instead of re-trapping the owner.
    try {
      await patchSetupReady();
      return true;
    } catch (err) {
      // M4 — the persist failed. Roll the optimistic flip back to the real
      // (server-truth) value and surface the error so the UI can show a
      // retry, instead of leaving UI/server diverged. The transition is
      // idempotent, so retrying is safe.
      setSetupState((prev) =>
        prev ? { ...prev, appliance: previousAppliance } : prev,
      );
      setCompleteSetupError(
        err instanceof Error
          ? err.message
          : "Couldn't finish setup. Please retry.",
      );
      return false;
    }
  }, []);

  // M3 — retry affordance for the lifecycle probe.
  const retrySetupProbe = useCallback(async () => {
    // Bound the retry the same way init() does (onboard#477): without a signal a
    // still-hung /api/setup/state leaves setupProbeError set + probeBlocked true
    // while isLoading is already false, freezing the retry screen with no escape.
    await probeSetupState(timeoutSignal(AUTH_INIT_TIMEOUT_MS));
  }, [probeSetupState]);

  const completeTour = useCallback(async () => {
    // Optimistically flip the in-memory tour flag so AuthGate's
    // "ready + tour pending → /tour" branch stops firing the instant the
    // owner finishes (no flash of the tour on the way to the dashboard). If
    // `setupState` hasn't resolved yet we synthesize a ready/done baseline —
    // reaching the tour at all means the appliance is claimed.
    setSetupState((prev) =>
      prev
        ? { ...prev, userTourCompleted: true }
        : { appliance: "ready", setupStep: "done", userTourCompleted: true },
    );
    // Durably persist. Mirrors completeSetup: awaited so persisted + in-memory
    // agree before we settle; patchTourCompleted swallows transient network
    // errors and the next state GET re-syncs, so this never rejects.
    await patchTourCompleted();
  }, []);

  // WARP-824 — flip the in-memory must-change flag false after a successful
  // password change (the server already cleared the persisted flag). Also
  // refresh the cached profile so a reload before the next /auth/me reflects
  // the change. AuthGate's `forcePasswordChange` re-evaluates and releases the
  // user into the dashboard.
  const markPasswordChanged = useCallback(() => {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, mustChangePassword: false };
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(next));
      } catch {
        /* ignore — privacy mode, etc. */
      }
      return next;
    });
  }, []);

  // Back-compat: derive the legacy boolean from the explicit state so any
  // consumer still reading `setupRequired` keeps working during migration.
  const setupRequired: boolean | null =
    setupState === null ? null : setupState.appliance === "unclaimed";

  // WARP-667 — true from the first failed boot probe through the last bounded
  // auto-retry (probe failed, no state yet, attempts remain). AuthGate shows
  // "Reconnecting…" while true and the manual Retry only once it's false.
  const setupAutoRetrying =
    setupProbeError !== null &&
    setupState === null &&
    setupRetryAttempt < SETUP_PROBE_RETRY_DELAYS_MS.length;

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        setupState,
        setupRequired,
        setupProbeError,
        retrySetupProbe,
        setupAutoRetrying,
        completeSetupError,
        login,
        // PR #377: passwordless passkey sign-in hydrates the context here.
        setUserFromPasskey,
        logout,
        completeSetup,
        completeTour,
        markPasswordChanged,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

// ── Legacy exports (kept for backward compatibility during migration) ──

/** @deprecated Use authFetch() instead — tokens are now in HTTP-only cookies */
export function getStoredToken(): string | null {
  return null;
}

/** @deprecated Use authFetch() instead — tokens are now in HTTP-only cookies */
export function getAuthHeaders(): Record<string, string> {
  return {};
}
