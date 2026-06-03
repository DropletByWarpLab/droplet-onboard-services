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

  it("does not retry /api/auth/* URLs (they short-circuit to the raw 401)", async () => {
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

    const res = await authFetch("/api/auth/me");
    expect(res.status).toBe(401);
    expect(refreshHit).toBe(false); // never attempted a refresh/retry for an auth URL
  });
});
