/**
 * The typed-error transport behind `@/lib/api`'s notification and
 * active-department routes: `authFetch` (an expired access token is refreshed
 * and the request retried), a 20 s bound on every request, and failures a
 * caller can tell apart.
 *
 * `api.notifications.test.ts` pins each route's own path, query and body, and
 * the page and hook tests replace these helpers, so nothing else sees what the
 * transport does to EVERY request and EVERY failure: a request is bounded; a
 * write carries a JSON body under a JSON content type; a refusal throws the
 * server's `error.code` with the status, the whole body and the request id; a
 * refusal whose body is not that envelope still carries its status; and a
 * request that never answered is `TIMEOUT` or `NETWORK_ERROR` with status 0 —
 * which is how a caller tells "the box said no" from "the box never answered".
 *
 * Pinned at the transport's one collaborator, `authFetch`, through the exported
 * callers that go through it: what the transport hands `authFetch` is what is
 * asserted, so the cookie, refresh and retry behaviour of the real `authFetch`
 * is not in play here (`api.notifications.test.ts` runs the real one for that).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  ackAllNotifications,
  ackNotification,
  getActiveDepartment,
  getNotifications,
  getUnreadNotificationCount,
  putActiveDepartment,
} from "@/lib/api";
import { authFetch } from "@/lib/auth";
import type { TypedError } from "@/lib/hooks/apiFetch";

vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

/**
 * The bound every request is given. Written out here rather than imported from
 * the transport: it is the number that is pinned.
 */
const BOUND_MS = 20_000;

function res(json: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

/** A failure whose body is not JSON at all (a proxy's error page). */
function notJson(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token '<'")),
  } as unknown as Response;
}

/** A request that never answers until its signal aborts. */
function hangsUntilAborted(_url?: string, init?: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
}

/**
 * Drive `AbortSignal.timeout` from the (faked) global clock.
 *
 * Vitest 4's jsdom environment hands tests Node's `AbortSignal` — so `fetch`
 * and `Request` accept it — and Node's `AbortSignal.timeout` runs on an
 * internal timer that `vi.useFakeTimers()` does not reach, so advancing the
 * clock would never fire the 20 s bound. Rebuild it on `setTimeout`, which the
 * fakes do drive; the bound the code asks for is still the one that fires.
 * Call after `vi.useFakeTimers()`; restore the returned spy when done.
 */
function timeoutOnFakeClock() {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
    return ctrl.signal;
  });
}

/** The one request the transport handed `authFetch`: [path, init]. */
function onlyRequest(): [string, RequestInit] {
  expect(authFetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = authFetchMock.mock.calls[0]!;
  return [path, init ?? {}];
}

/** What the call rejected with; the test fails if it resolved. */
async function rejection(call: Promise<unknown>): Promise<TypedError> {
  try {
    await call;
  } catch (err) {
    return err as TypedError;
  }
  throw new Error("expected the call to reject");
}

beforeEach(() => {
  authFetchMock.mockReset();
  authFetchMock.mockResolvedValue(res({}));
});

/** Every exported caller that goes through the transport. */
const CALLERS = [
  ["getNotifications", () => getNotifications()],
  ["getUnreadNotificationCount", () => getUnreadNotificationCount()],
  ["ackNotification", () => ackNotification("clx1")],
  ["ackAllNotifications", () => ackAllNotifications(["clx1"])],
  ["getActiveDepartment", () => getActiveDepartment()],
  ["putActiveDepartment", () => putActiveDepartment(null)],
] as const;

describe("the typed-error transport — the request it makes", () => {
  it.each(CALLERS)("%s: the request is bounded — it carries a timeout signal", async (_name, call) => {
    await call();
    expect(onlyRequest()[1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["getNotifications", () => getNotifications({ limit: 20 }), "/api/notifications?limit=20"],
    ["getUnreadNotificationCount", () => getUnreadNotificationCount(), "/api/notifications/unread-count"],
    ["getActiveDepartment", () => getActiveDepartment(), "/api/me/active-department"],
  ] as const)("%s: a read is a GET of the path it was given, with no body", async (_name, call, path) => {
    await call();
    const [url, init] = onlyRequest();
    expect(url).toBe(path);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it.each([
    ["ackNotification with a via", () => ackNotification("clx1", { via: "opened" }), "/api/notifications/clx1/ack", "POST", { via: "opened" }],
    ["ackNotification without one", () => ackNotification("clx1"), "/api/notifications/clx1/ack", "POST", {}],
    ["ackAllNotifications", () => ackAllNotifications(["clx1", "clx2"]), "/api/notifications/ack-all", "POST", { ids: ["clx1", "clx2"] }],
    ["putActiveDepartment", () => putActiveDepartment("dept-1"), "/api/me/active-department", "PUT", { departmentId: "dept-1" }],
    ["putActiveDepartment(null)", () => putActiveDepartment(null), "/api/me/active-department", "PUT", { departmentId: null }],
  ] as const)("%s: a write is the method it was given, with a JSON body and a JSON content type", async (_name, call, path, method, body) => {
    await call();
    const [url, init] = onlyRequest();
    expect(url).toBe(path);
    expect(init.method).toBe(method);
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("a 2xx answer resolves with the parsed body, untouched", async () => {
    const page = { notifications: [], unread: 2, nextCursor: null };
    authFetchMock.mockResolvedValue(res(page));
    await expect(getNotifications()).resolves.toEqual(page);
  });
});

describe("the typed-error transport — a refusal is typed, so a caller can tell it from an outage", () => {
  it("throws the server's error.code with the status, the whole body and the request id — never a plain Error", async () => {
    const body = { error: { code: "DEPARTMENT_NOT_AVAILABLE", message: "raw server text" } };
    authFetchMock.mockResolvedValue(res(body, 404, { "x-request-id": "rid-1" }));
    const err = await rejection(putActiveDepartment("dept-1"));
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("DEPARTMENT_NOT_AVAILABLE");
    expect(err.status).toBe(404);
    expect(err.requestId).toBe("rid-1");
    expect(err.body).toEqual(body);
  });

  it.each([
    ["a flat 401 (the session really ended — authFetch already tried to refresh)", 401, { error: "Missing or invalid authentication" }],
    ["a flat 403 (a role refusal)", 403, { error: "Forbidden: role not permitted" }],
    ["a flat 404 (a disabled module)", 404, { error: "module_disabled", module: "cameras" }],
  ])("%s has the status and the body, and no code", async (_what, status, body) => {
    authFetchMock.mockResolvedValue(res(body, status));
    const err = await rejection(getUnreadNotificationCount());
    expect(err.status).toBe(status);
    expect(err.code).toBeUndefined();
    expect(err.body).toEqual(body);
  });

  it.each([
    ["a body that is not JSON (a proxy's error page)", () => notJson(502), 502],
    ["a JSON body with no error in it", () => res({ message: "Internal Server Error" }, 500), 500],
  ] as const)("%s is UNKNOWN, with its status", async (_what, response, status) => {
    authFetchMock.mockResolvedValue(response());
    const err = await rejection(getNotifications());
    expect(err.code).toBe("UNKNOWN");
    expect(err.status).toBe(status);
    expect(err.message).toBe(`HTTP ${status}`);
  });
});

describe("the typed-error transport — a request that never answered", () => {
  it("is NETWORK_ERROR with status 0, not an HTTP code", async () => {
    authFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await rejection(getUnreadNotificationCount());
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.status).toBe(0);
  });

  it("is given up after 20 s — TIMEOUT, status 0 — never left pending", async () => {
    vi.useFakeTimers();
    const timeoutSpy = timeoutOnFakeClock();
    try {
      authFetchMock.mockImplementation(hangsUntilAborted);
      const outcome = rejection(getUnreadNotificationCount());
      let settled = false;
      const markSettled = () => {
        settled = true;
      };
      void outcome.then(markSettled, markSettled);

      await vi.advanceTimersByTimeAsync(BOUND_MS - 1);
      expect(settled, "still waiting 1 ms before the bound").toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled, "given up at the bound").toBe(true);
      const err = await outcome;
      expect(err.code).toBe("TIMEOUT");
      expect(err.status).toBe(0);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
