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

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  // Role mirrors the orchestrator's JWT role enum. /api/auth/me returns
  // it; we keep it optional here so older cached profiles don't break
  // the type. WARP-279 added the field for the /admin/claude-activity
  // visibility check.
  role?: "owner" | "admin" | "family" | "guest";
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
  // M4 (PR #372 re-review) — the wizard-FINISH PATCH can fail. When it does,
  // this carries the error and the optimistic in-memory `ready` flip is
  // rolled back, so the UI shows the failure + a retry instead of silently
  // diverging from the (still `unclaimed`) server. `null` on success.
  completeSetupError: string | null;
  login: (username: string, password: string) => Promise<void>;
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
}

const AuthContext = createContext<AuthContextValue | null>(null);

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
 * once; if it fails we evict the cached user and bounce to /login. Without
 * this, an expired session leaves stale SWR data on screen and every action
 * silently fails with 401 — which is what users see as "delete is broken".
 */
let refreshInFlight: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, credentials: "same-origin" });

  if (
    res.status !== 401 ||
    typeof window === "undefined" ||
    url.includes("/api/auth/")
  ) {
    return res;
  }

  const refreshed = await attemptRefresh();
  if (refreshed) {
    // Give the retry a FRESH timeout instead of inheriting `init.signal`
    // (onboard#477): the caller's signal may already be spent by the initial
    // request + refresh, and spreading it here would abort the retry instantly.
    const { signal: _staleSignal, ...rest } = init ?? {};
    return fetch(url, {
      ...rest,
      signal: timeoutSignal(AUTHFETCH_RETRY_TIMEOUT_MS),
      credentials: "same-origin",
    });
  }

  // Refresh failed — session is truly dead. Drop cached user and bounce to
  // login so the UI doesn't keep showing stale data while every call 401s.
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore — privacy mode, etc. */
  }
  if (!window.location.pathname.startsWith("/login")) {
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
      } else {
        // Cookie absent or expired — clear stale local cache
        localStorage.removeItem(USER_KEY);
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

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Login failed");
    }

    const data = await res.json();
    // The server sets the HTTP-only cookie — we only store the user profile
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
    // A successful sign-in means setup is past the account step at minimum.
    // The orchestrator owns the authoritative `appliance` state; reflect a
    // ready appliance locally so AuthGate doesn't bounce the freshly
    // authenticated user back into the wizard before the next state fetch.
    setSetupState((prev) =>
      prev
        ? { ...prev, appliance: "ready" }
        : { appliance: "ready", setupStep: "done", userTourCompleted: false },
    );
  }, []);

  const setUserFromPasskey = useCallback((u: AuthUser) => {
    // The cookie is already set server-side by authenticate/verify — same as
    // the password login, we only persist the profile for fast hydration.
    try {
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    } catch {
      /* ignore — privacy mode, etc. */
    }
    setUser(u);
    // A successful passkey sign-in means the appliance is past first-run.
    // Mirror login(): flip the in-memory appliance to "ready" so AuthGate
    // doesn't bounce the freshly authenticated user back into the wizard
    // before the next `/api/setup/state` fetch lands. The orchestrator
    // remains the authoritative source for the `appliance` state.
    setSetupState((prev) =>
      prev
        ? { ...prev, appliance: "ready" }
        : { appliance: "ready", setupStep: "done", userTourCompleted: false },
    );
  }, []);

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

  // Back-compat: derive the legacy boolean from the explicit state so any
  // consumer still reading `setupRequired` keeps working during migration.
  const setupRequired: boolean | null =
    setupState === null ? null : setupState.appliance === "unclaimed";

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        setupState,
        setupRequired,
        setupProbeError,
        retrySetupProbe,
        completeSetupError,
        login,
        // PR #377: passwordless passkey sign-in hydrates the context here.
        setUserFromPasskey,
        logout,
        completeSetup,
        completeTour,
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
