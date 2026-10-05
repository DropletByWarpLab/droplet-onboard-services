import { describe, expect, it, vi } from "vitest";
import type { HttpClient } from "@droplet/tools-core";
import { authorizeMcpSharedDriveHits } from "../src/shared-drive-access.js";

const shared = { source: "nextcloud", path: "/Droplet/flux.pdf", externalFileId: 17, snippet: "Shared PDF" };
const personal = { source: "nextcloud", path: "/private.pdf", snippet: "Personal PDF" };
const brain = { source: "brain", path: "/Droplet/note", snippet: "Private note" };

function client(response: Response | Error = Response.json({ files: [shared] })) {
  const post = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response.clone();
  });
  return { post, http: { post } as unknown as HttpClient };
}

describe("MCP shared-drive access", () => {
  it("checks current access as the caller and preserves personal and brain hits", async () => {
    const { http, post } = client();
    const result = await authorizeMcpSharedDriveHits(http, "alice", "alice-token", [personal, shared, brain]);
    expect(result).toEqual([personal, shared, brain]);
    expect(post).toHaveBeenCalledWith("/shared-drive/access", {
      files: [{ path: shared.path, externalFileId: 17 }],
    }, { headers: { "X-Nextcloud-User": "alice", "X-Nextcloud-Token": "alice-token" }, signal: expect.any(AbortSignal) });
  });

  it("does not query or expose shared results without the caller's token", async () => {
    const { http, post } = client();
    expect(await authorizeMcpSharedDriveHits(http, "alice", undefined, [shared, personal])).toEqual([personal]);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    new Response("Unauthorized", { status: 401 }),
    new Response("Unavailable", { status: 503 }),
    new Response("invalid json"),
    Response.json({ files: [] }),
    Response.json({ files: [{ path: shared.path, externalFileId: 18 }] }),
    Response.json({ files: [{ path: "/Droplet/another.pdf", externalFileId: 17 }] }),
    Response.json({ files: [{ path: shared.path, externalFileId: "17" }] }),
    new Error("network unreachable"),
  ])("denies expired, stale, unavailable or malformed shared access", async (response) => {
    const { http } = client(response);
    expect(await authorizeMcpSharedDriveHits(http, "alice", "alice-token", [shared, personal])).toEqual([personal]);
  });

  it("checks access again on the next call so a revoked credential cannot reuse a verdict", async () => {
    const { http, post } = client();
    expect(await authorizeMcpSharedDriveHits(http, "alice", "alice-token", [shared])).toEqual([shared]);
    post.mockImplementationOnce(async () => Response.json({ files: [] }));
    expect(await authorizeMcpSharedDriveHits(http, "alice", "alice-token", [shared])).toEqual([]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("batches and deduplicates shared identities at the API's 100-file limit", async () => {
    const files = Array.from({ length: 205 }, (_, i) => ({
      source: "nextcloud", path: `/Droplet/file-${i}.pdf`, externalFileId: i + 1,
    }));
    const post = vi.fn(async (_path: string, body: unknown) => Response.json(body));
    const http = { post } as unknown as HttpClient;
    const result = await authorizeMcpSharedDriveHits(http, "alice", "alice-token", [...files, files[0]!]);
    expect(result).toHaveLength(206);
    expect(post.mock.calls.map(([, body]) => (body as { files: unknown[] }).files.length)).toEqual([100, 100, 5]);
  });

  it("drops malformed or missing indexed identities without asking the API", async () => {
    const { http, post } = client();
    const hits = [
      { source: "nextcloud", path: shared.path },
      { ...shared, path: "/Droplet/../private.pdf" },
      { ...shared, externalFileId: 0 },
    ];
    expect(await authorizeMcpSharedDriveHits(http, "alice", "alice-token", hits)).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });
});
