// Data layer for comment edit/delete, reactions, watchers and the merged
// activity timeline (WARP-3519): the multi-page timeline fetcher and the
// request shapes of the new mutations.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { PmRequestError, pmActions, useTimeline, useWatchers } from "./usePm";
import type { PmTimelineEntry, PmTimelineRefs } from "./types";

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let handler: Handler = () => Promise.reject(new Error("no handler set"));
const calls: { url: string; method: string; body?: unknown }[] = [];

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return handler(url, init);
  }),
}));

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
const fail = (status: number, error: string) =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) } as Response);

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

const EMPTY_REFS: PmTimelineRefs = { states: {}, labels: {}, workItems: {} };

function activityEntry(n: number): PmTimelineEntry {
  return {
    type: "activity",
    id: `a${n}`,
    at: "2026-06-22T10:00:00.000Z",
    activity: {
      id: `a${n}`,
      workItemId: "w1",
      actorId: "u1",
      verb: "created",
      field: null,
      oldValue: null,
      newValue: null,
      createdAt: "2026-06-22T10:00:00.000Z",
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  handler = () => Promise.reject(new Error("no handler set"));
});

describe("useTimeline", () => {
  it("reads one page of /timeline with limit=500 and exposes entries, refs and total", async () => {
    const refs: PmTimelineRefs = { ...EMPTY_REFS, states: { s1: "Todo" } };
    handler = () => ok({ timeline: [activityEntry(1), activityEntry(2)], refs, nextCursor: null, total: 2 });

    const { result } = renderHook(() => useTimeline("w1"), { wrapper });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.entries).toBeUndefined();
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.total).toBe(2);
    expect(result.current.refs).toEqual(refs);
    expect(result.current.truncated).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(["/api/pm/work-items/w1/timeline?limit=500"]);
  });

  it("follows nextCursor until it is null, in order, merging the per-page refs", async () => {
    handler = (url) =>
      url.includes("cursor=")
        ? ok({
            timeline: [activityEntry(3)],
            refs: { ...EMPTY_REFS, states: { s2: "Done" } },
            nextCursor: null,
            total: 3,
          })
        : ok({
            timeline: [activityEntry(1), activityEntry(2)],
            refs: { ...EMPTY_REFS, states: { s1: "Todo" }, workItems: { w2: { key: "INBOX-2", name: "Other" } } },
            nextCursor: "page 2/==",
            total: 3,
          });

    const { result } = renderHook(() => useTimeline("w1"), { wrapper });

    await waitFor(() => expect(result.current.entries).toHaveLength(3));
    expect(result.current.entries?.map((e) => e.id)).toEqual(["a1", "a2", "a3"]);
    expect(result.current.refs.states).toEqual({ s1: "Todo", s2: "Done" });
    expect(result.current.refs.workItems).toEqual({ w2: { key: "INBOX-2", name: "Other" } });
    expect(result.current.truncated).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/pm/work-items/w1/timeline?limit=500",
      `/api/pm/work-items/w1/timeline?limit=500&cursor=${encodeURIComponent("page 2/==")}`,
    ]);
  });

  it("stops after 20 pages and says so, rather than looping on a server that never ends", async () => {
    let n = 0;
    handler = () => ok({ timeline: [activityEntry(++n)], refs: EMPTY_REFS, nextCursor: `c${n}`, total: 9000 });

    const { result } = renderHook(() => useTimeline("w1"), { wrapper });

    await waitFor(() => expect(result.current.entries).toHaveLength(20));
    expect(calls).toHaveLength(20);
    expect(result.current.truncated).toBe(true);
    expect(result.current.total).toBe(9000);
  });

  it("surfaces a failed first page as an error with no entries", async () => {
    handler = () => fail(500, "boom");

    const { result } = renderHook(() => useTimeline("w1"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(PmRequestError));
    expect((result.current.error as PmRequestError).status).toBe(500);
    expect(result.current.entries).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("treats a failure on a LATER page as a failure of the whole read (no half timeline)", async () => {
    handler = (url) =>
      url.includes("cursor=")
        ? fail(503, "unavailable")
        : ok({ timeline: [activityEntry(1)], refs: EMPTY_REFS, nextCursor: "next", total: 2 });

    const { result } = renderHook(() => useTimeline("w1"), { wrapper });

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.entries).toBeUndefined();
  });

  it("does nothing without a work item id", () => {
    const { result } = renderHook(() => useTimeline(null), { wrapper });
    expect(calls).toHaveLength(0);
    expect(result.current.entries).toBeUndefined();
  });
});

describe("useWatchers", () => {
  it("reads /watchers", async () => {
    const watchers = [{ userId: "u1", reason: "ASSIGNEE", createdAt: "2026-06-22T10:00:00.000Z" }];
    handler = () => ok({ watchers });

    const { result } = renderHook(() => useWatchers("w1"), { wrapper });

    await waitFor(() => expect(result.current.watchers).toEqual(watchers));
    expect(calls.map((c) => c.url)).toEqual(["/api/pm/work-items/w1/watchers"]);
  });
});

describe("pmActions — collaboration requests", () => {
  beforeEach(() => {
    handler = () => ok({});
  });

  it("editComment PATCHes /api/pm/comments/:id with { comment_html }", async () => {
    await pmActions().editComment("c1", "<p>new</p>");
    expect(calls).toEqual([{ url: "/api/pm/comments/c1", method: "PATCH", body: { comment_html: "<p>new</p>" } }]);
  });

  it("deleteComment DELETEs /api/pm/comments/:id with no body", async () => {
    await pmActions().deleteComment("c1");
    expect(calls).toEqual([{ url: "/api/pm/comments/c1", method: "DELETE", body: undefined }]);
  });

  it("addReaction POSTs { emoji } to /reactions", async () => {
    await pmActions().addReaction("c1", "\u{1F44D}");
    expect(calls).toEqual([
      { url: "/api/pm/comments/c1/reactions", method: "POST", body: { emoji: "\u{1F44D}" } },
    ]);
  });

  it("removeReaction DELETEs /reactions with the emoji percent-encoded in the query", async () => {
    await pmActions().removeReaction("c1", "❤️");
    expect(calls).toEqual([
      {
        url: `/api/pm/comments/c1/reactions?emoji=${encodeURIComponent("❤️")}`,
        method: "DELETE",
        body: undefined,
      },
    ]);
    expect(calls[0].url).toContain("%E2%9D%A4%EF%B8%8F");
  });

  it("watch POSTs {} (self) and unwatch DELETEs, both on /watchers", async () => {
    await pmActions().watch("w1");
    await pmActions().unwatch("w1");
    expect(calls).toEqual([
      { url: "/api/pm/work-items/w1/watchers", method: "POST", body: {} },
      { url: "/api/pm/work-items/w1/watchers", method: "DELETE", body: undefined },
    ]);
  });

  it("a non-2xx answer rejects with the wire code, so the caller can tell 403 from a dead network", async () => {
    handler = () => fail(403, "comment_forbidden");
    await expect(pmActions().editComment("c1", "<p>x</p>")).rejects.toMatchObject({
      status: 403,
      code: "comment_forbidden",
    });
  });
});
