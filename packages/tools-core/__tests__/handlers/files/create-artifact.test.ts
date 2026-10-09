import { describe, expect, it, vi } from "vitest";
import tool from "../../../src/handlers/files/create-artifact.js";
import type { ToolContext } from "../../../src/types.js";

function context(status = 200) {
  const post = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ uploaded: [{ path: "/Documents/demo.html" }] }), { status })));
  return { post, ctx: { userId: "alice", ncToken: "caller-token", http: { nextcloud: { post } } } as unknown as ToolContext };
}
describe("create_artifact", () => {
  it("atomically creates actor-owned HTML and uses the actual saved path for its preview", async () => {
    const { ctx, post } = context();
    const result = await tool.handler({ path: "/demo.html", content: "<button>Demo</button>" }, ctx);
    expect(post).toHaveBeenCalledWith("/upload", { dir: "/", filename: "demo.html", contentBase64: Buffer.from("<button>Demo</button>").toString("base64"), createOnly: true }, { headers: { "X-Nextcloud-User": "alice", "X-Nextcloud-Token": "caller-token" } });
    expect(result.ok && result.data).toMatchObject({ path: "/Documents/demo.html", media: { kind: "artifact", downloadUrl: "/api/files/download?path=%2FDocuments%2Fdemo.html" } });
  });
  it.each(["/../a.html", "/%252e%252e/a.html", "/a.txt", "/a.html/"])("refuses invalid path %s before any request", async (path) => {
    const { ctx, post } = context();
    expect((await tool.handler({ path, content: "hello" }, ctx)).ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it("refuses oversized UTF-8 content and unauthenticated calls", async () => {
    const { ctx, post } = context();
    expect((await tool.handler({ path: "/a.html", content: "é".repeat(100_000) }, ctx)).ok).toBe(false);
    expect((await tool.handler({ path: "/a.html", content: "hi" }, { ...ctx, ncToken: undefined })).ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it.each([409, 500])("never returns a preview for a failed write (%s)", async (status) => {
    const { ctx } = context(status);
    const result = await tool.handler({ path: "/a.html", content: "hi" }, ctx);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("data.media");
  });
  it.each([{}, { uploaded: [{ path: "/../escape.html" }] }, { uploaded: [{ path: "/other.txt" }] }])("never invents a saved file from malformed upload metadata", async (payload) => {
    const { ctx, post } = context();
    post.mockResolvedValue(new Response(JSON.stringify(payload)));
    const result = await tool.handler({ path: "/a.html", content: "hi" }, ctx);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("data.media");
  });
});
