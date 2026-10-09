import { describe, expect, it, vi } from "vitest";
import analyzeData from "../../../src/handlers/data/analyze-data.js";
import type { ToolContext } from "../../../src/types.js";

function context(response = new Response(JSON.stringify({ output: { total: 30 }, artifacts: [], media: [] }))) {
  const post = vi.fn().mockResolvedValue(response);
  return { post, ctx: { userId: "alice", ncToken: "token", http: { nextcloud: { post } } } as unknown as ToolContext };
}
describe("analyze_data", () => {
  it("dispatches JSON/code/source references, with caller identity, and reads a native Response", async () => {
    const { ctx, post } = context();
    const args = { code: "output=sum(inputs['x'])", inputs: { x: [10, 20] }, sources: [{ item_id: "attachment1" }] };
    const result = await analyzeData.handler(args, ctx);
    expect(result).toMatchObject({ ok: true, data: { output: { total: 30 } } });
    expect(post).toHaveBeenCalledWith("/analyze", args, { headers: { "X-Nextcloud-User": "alice", "X-Nextcloud-Token": "token" } });
    expect(analyzeData.requiresWrite).toBe(true);
    expect(analyzeData.requiresConfirmation).toBe(false);
  });
  it("refuses anonymous or empty-code calls before dispatch", async () => {
    const { ctx, post } = context();
    expect((await analyzeData.handler({ code: "" }, ctx)).ok).toBe(false);
    expect((await analyzeData.handler({ code: "output=1" }, { ...ctx, userId: "" })).ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it("relays precise sandbox failures and refuses malformed success", async () => {
    const unavailable = context(new Response(JSON.stringify({ error: "not configured" }), { status: 503 }));
    expect(await analyzeData.handler({ code: "output=1" }, unavailable.ctx)).toMatchObject({ ok: false, error: { code: "ANALYSIS_UNAVAILABLE", message: "not configured" } });
    expect((await analyzeData.handler({ code: "output=1" }, context(new Response("html")).ctx)).ok).toBe(false);
  });
});
