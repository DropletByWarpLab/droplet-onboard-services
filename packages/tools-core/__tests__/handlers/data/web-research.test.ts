import { describe, it, expect, vi } from "vitest";
import webSearch from "../../../src/handlers/data/web-search.js";
import webFetch from "../../../src/handlers/data/web-fetch.js";
import type { ToolContext } from "../../../src/types.js";

function context(body: unknown, status = 200) {
  const post = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const ctx = { http: { orchestrator: { post } }, signal: new AbortController().signal } as unknown as ToolContext;
  return { post, ctx };
}
describe("public web tool handlers", () => {
  it("search forwards normalized query and preserves citation metadata", async () => {
    const payload = { results: [{ url: "https://example.com", title: "Source", snippet: "Evidence", sourceId: "abc" }], retrievedAt: "now", trust: "untrusted_web" };
    const { post, ctx } = context(payload);
    expect(await webSearch.handler({ query: "  public facts  ", count: 3 }, ctx)).toEqual({ ok: true, data: { type: "web_search", ...payload } });
    expect(post).toHaveBeenCalledWith("/api/web/search", { query: "public facts", count: 3 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("fetch preserves explicit truncation and source URL", async () => {
    const payload = { url: "https://example.com", text: "content", truncated: true };
    const { ctx } = context(payload);
    expect(await webFetch.handler({ url: payload.url }, ctx)).toEqual({ ok: true, data: { type: "web_fetch", ...payload } });
  });
  it.each([{ query: "" }, { query: "x".repeat(601) }, { query: "word ".repeat(76) }, { query: "hello", count: true }, { query: "hello", count: 11 }])("invalid search args never dispatch", async (args) => {
    const { post, ctx } = context({});
    expect((await webSearch.handler(args, ctx)).ok).toBe(false); expect(post).not.toHaveBeenCalled();
  });
  it.each([{ url: "http://example.com" }, { url: "https://example.com:22" }, { url: "https://user:pass@example.com" }, { url: "https://example.com", maxBytes: true }])("invalid fetch args never dispatch", async (args) => {
    const { post, ctx } = context({});
    expect((await webFetch.handler(args, ctx)).ok).toBe(false); expect(post).not.toHaveBeenCalled();
  });
  it.each([[451, "egress_disabled", "EGRESS_DISABLED"], [503, "search_not_configured", "SEARCH_NOT_CONFIGURED"], [400, "blocked_destination", "BLOCKED_DESTINATION"], [429, "rate_limited", "RATE_LIMITED"]])("structured error %s", async (status, code, expected) => {
    const { ctx } = context({ error: code }, Number(status));
    const result = await webSearch.handler({ query: "public" }, ctx);
    expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe(expected);
  });
  it("transport failure is explicit", async () => {
    const { ctx, post } = context({}); post.mockRejectedValue(new Error("offline"));
    const result = await webFetch.handler({ url: "https://example.com" }, ctx);
    expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe("WEB_UNAVAILABLE");
  });
});
