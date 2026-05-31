"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

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
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  completeSetup: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const USER_KEY = "droplet-auth-user";

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
  const [setupState, setSetupState] = useState<SetupStateInfo | null>(null);

  // On mount, check stored auth and setup status
  useEffect(() => {
    async function init() {
      try {
        // PR #372 — explicit, resumable setup state. The orchestrator
        // returns snake_case; map it onto the camelCase context shape.
        const setupRes = await fetch("/api/setup/state");
        if (setupRes.ok) {
          const data = await setupRes.json();
          setSetupState({
            appliance: data.appliance,
            setupStep: data.setup_step,
            userTourCompleted: data.user_tour_completed,
          });
        }

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
        // API unreachable — try local cache for optimistic display
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
    }

    init();
  }, []);

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
    // Optimistically flip the appliance to ready so AuthGate routes to the
    // dashboard immediately. The orchestrator is the source of truth (the
    // wizard PATCHes `appliance=ready` on finish); this just avoids a
    // flash of the wizard while the next `/api/setup/state` fetch lands.
    setSetupState((prev) =>
      prev
        ? { ...prev, appliance: "ready" }
        : { appliance: "ready", setupStep: "done", userTourCompleted: false },
    );
  }, []);

  // Back-compat: derive the legacy boolean from the explicit state so any
  // consumer still reading `setupRequired` keeps working during migration.
  const setupRequired: boolean | null =
    setupState === null ? null : setupState.appliance === "unclaimed";

  return (
    <AuthContext.Provider
      value={{ user, isLoading, setupState, setupRequired, login, logout, completeSetup }}
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
