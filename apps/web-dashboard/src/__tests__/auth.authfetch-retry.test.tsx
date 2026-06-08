// @vitest-environment jsdom
/**
 * onboard#477 review (finding 1) — `authFetch`'s 401→refresh→retry must NOT
 * inherit the caller's `init.signal`. That signal can be (partly) consumed by
 * the initial request + the token refresh, so reusing it would fire the retry
 * with an already-aborted signal → instant `AbortError`, silently failing an
 * operation that a fresh token would have completed.
 *
 * NB: the reviewer's `/api/auth/me` example is actually short-circuited —
 * `authFetch` returns the 401 directly for any `/api/auth/` URL, never reaching
 * the retry. The real reachable caller is `fetchPlaces` →
 * `authFetch("/api/calendar/places", { signal })` (a non-auth URL + signal), so
 * the test drives that path.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { authFetch } from "@/lib/auth";

describe("authFetch — post-refresh retry uses a fresh signal (onboard#477)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries successfully even when the caller's signal aborts during the refresh", async () => {
    const ctrl = new AbortController();
    const calls: Array<{ url: string; aborted: boolean }> = [];
    let placesAttempts = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const aborted = Boolean(init?.signal?.aborted);
        calls.push({ url, aborted });
        // Model real fetch: an already-aborted signal rejects immediately.
        if (aborted) {
          return Promise.reject(new DOMException("Aborted", "AbortError"));
        }
        if (url.includes("/api/auth/refresh")) {
          // The refresh round-trip consumes the caller's remaining budget.
          ctrl.abort(new DOMException("TimeoutError", "TimeoutError"));
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url.includes("/api/calendar/places")) {
          placesAttempts += 1;
          // First (pre-refresh) attempt → 401; the retry → 200.
          return Promise.resolve(
            placesAttempts === 1
              ? new Response("", { status: 401 })
              : new Response(JSON.stringify({ places: [] }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    const res = await authFetch("/api/calendar/places?q=san", {
      signal: ctrl.signal,
    });

    // The retry must succeed (pre-fix it threw AbortError → fetchPlaces ⇒ []).
    expect(res.status).toBe(200);
    expect(placesAttempts).toBe(2);
    // The retry (last places call) must NOT have used the aborted caller signal.
    const lastPlaces = [...calls].reverse().find((c) => c.url.includes("/api/calendar/places"));
    expect(lastPlaces?.aborted).toBe(false);
  });

  it("does not retry the auth LIFECYCLE URLs (login/refresh/callback/logout short-circuit)", async () => {
    let refreshHit = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/auth/refresh")) {
          refreshHit = true;
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("", { status: 401 }));
      }),
    );

    const res = await authFetch("/api/auth/login");
    expect(res.status).toBe(401);
    expect(refreshHit).toBe(false); // a bad login's 401 must not trigger a refresh
  });
});

describe("authFetch — refresh scope is precise (NO_REFRESH_PATHS)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // F7: the old broad `url.includes("/api/auth/")` skipped refresh for ALL auth
  // paths. /api/auth/me and /api/auth/change-password are NOT lifecycle routes —
  // a merely-expired access token there must refresh+retry, not read as "logged
  // out". These two used to wrongly short-circuit to the raw 401.
  it.each([
    "/api/auth/me",
    "/api/auth/change-password",
  ])("refreshes + retries on a 401 from %s", async (path) => {
    let refreshHit = false;
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/auth/refresh")) {
          refreshHit = true;
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        if (url.includes(path)) {
          attempts += 1;
          return Promise.resolve(
            attempts === 1
              ? new Response("", { status: 401 })
              : new Response(JSON.stringify({ ok: true }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    );

    const res = await authFetch(path, { method: "POST" });
    expect(refreshHit).toBe(true);
    expect(attempts).toBe(2); // initial 401 + one post-refresh retry
    expect(res.status).toBe(200);
  });
});

describe("authFetch — 403 PASSWORD_CHANGE_REQUIRED routes to remediation (F8)", () => {
  const realLocation = window.location;

  function stubLocation(pathname: string) {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...realLocation, pathname, assign },
    });
    return assign;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: realLocation,
    });
  });

  it("redirects to /change-password on a 403 with code PASSWORD_CHANGE_REQUIRED", async () => {
    const assign = stubLocation("/files");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "PASSWORD_CHANGE_REQUIRED" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    const res = await authFetch("/api/files/list");
    // The caller's body must remain readable (we clone for the redirect probe).
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "PASSWORD_CHANGE_REQUIRED",
    });
    // The redirect probe runs on a microtask; flush before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(assign).toHaveBeenCalledWith("/change-password");
  });

  it("does NOT redirect when already on /change-password (no loop)", async () => {
    const assign = stubLocation("/change-password");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "PASSWORD_CHANGE_REQUIRED" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    await authFetch("/api/auth/change-password", { method: "POST" });
    await Promise.resolve();
    await Promise.resolve();
    expect(assign).not.toHaveBeenCalled();
  });

  it("does NOT redirect on an unrelated 403 (e.g. RBAC denial)", async () => {
    const assign = stubLocation("/files");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "FORBIDDEN" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    const res = await authFetch("/api/admin/thing");
    expect(res.status).toBe(403);
    await Promise.resolve();
    await Promise.resolve();
    expect(assign).not.toHaveBeenCalled();
  });
});
