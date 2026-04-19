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
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
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
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);

  // On mount, check stored auth and setup status
  useEffect(() => {
    async function init() {
      try {
        // Check if setup is needed
        const setupRes = await fetch("/api/auth/setup");
        if (setupRes.ok) {
          const data = await setupRes.json();
          setSetupRequired(data.setupRequired);
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
    setSetupRequired(false);
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
    setSetupRequired(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isLoading, setupRequired, login, logout, completeSetup }}
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
