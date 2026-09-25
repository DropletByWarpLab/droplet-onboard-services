// @vitest-environment jsdom
/**
 * WARP-2981 (ADR-059 P6; rjouffret's non-blocking 2 on 5cadd357) — a TV's
 * sign-in ends on the Security wall.
 *
 * Everywhere else a confirmed-dead session hard-navigates to
 * /login?next=<page> (WARP-1726). On the wall that put a sign-in form in
 * front of a room, and whoever walked up typed a password in front of it.
 * On the wall authFetch does NOT navigate: it tells the provider, which drops
 * the user, and AuthGate's wall branch shows "This TV view is signed out"
 * (pinned in auth-gate.routing). Only the confirmed-dead path changes: a
 * transient refresh failure still changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  patchSetupReady: vi.fn(),
  patchTourCompleted: vi.fn(),
}));

import { AuthProvider, WALL_SIGNED_OUT_EVENT, authFetch, useAuth } from "@/lib/auth";

const USER_KEY = "droplet-auth-user";
const realLocation = window.location;

function stubLocation(pathname: string) {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...realLocation, pathname, search: "", assign },
  });
  return assign;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** /auth/me answers `me()`; refresh always fails as expired; everything else 401s. */
function stubFetch(me: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/setup/state") return Promise.resolve(json({ appliance: "ready", setup_step: "done", user_tour_completed: true }, 200));
      if (url === "/api/auth/refresh") return Promise.resolve(json({ code: "SESSION_EXPIRED" }, 401));
      if (url === "/api/auth/me") return Promise.resolve(me());
      return Promise.resolve(new Response("", { status: 401 }));
    }),
  );
}

beforeEach(() => {
  localStorage.setItem(USER_KEY, JSON.stringify({ id: "u-1", username: "tv", displayName: "TV", role: "family" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: realLocation });
});

describe("authFetch — a dead session on the Security wall never opens a sign-in form by itself", () => {
  it.each(["/security/wall", "/security/wall/"])("on %s: no navigation — the provider is told instead, and the session's cache is still forgotten", async (path) => {
    const assign = stubLocation(path);
    stubFetch(() => new Response("", { status: 401 }));
    const heard = vi.fn();
    window.addEventListener(WALL_SIGNED_OUT_EVENT, heard);
    try {
      const res = await authFetch("/api/security/mode");
      expect(res.status).toBe(401);
      expect(assign).not.toHaveBeenCalled();
      expect(heard).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(USER_KEY)).toBeNull();
    } finally {
      window.removeEventListener(WALL_SIGNED_OUT_EVENT, heard);
    }
  });

  it("anywhere else (even /security/wallpaper) it still goes to /login?next=…, and the wall is not told", async () => {
    const assign = stubLocation("/security/wallpaper");
    stubFetch(() => new Response("", { status: 401 }));
    const heard = vi.fn();
    window.addEventListener(WALL_SIGNED_OUT_EVENT, heard);
    try {
      await authFetch("/api/security/mode");
      expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/security/wallpaper")}`);
      expect(heard).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(WALL_SIGNED_OUT_EVENT, heard);
    }
  });

  it("a session /auth/me says is alive: nothing happens on the wall either", async () => {
    const assign = stubLocation("/security/wall");
    stubFetch(() => json({ id: "u-1", username: "tv" }, 200));
    const heard = vi.fn();
    window.addEventListener(WALL_SIGNED_OUT_EVENT, heard);
    try {
      await authFetch("/api/security/mode");
      expect(assign).not.toHaveBeenCalled();
      expect(heard).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(WALL_SIGNED_OUT_EVENT, heard);
    }
  });
});

function Who() {
  const { user, isLoading } = useAuth();
  return <span data-testid="who">{isLoading ? "loading" : (user?.username ?? "nobody")}</span>;
}

describe("AuthProvider — the wall's sign-out reaches the tree", () => {
  it("signed in on the wall, then the session dies: the user is dropped (so AuthGate shows the signed-out notice) — no navigation", async () => {
    const assign = stubLocation("/security/wall");
    let alive = true;
    stubFetch(() => (alive ? json({ id: "u-1", username: "tv", displayName: "TV", role: "family" }, 200) : new Response("", { status: 401 })));
    render(
      <AuthProvider>
        <Who />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("tv"));
    alive = false;
    await act(async () => {
      await authFetch("/api/security/incidents/summary");
    });
    await waitFor(() => expect(screen.getByTestId("who")).toHaveTextContent("nobody"));
    expect(assign).not.toHaveBeenCalled();
  });
});
