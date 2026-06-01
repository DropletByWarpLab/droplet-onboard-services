"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { checkSetupRequired, type SetupStatus } from "./api";

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

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  /**
   * WARP-577: back-compat boolean derived from {@link setupStatus} so that
   * ONLY a confirmed `'required'` is `true`, `'complete'` is `false`, and an
   * indeterminate `'unknown'` stays `null` (callers already treat `null` as
   * not-yet-known). An unreachable orchestrator must never present as
   * setup-required.
   */
  setupRequired: boolean | null;
  /** WARP-577: tri-state setup probe result. The connecting/retry
   *  interstitial in AuthGate gates on `'unknown'`. */
  setupStatus: SetupStatus;
  /** WARP-577: manually re-run the setup probe (the interstitial's "Retry
   *  now" affordance). Resets the bounded-backoff schedule. */
  retrySetupCheck: () => void;
  login: (username: string, password: string) => Promise<void>;
  // PR #377: hydrate the context after a passwordless passkey sign-in. The
  // orchestrator's authenticate/verify already set the session cookie and
  // returned the user; this mirrors the tail of login() (cache + setUser)
  // without a second network round-trip.
  setUserFromPasskey: (user: AuthUser) => void;
  logout: () => Promise<void>;
  completeSetup: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const USER_KEY = "droplet-auth-user";

/**
 * WARP-577: bounded exponential backoff for re-probing an indeterminate
 * ('unknown') setup check. Covers a realistic cold-boot window (orchestrator +
 * Prisma migrations) so a provisioned box that boots while the orchestrator is
 * briefly down self-recovers without ever bouncing the user into `/setup`.
 */
const SETUP_RETRY_BACKOFFS_MS = [1000, 2000, 4000, 8000, 10000];

/** Map a tri-state SetupStatus to the back-compat `setupRequired` flag. */
function deriveSetupRequired(status: SetupStatus): boolean | null {
  if (status === "required") return true;
  if (status === "complete") return false;
  return null; // 'unknown' — not yet known
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
    return fetch(url, { ...init, credentials: "same-origin" });
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
  const [setupStatus, setSetupStatus] = useState<SetupStatus>("unknown");

  // WARP-577: track the scheduled retry timer + attempt count so we can clear
  // on unmount and reset on a manual retry.
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0);

  const clearRetry = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  // On mount, check setup status (tri-state) then restore the session.
  const init = useCallback(async () => {
    try {
      // WARP-577: setup detection is a tri-state that fails CLOSED. A non-2xx,
      // network error, or timeout yields 'unknown' — we do NOT touch user
      // state and we do NOT let AuthGate redirect to /setup; instead we retry
      // with bounded backoff until the orchestrator gives a definitive answer.
      const status = await checkSetupRequired();
      setSetupStatus(status);

      if (status === "unknown") {
        const idx = Math.min(
          retryAttempt.current,
          SETUP_RETRY_BACKOFFS_MS.length - 1,
        );
        const delay = SETUP_RETRY_BACKOFFS_MS[idx];
        retryAttempt.current += 1;
        clearRetry();
        retryTimer.current = setTimeout(() => {
          init();
        }, delay);
        // Stop the spinner so AuthGate can render the connecting interstitial.
        setIsLoading(false);
        return;
      }

      // Definitive answer — stop retrying.
      retryAttempt.current = 0;
      clearRetry();

      // Try to restore session — the HTTP-only cookie is sent automatically.
      // We call /api/auth/me; if the cookie is valid the server returns user info.
      const meRes = await authFetch("/api/auth/me");

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
      // /api/auth/me unreachable — try local cache for optimistic display.
      // (Setup detection itself never throws; it returns 'unknown'.)
      const cached = localStorage.getItem(USER_KEY);
      if (cached) {
        try {
          setUser(JSON.parse(cached));
        } catch {
          localStorage.removeItem(USER_KEY);
        }
      }
    } finally {
      setIsLoading(false);
    }
  }, [clearRetry]);

  useEffect(() => {
    init();
    return () => clearRetry();
  }, [init, clearRetry]);

  const retrySetupCheck = useCallback(() => {
    retryAttempt.current = 0;
    clearRetry();
    setIsLoading(true);
    init();
  }, [clearRetry, init]);

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
    setSetupStatus("complete");
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
    // WARP-577: a successful passkey sign-in means setup is complete, mirroring
    // the password login() path (main renamed the flag to the tri-state status).
    setSetupStatus("complete");
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

  const completeSetup = useCallback(() => {
    setSetupStatus("complete");
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        // WARP-577: only a confirmed 'required' is truthy; 'unknown' is null.
        setupRequired: deriveSetupRequired(setupStatus),
        setupStatus,
        retrySetupCheck,
        login,
        // PR #377: passwordless passkey sign-in hydrates the context here.
        setUserFromPasskey,
        logout,
        completeSetup,
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
