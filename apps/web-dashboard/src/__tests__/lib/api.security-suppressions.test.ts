/**
 * WARP-2980 (ADR-059 P5 PR-B) — the dashboard's client for routes 32–34
 * (expected activity), and the hook the card reads through.
 *
 * Each helper goes through `securityFetch` (authFetch: the session cookie, a
 * refresh on an expired token) and throws a typed error with the server's
 * `error.code` and the status, so the card can say "couldn't load" rather
 * than "nothing is marked as expected". The hook hands that error back with
 * `list: null` — never an empty list.
 */
import { createElement, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { SECURITY_SUPPRESSIONS_PATH, createSecuritySuppression, getSecuritySuppressions, removeSecuritySuppression } from "@/lib/api";
import { useSecuritySuppressions } from "@/lib/hooks/useSecurity";
import type { SecuritySuppressionCreateBody, SecuritySuppressionList } from "@/lib/types";

const LIST: SecuritySuppressionList = { suppressions: [], canManage: true, limit: 100 };

const BODY: SecuritySuppressionCreateBody = {
  target: { kind: "camera", camera: "back" },
  label: "car",
  days: "every_day",
  hourFrom: 22,
  hourCount: 2,
  codes: ["unusual_volume"],
  reason: "Deliveries",
  expiresInDays: 30,
};

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), headers: new Headers() };
}

function lastCall(): [string, RequestInit] {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
}

beforeEach(() => mockFetch.mockReset());

describe("routes 32–34 client", () => {
  it("route 32: GETs the list with the session cookie", async () => {
    mockFetch.mockResolvedValueOnce(res(200, LIST));
    await expect(getSecuritySuppressions()).resolves.toEqual(LIST);
    const [url, init] = lastCall();
    expect(url).toBe(SECURITY_SUPPRESSIONS_PATH);
    expect(url).toBe("/api/security/suppressions");
    expect(init).toMatchObject({ credentials: "same-origin" });
    expect(init.method ?? "GET").toBe("GET");
  });

  it("route 33: POSTs exactly the body, as JSON", async () => {
    mockFetch.mockResolvedValueOnce(res(201, { suppression: { id: "sup-1" } }));
    await createSecuritySuppression(BODY);
    const [url, init] = lastCall();
    expect(url).toBe("/api/security/suppressions");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(BODY);
  });

  it("route 34: POSTs {} to the row's remove path, id encoded", async () => {
    mockFetch.mockResolvedValueOnce(res(200, { changed: true }));
    await expect(removeSecuritySuppression("sup/1")).resolves.toEqual({ changed: true });
    const [url, init] = lastCall();
    expect(url).toBe("/api/security/suppressions/sup%2F1/remove");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it.each([
    [503, "SUPPRESSIONS_UNAVAILABLE"],
    [409, "SUPPRESSION_LIMIT"],
    [404, "SUPPRESSION_NOT_FOUND"],
  ])("a %i carries the server's code", async (status, code) => {
    mockFetch.mockResolvedValueOnce(res(status, { error: { code, message: "x" } }));
    await expect(getSecuritySuppressions()).rejects.toMatchObject({ code, status });
  });
});

describe("useSecuritySuppressions", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false } }, children);

  it("hands back the list", async () => {
    mockFetch.mockResolvedValue(res(200, LIST));
    const { result } = renderHook(() => useSecuritySuppressions(), { wrapper });
    await waitFor(() => expect(result.current.list).toEqual(LIST));
    expect(result.current.error).toBeUndefined();
  });

  it("a failed read is an error with no list — never an empty one", async () => {
    mockFetch.mockResolvedValue(res(503, { error: { code: "SUPPRESSIONS_UNAVAILABLE", message: "x" } }));
    const { result } = renderHook(() => useSecuritySuppressions(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toMatchObject({ code: "SUPPRESSIONS_UNAVAILABLE", status: 503 });
    expect(result.current.list).toBeNull();
  });
});
