/**
 * `signInEndsAtOf` / `getSignInEndsAt` — the LATEST a sign-in can last, from
 * `session.endsAt` of `/api/auth/me`.
 *
 * `fetch` is the only thing mocked, so authFetch and the typed-error transport
 * run for real. Pinned: `session.endsAt` is taken only when it is a real time
 * (absent, null or anything else is null — never a time the box did not give);
 * it is read from `/api/auth/me`, not from `useAuth().user` (a login response
 * carries no `session`, and a cached profile can carry an old one); and that
 * read is bounded by a timeout.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { getSignInEndsAt, signInEndsAtOf } from "@/lib/api";

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: new Headers() };
}

function lastCall(): [string, RequestInit] {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("signInEndsAtOf", () => {
  it("takes a real time", () => {
    expect(signInEndsAtOf({ session: { endsAt: "2026-09-25T22:00:00.000Z" } })).toBe("2026-09-25T22:00:00.000Z");
  });

  it.each([
    ["no session (a login response, an older orchestrator)", { id: "u1" }],
    ["session null (the box can't tell)", { session: null }],
    ["a number", { session: { endsAt: 123 } }],
    ["not a time", { session: { endsAt: "soon" } }],
    ["not an object", "session"],
    ["nothing", null],
  ])("null for %s", (_why, body) => {
    expect(signInEndsAtOf(body)).toBeNull();
  });
});

describe("getSignInEndsAt", () => {
  it("reads /api/auth/me with a timeout", async () => {
    mockFetch.mockResolvedValue(reply(200, { id: "u1", session: { endsAt: "2026-09-25T22:00:00.000Z" } }));
    await expect(getSignInEndsAt()).resolves.toBe("2026-09-25T22:00:00.000Z");
    expect(lastCall()[0]).toBe("/api/auth/me");
    expect(lastCall()[1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a body with no session", { id: "u1" }],
    ["an end that is not a time", { id: "u1", session: { endsAt: "soon" } }],
  ])("is null for %s — the same reading as signInEndsAtOf", async (_why, body) => {
    mockFetch.mockResolvedValue(reply(200, body));
    await expect(getSignInEndsAt()).resolves.toBeNull();
  });
});
