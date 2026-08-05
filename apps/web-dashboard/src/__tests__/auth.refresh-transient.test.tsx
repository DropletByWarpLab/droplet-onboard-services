// @vitest-environment jsdom
/**
 * WARP-1726 — a failed `/api/auth/refresh` is not automatically a dead session.
 *
 * The Network tab polls many endpoints concurrently (devices every 10s, groups,
 * APs / AP Wi-Fi / per-AP radios every 30s). When the access token expires
 * several of those 401 at once and race into `/auth/refresh`. `authFetch`
 * single-flights the refresh PER TAB, but two tabs sharing one cookie jar still
 * collide, and the orchestrator answers the loser 401 `ROTATION_IN_FLIGHT` (it
 * takes an exclusive rotation claim so only one new token pair can exist).
 *
 * `authFetch` used to treat ANY refresh failure as "session is dead": evict the
 * cached user, `window.location.assign('/login?next=…')`. AuthGate on /login
 * then found the session perfectly serviceable and bounced straight back — a
 * full page navigation each way, which is what users saw as the Devices tab
 * reloading, emptying and snapping to the bottom of the page, on repeat.
 *
 * These tests pin the new contract: transient failures return the original 401
 * to the caller and change nothing; a genuinely dead session still logs out,
 * but only after `/api/auth/me` independently confirms it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { authFetch } from "@/lib/auth";

const USER_KEY = "droplet-auth-user";
const CACHED_USER = JSON.stringify({ id: "u-1", username: "alice", displayName: "Alice" });

const realLocation = window.location;

function stubLocation(pathname: string, search = "") {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...realLocation, pathname, search, assign },
  });
  return assign;
}

/**
 * A fetch stub driven by a per-path response table. Records every call so a
 * test can assert on what was — and crucially, was NOT — requested.
 */
function stubFetch(routes: {
  target?: () => Response | Promise<Response>;
  refresh: () => Response | Promise<Response>;
  me?: () => Response | Promise<Response>;
}) {
  const calls: string[] = [];
  const impl = vi.fn((url: string) => {
    calls.push(url);
    if (url === "/api/auth/refresh") return Promise.resolve(routes.refresh());
    if (url === "/api/auth/me") {
      if (!routes.me) throw new Error(`unexpected probe of /api/auth/me`);
      return Promise.resolve(routes.me());
    }
    return Promise.resolve(
      routes.target ? routes.target() : new Response("", { status: 401 }),
    );
  });
  vi.stubGlobal("fetch", impl);
  return {
    calls,
    countOf: (url: string) => calls.filter((c) => c === url).length,
  };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  localStorage.setItem(USER_KEY, CACHED_USER);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

describe("authFetch — transient refresh failures never log the user out (WARP-1726)", () => {
  it("treats a ROTATION_IN_FLIGHT 401 as transient: no navigation, no cache eviction, caller gets the 401", async () => {
    const assign = stubLocation("/network", "?tab=devices");
    const f = stubFetch({
      refresh: () =>
        json(
          { error: "Refresh token is already being rotated", code: "ROTATION_IN_FLIGHT" },
          401,
        ),
    });

    const res = await authFetch("/api/network/devices");

    // The caller sees the original 401 and simply retries on its next poll —
    // by then the winning tab's rotation has landed in the shared cookie jar.
    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
    // A conflict is self-explanatory; no need to spend a probe confirming it.
    expect(f.countOf("/api/auth/me")).toBe(0);
  });

  it("treats a rejected refresh fetch (network drop) as transient", async () => {
    const assign = stubLocation("/network", "?tab=devices");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        if (url === "/api/auth/refresh") {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return Promise.resolve(new Response("", { status: 401 }));
      }),
    );

    const res = await authFetch("/api/network/devices");

    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
    expect(calls).not.toContain("/api/auth/me");
  });

  it.each([500, 502, 503, 504, 429])(
    "treats a %i from the refresh endpoint as transient (the box is unwell, not the session)",
    async (status) => {
      const assign = stubLocation("/network");
      stubFetch({ refresh: () => new Response("", { status }) });

      const res = await authFetch("/api/network/devices");

      expect(res.status).toBe(401);
      expect(assign).not.toHaveBeenCalled();
      expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
    },
  );

  it("shares one refresh across concurrent 401s and leaves every caller's 401 intact", async () => {
    const assign = stubLocation("/network");
    const f = stubFetch({
      refresh: () => json({ code: "ROTATION_IN_FLIGHT" }, 401),
    });

    const results = await Promise.all([
      authFetch("/api/network/devices"),
      authFetch("/api/network/groups"),
      authFetch("/api/network/aps"),
    ]);

    expect(results.map((r) => r.status)).toEqual([401, 401, 401]);
    // Single-flighting must survive the widened return type.
    expect(f.countOf("/api/auth/refresh")).toBe(1);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
  });
});

describe("authFetch — a genuinely dead session still logs out (WARP-1726)", () => {
  it("redirects to /login once /api/auth/me independently confirms the 401", async () => {
    const assign = stubLocation("/network", "?tab=devices");
    const f = stubFetch({
      refresh: () => json({ error: "Session expired.", code: "SESSION_EXPIRED" }, 401),
      me: () => new Response("", { status: 401 }),
    });

    const res = await authFetch("/api/network/devices");

    expect(res.status).toBe(401);
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/network?tab=devices")}`,
    );
    // The probe is a PLAIN fetch — it must not recurse back through authFetch
    // and kick off a second refresh.
    expect(f.countOf("/api/auth/me")).toBe(1);
    expect(f.countOf("/api/auth/refresh")).toBe(1);
  });

  it("does NOT log out when the probe says the session is in fact alive", async () => {
    const assign = stubLocation("/network");
    stubFetch({
      refresh: () => json({ error: "Session expired.", code: "SESSION_EXPIRED" }, 401),
      me: () => json({ id: "u-1", username: "alice", displayName: "Alice" }, 200),
    });

    const res = await authFetch("/api/network/devices");

    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
  });

  it("does NOT log out when the probe itself can't answer (5xx / unreachable)", async () => {
    const assign = stubLocation("/network");
    stubFetch({
      refresh: () => json({ code: "SESSION_EXPIRED" }, 401),
      me: () => new Response("", { status: 503 }),
    });

    const res = await authFetch("/api/network/devices");

    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
  });

  it("shares a single probe across concurrent confirmed-dead callers", async () => {
    stubLocation("/network");
    const f = stubFetch({
      refresh: () => json({ code: "SESSION_EXPIRED" }, 401),
      me: () => new Response("", { status: 401 }),
    });

    await Promise.all([
      authFetch("/api/network/devices"),
      authFetch("/api/network/groups"),
    ]);

    expect(f.countOf("/api/auth/refresh")).toBe(1);
    expect(f.countOf("/api/auth/me")).toBe(1);
  });
});

describe("authFetch — the public-page guard still suppresses navigation (WARP-1726)", () => {
  // /setup's first-run wizard probes /api/auth/me on an unclaimed box and /help
  // is reachable anonymously; both own their own anonymous flow, so a confirmed
  // dead session must clear the cache WITHOUT a hard navigation to /login.
  it.each(["/login", "/setup", "/setup/account", "/help"])(
    "clears the cached user but does not navigate from %s",
    async (pathname) => {
      const assign = stubLocation(pathname);
      stubFetch({
        refresh: () => json({ error: "No refresh token available" }, 401),
        me: () => new Response("", { status: 401 }),
      });

      const res = await authFetch("/api/setup/state");

      expect(res.status).toBe(401);
      expect(localStorage.getItem(USER_KEY)).toBeNull();
      expect(assign).not.toHaveBeenCalled();
    },
  );

  it("does not navigate away from a public page on a transient failure either", async () => {
    const assign = stubLocation("/login");
    const f = stubFetch({ refresh: () => new Response("", { status: 503 }) });

    await authFetch("/api/setup/state");

    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
    expect(f.countOf("/api/auth/me")).toBe(0);
  });
});
