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
  token: string | null;
  isLoading: boolean;
  setupRequired: boolean | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  completeSetup: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = "droplet-auth-token";
const USER_KEY = "droplet-auth-user";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
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

        // Restore session from localStorage
        const storedToken = localStorage.getItem(TOKEN_KEY);
        const storedUser = localStorage.getItem(USER_KEY);

        if (storedToken && storedUser) {
          // Validate the token is still good
          const meRes = await fetch("/api/auth/me", {
            headers: { Authorization: `Bearer ${storedToken}` },
          });

          if (meRes.ok) {
            const userData = await meRes.json();
            setToken(storedToken);
            setUser(userData);
          } else {
            // Token expired — clear storage
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
          }
        }
      } catch {
        // API unreachable — leave state as unauthenticated
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
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Login failed");
    }

    const data = await res.json();
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
    setSetupRequired(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      const storedToken = localStorage.getItem(TOKEN_KEY);
      if (storedToken) {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${storedToken}` },
        });
      }
    } catch {
      // ignore
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const completeSetup = useCallback(() => {
    setSetupRequired(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, token, isLoading, setupRequired, login, logout, completeSetup }}
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
