/**
 * WARP-3509 — the frigate client's review helpers, against the Frigate 0.17.1
 * API (frigate/api/review.py, frigate/api/media.py @ v0.17.1).
 *
 * Two layers: `parseReviewThumbPath`, the strict gate between a `thumb_path`
 * Frigate hands us and a URL we dial on it, and the three fetchers' request
 * shapes and typed failures. Route-level mapping to HTTP statuses is pinned in
 * cameras-review-media.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    FRIGATE_URL: "http://frigate.test:5000",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import {
  fetchReviewPreview,
  fetchReviewThumbnail,
  markReviewViewed,
  parseReviewThumbPath,
} from "../services/frigate.client.js";
import { FrigateNotFoundError, FrigateUpstreamError } from "../types/frigate-error.js";

const ID = "1791059989.433851-qrgete";
const THUMB = `/media/frigate/clips/review/thumb-warp_lab_office-${ID}.webp`;

describe("parseReviewThumbPath", () => {
  it("accepts the path a live 0.17.1 box reports, as image/webp", () => {
    expect(parseReviewThumbPath(THUMB)).toEqual({
      name: `thumb-warp_lab_office-${ID}.webp`,
      contentType: "image/webp",
    });
  });

  it.each([".jpg", ".jpeg"])("accepts %s (older Frigate) as image/jpeg", (ext) => {
    expect(parseReviewThumbPath(`/media/frigate/clips/review/thumb-cam-1${ext}`)).toEqual({
      name: `thumb-cam-1${ext}`,
      contentType: "image/jpeg",
    });
  });

  it("accepts the camera names Frigate allows: letters, digits, underscore, hyphen", () => {
    expect(parseReviewThumbPath(`/media/frigate/clips/review/thumb-Front-Door_2-${ID}.webp`)).not.toBeNull();
  });

  it.each([
    ["traversal out of the review directory", "/media/frigate/clips/review/../../config/config.yml"],
    ["traversal inside the file name", "/media/frigate/clips/review/thumb-..-x.webp"],
    ["traversal that stays under the prefix", "/media/frigate/clips/review/x/../y.webp"],
    ["the review directory itself", "/media/frigate/clips/review/"],
    ["the clips directory", "/media/frigate/clips/"],
    ["a sibling directory", "/media/frigate/clips/exports/thumb.webp"],
    ["a prefix lookalike", "/media/frigate/clips/review-evil/thumb.webp"],
    ["a different root", "/etc/passwd"],
    ["a relative path", "clips/review/thumb.webp"],
    ["a nested path", "/media/frigate/clips/review/sub/thumb.webp"],
    ["an encoded separator", "/media/frigate/clips/review/..%2f..%2fconfig.yml"],
    ["a percent-encoded dot", "/media/frigate/clips/review/thumb%2ewebp"],
    ["a query string", "/media/frigate/clips/review/thumb.webp?x=1"],
    ["a fragment", "/media/frigate/clips/review/thumb.webp#x"],
    ["a backslash", "/media/frigate/clips/review/..\\config.yml"],
    ["a trailing newline", "/media/frigate/clips/review/thumb.webp\n"],
    ["a space", "/media/frigate/clips/review/thumb x.webp"],
    ["a NUL byte", "/media/frigate/clips/review/thumb\u0000.webp"],
    ["an unsupported extension", "/media/frigate/clips/review/thumb.png"],
    ["an upper-case extension", "/media/frigate/clips/review/thumb.WEBP"],
    ["no extension", "/media/frigate/clips/review/thumb"],
    ["a leading dot", "/media/frigate/clips/review/.webp"],
    ["an over-long name", `/media/frigate/clips/review/${"a".repeat(300)}.webp`],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { path: THUMB }],
  ])("rejects %s", (_why, value) => {
    expect(parseReviewThumbPath(value)).toBeNull();
  });
});

describe("FrigateUpstreamError", () => {
  it("carries the status and keeps the `Frigate <what>: <status>` message shape", () => {
    const err = new FrigateUpstreamError("review viewed", 405);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FrigateUpstreamError);
    expect(err.name).toBe("FrigateUpstreamError");
    expect(err.status).toBe(405);
    expect(err.message).toBe("Frigate review viewed: 405");
  });

  it("keeps a detail and the error that proved it", () => {
    const cause = new TypeError("terminated");
    const err = new FrigateUpstreamError("review thumbnail", 200, "body read failed", cause);

    expect(err.message).toBe("Frigate review thumbnail: 200 (body read failed)");
    expect(err.cause).toBe(cause);
    expect(new FrigateUpstreamError("review viewed", 405).cause).toBeUndefined();
  });

  it("is not a not-found, and a not-found is not an upstream error", () => {
    expect(new FrigateUpstreamError("review lookup", 500)).not.toBeInstanceOf(FrigateNotFoundError);
    expect(new FrigateNotFoundError("review_not_found")).not.toBeInstanceOf(FrigateUpstreamError);
  });
});

describe("frigate.client review fetchers", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe("markReviewViewed", () => {
    it("POSTs the bulk endpoint with {ids:[id]} as JSON", async () => {
      fetchSpy.mockResolvedValue(json(200, { success: true }));

      await markReviewViewed(ID);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://frigate.test:5000/api/reviews/viewed");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ ids: [ID] });
    });

    it.each([405, 422, 500, 503])("a Frigate %i rejects with FrigateUpstreamError carrying it", async (status) => {
      fetchSpy.mockResolvedValue(json(status, { detail: "nope" }));

      const err = await markReviewViewed(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateUpstreamError);
      expect((err as FrigateUpstreamError).status).toBe(status);
      expect((err as Error).message).toBe(`Frigate review viewed: ${status}`);
    });
  });

  describe("fetchReviewPreview", () => {
    it("GETs /api/review/<id>/preview?format=mp4 and returns the response", async () => {
      const upstream = new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } });
      fetchSpy.mockResolvedValue(upstream);

      const resp = await fetchReviewPreview(ID);

      expect(resp).toBe(upstream);
      expect(fetchSpy.mock.calls[0][0]).toBe(`http://frigate.test:5000/api/review/${ID}/preview?format=mp4`);
    });

    it("a Frigate 404 rejects with FrigateNotFoundError(preview_not_found)", async () => {
      fetchSpy.mockResolvedValue(json(404, { success: false, message: "Preview not found" }));

      const err = await fetchReviewPreview(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateNotFoundError);
      expect((err as FrigateNotFoundError).code).toBe("preview_not_found");
    });

    it.each([405, 500, 503])("a Frigate %i rejects with FrigateUpstreamError", async (status) => {
      fetchSpy.mockResolvedValue(json(status, { detail: "nope" }));

      const err = await fetchReviewPreview(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateUpstreamError);
      expect((err as Error).message).toBe(`Frigate review preview: ${status}`);
    });
  });

  describe("fetchReviewThumbnail", () => {
    const row = (over: Record<string, unknown> = {}) => json(200, { id: ID, camera: "warp_lab_office", thumb_path: THUMB, ...over });
    const file = () => new Response(new Uint8Array([9, 9]), { status: 200 });

    it("looks the review up, then fetches the file its thumb_path names from /clips/review/", async () => {
      fetchSpy.mockResolvedValueOnce(row()).mockResolvedValueOnce(file());

      const thumb = await fetchReviewThumbnail(ID);

      expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
        `http://frigate.test:5000/api/review/${ID}`,
        `http://frigate.test:5000/clips/review/thumb-warp_lab_office-${ID}.webp`,
      ]);
      expect(thumb.contentType).toBe("image/webp");
      expect(new Uint8Array(thumb.bytes)).toEqual(new Uint8Array([9, 9]));
    });

    it("a Frigate 404 on the lookup rejects with FrigateNotFoundError(review_not_found)", async () => {
      fetchSpy.mockResolvedValueOnce(json(404, { success: false }));

      const err = await fetchReviewThumbnail(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateNotFoundError);
      expect((err as FrigateNotFoundError).code).toBe("review_not_found");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("a Frigate 404 on the file rejects with FrigateNotFoundError(thumbnail_not_found)", async () => {
      fetchSpy.mockResolvedValueOnce(row()).mockResolvedValueOnce(new Response("", { status: 404 }));

      const err = await fetchReviewThumbnail(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateNotFoundError);
      expect((err as FrigateNotFoundError).code).toBe("thumbnail_not_found");
    });

    it("a thumb_path outside /media/frigate/clips/review/ is thumbnail_not_found and is never dialled", async () => {
      fetchSpy.mockResolvedValueOnce(row({ thumb_path: "/media/frigate/clips/review/../../config/config.yml" }));

      const err = await fetchReviewThumbnail(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateNotFoundError);
      expect((err as FrigateNotFoundError).code).toBe("thumbnail_not_found");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it.each([405, 500, 503])("a Frigate %i on the lookup rejects with FrigateUpstreamError", async (status) => {
      fetchSpy.mockResolvedValueOnce(json(status, { detail: "nope" }));

      const err = await fetchReviewThumbnail(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateUpstreamError);
      expect((err as Error).message).toBe(`Frigate review lookup: ${status}`);
    });

    it.each([405, 500, 503])("a Frigate %i on the file rejects with FrigateUpstreamError", async (status) => {
      fetchSpy.mockResolvedValueOnce(row()).mockResolvedValueOnce(new Response("", { status }));

      const err = await fetchReviewThumbnail(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateUpstreamError);
      expect((err as Error).message).toBe(`Frigate review thumbnail: ${status}`);
    });

    it("a lookup that is not JSON rejects with FrigateUpstreamError, not a bare SyntaxError", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("<html></html>", { status: 200 }));

      const err = await fetchReviewThumbnail(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateUpstreamError);
      expect(err).not.toBeInstanceOf(SyntaxError);
      expect((err as Error).cause).toBeInstanceOf(SyntaxError);
    });

    it("a body that dies mid-transfer rejects with FrigateUpstreamError, keeping what killed it", async () => {
      // undici surfaces a connection reset mid-body as `TypeError: terminated`,
      // which no outage classifier recognises on its own.
      const reset = new TypeError("terminated");
      const dying = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(reset);
          },
        }),
        { status: 200 },
      );
      fetchSpy.mockResolvedValueOnce(row()).mockResolvedValueOnce(dying);

      const err = await fetchReviewThumbnail(ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrigateUpstreamError);
      expect((err as Error).cause).toBe(reset);
    });
  });
});
