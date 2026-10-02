/**
 * WARP-2270 — the five /api/briefings fetchers: status → value/throw mapping.
 * 404 on today is "not written yet" (null), 403 is the locked state
 * (ForbiddenError), 429 on a rewrite carries its reason and retry-after.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authFetch = vi.fn();
vi.mock("@/lib/auth", () => ({ authFetch: (...a: unknown[]) => authFetch(...a) }));

import {
  BriefingRateLimited,
  ForbiddenError,
  fetchBriefingHistory,
  fetchBriefingUnreadCount,
  fetchTodayBriefing,
  markBriefingRead,
  requestBriefingRewrite,
} from "@/app/reports/api";

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => authFetch.mockReset());

describe("briefing fetchers", () => {
  it("fetchTodayBriefing: 200 → row, 404 → null, 403 → ForbiddenError, 500 → Error", async () => {
    authFetch.mockResolvedValueOnce(reply(200, { id: "b1", status: "ready" }));
    expect(await fetchTodayBriefing()).toMatchObject({ id: "b1" });
    authFetch.mockResolvedValueOnce(reply(404, { error: "no_briefing_today" }));
    expect(await fetchTodayBriefing()).toBeNull();
    authFetch.mockResolvedValueOnce(reply(403));
    await expect(fetchTodayBriefing()).rejects.toBeInstanceOf(ForbiddenError);
    authFetch.mockResolvedValueOnce(reply(500, { error: "boom" }));
    await expect(fetchTodayBriefing()).rejects.toThrow("boom");
  });

  it("fetchBriefingHistory: unwraps items; 403 → ForbiddenError; 404 → Error", async () => {
    authFetch.mockResolvedValueOnce(reply(200, { items: [{ id: "a" }, { id: "b" }] }));
    expect((await fetchBriefingHistory(2)).map((b) => b.id)).toEqual(["a", "b"]);
    expect(authFetch).toHaveBeenLastCalledWith("/api/briefings?limit=2");
    authFetch.mockResolvedValueOnce(reply(403));
    await expect(fetchBriefingHistory()).rejects.toBeInstanceOf(ForbiddenError);
    authFetch.mockResolvedValueOnce(reply(404));
    await expect(fetchBriefingHistory()).rejects.toThrow();
  });

  it("fetchBriefingUnreadCount: 200 → total; 403 → ForbiddenError; 404 → Error", async () => {
    authFetch.mockResolvedValueOnce(reply(200, { total: 1 }));
    expect(await fetchBriefingUnreadCount()).toBe(1);
    authFetch.mockResolvedValueOnce(reply(403));
    await expect(fetchBriefingUnreadCount()).rejects.toBeInstanceOf(ForbiddenError);
    authFetch.mockResolvedValueOnce(reply(404));
    await expect(fetchBriefingUnreadCount()).rejects.toThrow();
  });

  it("markBriefingRead: POSTs to the id, 200 → readAt; 403 → ForbiddenError; 404 → Error", async () => {
    authFetch.mockResolvedValueOnce(reply(200, { readAt: "2026-09-22T08:00:00.000Z" }));
    expect(await markBriefingRead("b1")).toBe("2026-09-22T08:00:00.000Z");
    expect(authFetch).toHaveBeenLastCalledWith("/api/briefings/b1/read", { method: "POST" });
    authFetch.mockResolvedValueOnce(reply(403));
    await expect(markBriefingRead("b1")).rejects.toBeInstanceOf(ForbiddenError);
    authFetch.mockResolvedValueOnce(reply(404, { error: "not_found" }));
    await expect(markBriefingRead("b1")).rejects.toThrow("not_found");
  });

  it("requestBriefingRewrite: 202 → ack; 429 → BriefingRateLimited with reason; 403 → ForbiddenError", async () => {
    authFetch.mockResolvedValueOnce(reply(202, { briefingId: "b1", status: "pending" }));
    expect(await requestBriefingRewrite()).toEqual({ briefingId: "b1", status: "pending" });

    authFetch.mockResolvedValueOnce(reply(429, { error: "briefing_run_too_soon", retryAfterSec: 240 }));
    const tooSoon = await requestBriefingRewrite().catch((e) => e);
    expect(tooSoon).toBeInstanceOf(BriefingRateLimited);
    expect(tooSoon).toMatchObject({ reason: "briefing_run_too_soon", retryAfterSec: 240 });

    authFetch.mockResolvedValueOnce(reply(429, { error: "briefing_run_in_progress" }));
    expect(await requestBriefingRewrite().catch((e) => e)).toMatchObject({
      reason: "briefing_run_in_progress",
      retryAfterSec: null,
    });

    authFetch.mockResolvedValueOnce(reply(403));
    await expect(requestBriefingRewrite()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
