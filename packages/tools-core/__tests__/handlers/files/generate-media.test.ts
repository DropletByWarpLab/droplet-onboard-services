import { describe, expect, it, vi } from "vitest";
import { fileMediaFromPath, mediaJobMedia } from "@droplet/shared-types";
import generateMedia from "../../../src/handlers/files/generate-media.js";
import type { ToolContext } from "../../../src/types.js";

const ID = "f85e7f97-a1f6-4a14-ae6c-45d5112145ef";
const OTHER = "1d95a7a9-577c-4d35-90ee-0b8f2b6b3e88";
const INPUT = { path: "/picture.png", kind: "image", prompt: "A lighthouse", options: { seed: 123 } };
const PENDING = { id: ID, path: INPUT.path, kind: INPUT.kind, status: "running", createdAt: "2026-10-08T19:00:00.000Z", media: mediaJobMedia(ID) };
const SAVED = { ...PENDING, status: "succeeded", bytes: 1234, filename: "picture.png", mimeType: "image/png", seed: 123, engine: "sdxl", warnings: [], media: fileMediaFromPath(INPUT.path, { mimeType: "image/png", size: 1234 }) };
function context(body: unknown = PENDING, status = 202) {
  const post = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const ctx = { userId: "alice", ncToken: "nc-token", signal: new AbortController().signal, http: { nextcloud: { post, get } } } as unknown as ToolContext;
  return { ctx, post, get };
}

describe("generate_media routes and job/file boundary", () => {
  it("submits the compact local spec with actor-scoped headers and returns a pending job card", async () => {
    const { ctx, post, get } = context();
    expect(await generateMedia.handler(INPUT, ctx)).toMatchObject({ ok: true, data: { id: ID, path: INPUT.path, status: "running", media: [{ kind: "media_job", jobId: ID }] } });
    expect(post).toHaveBeenCalledExactlyOnceWith("/media", INPUT, { headers: { "X-Nextcloud-User": "alice", "X-Nextcloud-Token": "nc-token" }, signal: ctx.signal });
    expect(get).not.toHaveBeenCalled(); expect(generateMedia.requiresWrite).toBe(true); expect(generateMedia.requiresConfirmation).toBe(false);
    expect(JSON.stringify(generateMedia.inputSchema).length + generateMedia.description.length).toBeLessThan(2000);
  });
  it("strips dispatch-only keys before a create request", async () => {
    const { ctx, post } = context(); await generateMedia.handler({ ...INPUT, action: "create", job_id: OTHER, source_path: "/source.webp", mask_path: "/mask.png" }, ctx);
    expect(post.mock.calls[0][1]).toEqual({ ...INPUT, source_path: "/source.webp", mask_path: "/mask.png" });
  });
  it("polls status without requiring a cached file token and only reports a file after success", async () => {
    const { ctx, post, get } = context(SAVED, 200); ctx.ncToken = undefined;
    const result = await generateMedia.handler({ action: "status", job_id: ID }, ctx);
    expect(get).toHaveBeenCalledExactlyOnceWith(`/media/${ID}`, { headers: { "X-Nextcloud-User": "alice", "X-Nextcloud-Token": "" }, signal: ctx.signal }); expect(post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, data: { status: "succeeded", bytes: 1234, mimeType: "image/png", seed: 123, engine: "sdxl", media: [{ kind: "file", path: INPUT.path, size: 1234 }] } });
  });
  it("lists bounded jobs without flattening file cards from nested rows", async () => {
    const { ctx, get } = context({ jobs: [PENDING, SAVED, { ...PENDING, status: "failed", error: "Install the local model first.", media: SAVED.media }] }, 200);
    const result = await generateMedia.handler({ action: "list" }, ctx);
    expect(get).toHaveBeenCalledExactlyOnceWith("/media", expect.anything());
    expect(result).toMatchObject({ ok: true, data: { jobs: [{ id: ID, media: [PENDING.media] }, { id: ID, media: [SAVED.media] }, { id: ID, status: "failed", error: "Install the local model first." }] } });
    if (result.ok) { expect(result.data).not.toHaveProperty("media"); expect((result.data as { jobs: object[] }).jobs[2]).not.toHaveProperty("media"); }
  });
  it("cancels a returned owned job and drops unsolicited file metadata", async () => {
    const { ctx, post } = context({ ...PENDING, status: "cancelled", media: SAVED.media, bytes: 1234 }, 200);
    const result = await generateMedia.handler({ action: "cancel", job_id: ID }, ctx);
    expect(post).toHaveBeenCalledExactlyOnceWith(`/media/${ID}/cancel`, {}, expect.anything());
    expect(result).toMatchObject({ ok: true, data: { id: ID, status: "cancelled" } });
    if (result.ok) { expect(result.data).not.toHaveProperty("media"); expect(result.data).not.toHaveProperty("bytes"); }
  });
  it("allows a saving job only as a job descriptor", async () => {
    const { ctx } = context({ ...PENDING, status: "saving" }, 200);
    expect(await generateMedia.handler({ action: "status", job_id: ID }, ctx)).toMatchObject({ ok: true, data: { status: "saving", media: [{ kind: "media_job", jobId: ID }] } });
  });
  it("validates real saved MP4 metadata for both supported offline video engines", async () => {
    for (const engine of ["wan", "ltx"]) {
      const path = "/movie.mp4";
      const { ctx } = context({ ...SAVED, kind: "video", path, mimeType: "video/mp4", engine, media: fileMediaFromPath(path, { mimeType: "video/mp4", size: 1234 }) }, 200);
      expect(await generateMedia.handler({ action: "status", job_id: ID }, ctx)).toMatchObject({ ok: true, data: { path, engine, media: [{ mimeType: "video/mp4" }] } });
    }
  });
});

describe("generate_media rejects unsafe args before dispatch", () => {
  it.each([{ action: "delete" }, { kind: "audio" }, { path: "/nested/file.png" }, { path: "/%2e%2e.png" }, { path: "/file\\name.png" }, { path: "/file\0.png" }, { path: "/file.mp4" }, { path: "/.png" }, { path: `/${"a".repeat(252)}.png` }, { prompt: "" }, { prompt: "  " }, { prompt: "x".repeat(4001) }, { source_path: "https://evil/source.png" }, { source_path: "/../source.png" }, { source_path: "/source%2fsecret.png" }, { source_path: "/one//source.png" }, { source_path: "/source.svg" }, { mask_path: "/mask.png" }, { options: null }, { options: [] }])("rejects %j", async (bad) => {
    const { ctx, get, post } = context(); expect(await generateMedia.handler({ ...INPUT, ...bad }, ctx)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } }); expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it.each(["status", "cancel"])("requires a returned UUID for %s", async (action) => {
    for (const job_id of [undefined, "../owner-job", "/api/files/media/123", "123"]) {
      const { ctx, get, post } = context(); expect(await generateMedia.handler({ action, job_id }, ctx)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } }); expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    }
  });
  it("requires an acting person and connected file access for create", async () => {
    const { ctx, get, post } = context(); ctx.userId = undefined;
    expect(await generateMedia.handler({ action: "list" }, ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    ctx.userId = "alice"; ctx.ncToken = undefined;
    expect(await generateMedia.handler(INPUT, ctx)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } }); expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it("rejects image-only masks on video", async () => {
    const { ctx, post } = context();
    expect(await generateMedia.handler({ ...INPUT, kind: "video", path: "/video.mp4", source_path: "/source.png", mask_path: "/mask.png" }, ctx)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } }); expect(post).not.toHaveBeenCalled();
  });
});

describe("generate_media validates native response metadata", () => {
  it.each([[400, "INVALID_ARGS"], [401, "AUTH_REQUIRED"], [403, "AUTH_REQUIRED"], [404, "NOT_FOUND"], [409, "CONFLICT"], [429, "BUSY"], [503, "MEDIA_UNAVAILABLE"]])("maps HTTP %s to %s", async (status, code) => {
    const { ctx } = context({ error: "An actionable local reason." }, status as number);
    expect(await generateMedia.handler(INPUT, ctx)).toMatchObject({ ok: false, error: { code, message: "An actionable local reason." } });
  });
  it.each([{ id: "bad" }, { kind: "audio" }, { path: "/nested/picture.png" }, { path: "/different.png" }, { path: "/picture.mp4" }, { status: "queued" }, { media: undefined }, { media: SAVED.media }, { media: mediaJobMedia(OTHER) }, { media: { ...PENDING.media, statusUrl: "/api/auth/me" } }])("refuses malformed or mismatched pending jobs %j", async (bad) => {
    const { ctx } = context({ ...PENDING, ...bad });
    expect(await generateMedia.handler(INPUT, ctx)).toMatchObject({ ok: false, error: { code: "MEDIA_UNAVAILABLE" } });
  });
  it.each([{ bytes: 0 }, { bytes: 20 * 1024 * 1024 + 1 }, { bytes: 1.5 }, { mimeType: "text/html" }, { seed: -1 }, { seed: 2147483648 }, { seed: 1.5 }, { seed: undefined }, { engine: "wan" }, { engine: undefined }, { media: PENDING.media }, { media: { ...SAVED.media, path: "/other.png" } }, { media: { ...SAVED.media, size: 999 } }, { media: { ...SAVED.media, name: "other.png" } }, { media: { ...SAVED.media, previewUrl: "/api/auth/me" } }, { media: { ...SAVED.media, downloadUrl: "https://evil/image.png" } }])("refuses invalid saved-file metadata %j", async (bad) => {
    const { ctx } = context({ ...SAVED, ...bad }, 200);
    expect(await generateMedia.handler({ action: "status", job_id: ID }, ctx)).toMatchObject({ ok: false, error: { code: "MEDIA_UNAVAILABLE" } });
  });
  it("does not substitute a different job returned by status or cancellation", async () => {
    for (const action of ["status", "cancel"]) {
      const { ctx } = context({ ...PENDING, id: OTHER, media: mediaJobMedia(OTHER) }, 200);
      expect(await generateMedia.handler({ action, job_id: ID }, ctx)).toMatchObject({ ok: false, error: { code: "MEDIA_UNAVAILABLE" } });
    }
  });
  it.each([null, [], "wrong shape", { jobs: null }, { jobs: [null] }, { jobs: Array.from({ length: 21 }, () => PENDING) }])("refuses malformed or oversized job listings %j", async (body) => {
    const { ctx } = context(body, 200); expect(await generateMedia.handler({ action: "list" }, ctx)).toMatchObject({ ok: false, error: { code: "MEDIA_UNAVAILABLE" } });
  });
  it("handles non-JSON success and error bodies without inventing a saved file", async () => {
    const { ctx, post } = context();
    post.mockResolvedValueOnce(new Response("not-json", { status: 202 })).mockResolvedValueOnce(new Response("library traceback", { status: 503 }));
    expect(await generateMedia.handler(INPUT, ctx)).toMatchObject({ ok: false, error: { code: "MEDIA_UNAVAILABLE" } });
    expect(await generateMedia.handler(INPUT, ctx)).toMatchObject({ ok: false, error: { code: "MEDIA_UNAVAILABLE", message: "Local media generation is unavailable." } });
  });
});
