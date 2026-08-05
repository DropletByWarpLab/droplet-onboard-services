// @vitest-environment jsdom
/**
 * WARP-1726 (second pass) — both auth single-flights must be BOUNDED.
 *
 * `attemptRefresh()` and `confirmSessionDead()` each memoise their in-flight
 * promise so an auth storm costs one round trip instead of one per pending
 * request. That sharing is only safe if the promise is guaranteed to settle: a
 * box that accepts the TCP connection and then goes quiet (mid-reboot, a wedged
 * orchestrator, a captive portal swallowing the request) leaves a bare `fetch`
 * pending indefinitely, `.finally()` never runs, the slot is never released —
 * and from then on EVERY `authFetch` that 401s awaits the same dead promise.
 * The tab stops making progress until the browser's own transport timeout,
 * which is minutes.
 *
 * So the contract pinned here is two-part, and the second half matters as much
 * as the first: the requests are bounded by a timeout signal, AND an abort is
 * classified as "we learned nothing", never as "the session is over". A
 * timeout that logged the user out would just be a slower version of the
 * false-logout bug this ticket exists to remove.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { authFetch } from "@/lib/auth";

const USER_KEY = "droplet-auth-user";
const CACHED_USER = JSON.stringify({ id: "u-1", username: "alice", displayName: "Alice" });

/**
 * The bound both single-flights are given (AUTH_SINGLE_FLIGHT_TIMEOUT_MS in
 * lib/auth.tsx). Asserted literally so retuning it is a deliberate act with a
 * matching test edit, rather than a silent drift back toward "unbounded".
 */
const EXPECTED_BOUND_MS = 6_000;

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

const abortError = () => new DOMException("The operation was aborted.", "AbortError");
const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError");

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Call = { url: string; init?: RequestInit };

/**
 * A fetch stub that models a real fetch's abort semantics: a route may return a
 * promise that NEVER settles on its own, and the only thing that can settle it
 * is its own `init.signal` firing. That is exactly the box-goes-quiet failure,
 * and it is what makes the un-bounded version of this code wedge.
 */
function stubFetch(routes: Record<string, (init?: RequestInit) => Response | "hang">) {
  const calls: Call[] = [];
  const impl = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url] ?? (() => new Response("", { status: 401 }));
    let result: Response | "hang";
    try {
      result = route(init);
    } catch (err) {
      // Real fetch signals a network/abort failure by REJECTING, never by
      // throwing synchronously — a route that throws models that failure.
      return Promise.reject(err);
    }
    if (result !== "hang") return Promise.resolve(result);
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // unbounded: this promise is now immortal
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", () => reject(abortError()));
    });
  });
  vi.stubGlobal("fetch", impl);
  return {
    calls,
    countOf: (url: string) => calls.filter((c) => c.url === url).length,
    lastInit: (url: string) => [...calls].reverse().find((c) => c.url === url)?.init,
  };
}

/**
 * Replace `AbortSignal.timeout` with a controller the test owns, so the real
 * 6s bound can be driven to completion in microseconds. Returns the controller
 * plus every duration the code under test asked for.
 */
function captureTimeoutSignal() {
  const ctrl = new AbortController();
  const requested: number[] = [];
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    requested.push(ms);
    return ctrl.signal;
  });
  return { ctrl, requested };
}

/**
 * Resolve to "settled" if `p` finishes promptly, "wedged" if it does not. The
 * un-bounded code never settles, and a bare `await` would surface that as an
 * opaque suite timeout instead of a readable assertion.
 */
async function settlesPromptly(p: Promise<unknown>): Promise<"settled" | "wedged"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"wedged">((resolve) => setTimeout(() => resolve("wedged"), 50)),
  ]);
}

beforeEach(() => {
  localStorage.setItem(USER_KEY, CACHED_USER);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

describe("attemptRefresh — the refresh single-flight is bounded (WARP-1726)", () => {
  it("gives the refresh a timeout signal so a silent box cannot wedge the slot", async () => {
    stubLocation("/network");
    const { requested } = captureTimeoutSignal();
    const f = stubFetch({ "/api/auth/refresh": () => new Response("", { status: 503 }) });

    await authFetch("/api/network/devices");

    expect(f.lastInit("/api/auth/refresh")?.signal).toBeInstanceOf(AbortSignal);
    expect(requested).toContain(EXPECTED_BOUND_MS);
  });

  it("abandons a refresh the box never answers, and hands the caller its 401", async () => {
    const assign = stubLocation("/network", "?tab=devices");
    const { ctrl } = captureTimeoutSignal();
    stubFetch({ "/api/auth/refresh": () => "hang" });

    const pending = authFetch("/api/network/devices");
    ctrl.abort(timeoutError());

    expect(await settlesPromptly(pending)).toBe("settled");
    const res = await pending;
    // An abort is not a verdict on the session: the caller gets its original
    // 401 back and simply retries on the next poll.
    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
  });

  it("classifies an aborted refresh as transient — no probe, no logout", async () => {
    const assign = stubLocation("/network");
    const f = stubFetch({
      "/api/auth/refresh": () => {
        throw abortError();
      },
      "/api/auth/me": () => json({ id: "u-1" }, 401),
    });

    const res = await authFetch("/api/network/devices");

    expect(res.status).toBe(401);
    // Nothing was learned, so nothing is spent confirming it and nothing is torn
    // down. (If an AbortError ever stopped landing in the transient catch-all,
    // a timed-out refresh would start logging people out.)
    expect(f.countOf("/api/auth/me")).toBe(0);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
  });

  it("releases the slot after an abort, so the next 401 starts a fresh refresh", async () => {
    stubLocation("/network");
    const { ctrl } = captureTimeoutSignal();
    const f = stubFetch({ "/api/auth/refresh": () => "hang" });

    const first = authFetch("/api/network/devices");
    ctrl.abort(timeoutError());
    await first;

    // A second, independent controller for the follow-up attempt.
    vi.restoreAllMocks();
    const second = captureTimeoutSignal();
    const followUp = authFetch("/api/network/groups");
    second.ctrl.abort(timeoutError());
    await followUp;

    // Two attempts, not one shared corpse — this is the anti-wedge property.
    expect(f.countOf("/api/auth/refresh")).toBe(2);
  });
});

describe("confirmSessionDead — the probe single-flight is bounded (WARP-1726)", () => {
  it("gives the probe a timeout signal", async () => {
    stubLocation("/network");
    const { requested } = captureTimeoutSignal();
    const f = stubFetch({
      "/api/auth/refresh": () => json({ code: "SESSION_EXPIRED" }, 401),
      "/api/auth/me": () => new Response("", { status: 401 }),
    });

    await authFetch("/api/network/devices");

    expect(f.lastInit("/api/auth/me")?.signal).toBeInstanceOf(AbortSignal);
    expect(requested).toContain(EXPECTED_BOUND_MS);
  });

  it("keeps the session when the probe is aborted — an unprovable claim costs nothing", async () => {
    const assign = stubLocation("/network");
    const { ctrl } = captureTimeoutSignal();
    stubFetch({
      "/api/auth/refresh": () => json({ code: "SESSION_EXPIRED" }, 401),
      "/api/auth/me": () => "hang",
    });

    const pending = authFetch("/api/network/devices");
    ctrl.abort(timeoutError());

    expect(await settlesPromptly(pending)).toBe("settled");
    const res = await pending;
    expect(res.status).toBe(401);
    // confirmSessionDead() returns false when it cannot get a definitive
    // answer. A silent box must never be able to end a session.
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
  });

  it("releases the probe slot after an abort", async () => {
    stubLocation("/network");
    const { ctrl } = captureTimeoutSignal();
    const f = stubFetch({
      "/api/auth/refresh": () => json({ code: "SESSION_EXPIRED" }, 401),
      "/api/auth/me": () => "hang",
    });

    const first = authFetch("/api/network/devices");
    ctrl.abort(timeoutError());
    await first;

    vi.restoreAllMocks();
    const second = captureTimeoutSignal();
    const followUp = authFetch("/api/network/groups");
    second.ctrl.abort(timeoutError());
    await followUp;

    expect(f.countOf("/api/auth/me")).toBe(2);
  });
});

describe("the no-refresh-token 401 is definitive (WARP-1726)", () => {
  it("logs out on NO_REFRESH_TOKEN without spending a probe", async () => {
    const assign = stubLocation("/network", "?tab=devices");
    const f = stubFetch({
      "/api/auth/refresh": () =>
        json({ error: "No refresh token available", code: "NO_REFRESH_TOKEN" }, 401),
      "/api/auth/me": () => new Response("", { status: 401 }),
    });

    const res = await authFetch("/api/network/devices");

    expect(res.status).toBe(401);
    // The server said the browser holds no refresh credential at all. There is
    // no session left to rescue, so re-asking /api/auth/me can only echo it.
    expect(f.countOf("/api/auth/me")).toBe(0);
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/network?tab=devices")}`,
    );
  });

  it("still probes on an UNLABELLED 401 — the fallback must not weaken", async () => {
    const assign = stubLocation("/network");
    const f = stubFetch({
      "/api/auth/refresh": () => json({ error: "No refresh token available" }, 401),
      "/api/auth/me": () => json({ id: "u-1", username: "alice" }, 200),
    });

    const res = await authFetch("/api/network/devices");

    expect(res.status).toBe(401);
    // Unlabelled means "unproven": the probe runs, says the session is alive,
    // and the user keeps it. Only the explicit code earns the short-circuit.
    expect(f.countOf("/api/auth/me")).toBe(1);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
  });

  it("does not treat a NON-401 carrying the code as definitive", async () => {
    const assign = stubLocation("/network");
    const f = stubFetch({
      // A 503 body that happens to echo the code is still just an unwell box.
      "/api/auth/refresh": () => json({ code: "NO_REFRESH_TOKEN" }, 503),
      "/api/auth/me": () => new Response("", { status: 401 }),
    });

    await authFetch("/api/network/devices");

    expect(f.countOf("/api/auth/me")).toBe(0);
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(USER_KEY)).toBe(CACHED_USER);
  });
});

describe("both single-flights are traceable (WARP-1726)", () => {
  // Every other call through authFetch carries x-request-id, so an auth
  // incident was the one thing that could not be followed end-to-end in the
  // orchestrator logs.
  it("tags the refresh and the probe with an x-request-id", async () => {
    stubLocation("/network");
    const f = stubFetch({
      "/api/auth/refresh": () => json({ code: "SESSION_EXPIRED" }, 401),
      "/api/auth/me": () => new Response("", { status: 401 }),
    });

    await authFetch("/api/network/devices");

    const headerOf = (url: string) =>
      (f.lastInit(url)?.headers as Record<string, string> | undefined)?.["x-request-id"];
    expect(headerOf("/api/auth/refresh")).toEqual(expect.any(String));
    expect(headerOf("/api/auth/me")).toEqual(expect.any(String));
    expect(headerOf("/api/auth/refresh")).not.toEqual(headerOf("/api/auth/me"));
  });
});
