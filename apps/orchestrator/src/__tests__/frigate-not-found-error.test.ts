/**
 * FrigateNotFoundError (WARP-2975) — the typed replacement for the bare
 * `Error("event_not_found")` / `Error("thumbnail_not_found")` sentinels.
 *
 * Two layers: the error type itself, and the real frigate client raising it
 * on a Frigate 404 (network stubbed) while every other non-2xx stays a plain
 * Error. Route-level mapping is pinned in cameras-delete-event.test.ts and
 * cameras-event-thumbnail.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    FRIGATE_URL: "http://frigate.test:5000",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { deleteEvent, fetchEventThumbnail, fetchRecordingSnapshot } from "../services/frigate.client.js";
import { FRIGATE_NOT_FOUND_CODES, FrigateNotFoundError } from "../types/frigate-error.js";

describe("FrigateNotFoundError", () => {
  it.each(FRIGATE_NOT_FOUND_CODES)("%s: carries the code, keeps it as the message", (code) => {
    const err = new FrigateNotFoundError(code);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FrigateNotFoundError);
    expect(err.code).toBe(code);
    expect(err.message).toBe(code);
    expect(err.name).toBe("FrigateNotFoundError");
  });

  it("is not confused with a plain Error carrying the same text", () => {
    const bare = new Error("event_not_found");

    expect(bare).not.toBeInstanceOf(FrigateNotFoundError);
    expect((bare as { code?: unknown }).code).toBeUndefined();
  });

  it("lists exactly the Frigate not-found codes", () => {
    // review_not_found / preview_not_found: WARP-3509, the review media routes.
    // recording_snapshot_not_found: WARP-3927, no recording covers the instant.
    expect([...FRIGATE_NOT_FOUND_CODES]).toEqual([
      "event_not_found",
      "thumbnail_not_found",
      "review_not_found",
      "preview_not_found",
      "recording_snapshot_not_found",
    ]);
  });
});

describe("frigate.client not-found errors", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  function frigateAnswers(status: number) {
    fetchSpy.mockImplementation(async () => new Response(null, { status }));
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("fetchEventThumbnail: a Frigate 404 rejects with FrigateNotFoundError(thumbnail_not_found)", async () => {
    frigateAnswers(404);

    const err = await fetchEventThumbnail("ev-1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FrigateNotFoundError);
    expect((err as FrigateNotFoundError).code).toBe("thumbnail_not_found");
  });

  it("deleteEvent: a Frigate 404 rejects with FrigateNotFoundError(event_not_found)", async () => {
    frigateAnswers(404);

    const err = await deleteEvent("ev-1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FrigateNotFoundError);
    expect((err as FrigateNotFoundError).code).toBe("event_not_found");
  });

  it("fetchRecordingSnapshot: asks for that second at the stated height; a 404 is FrigateNotFoundError(recording_snapshot_not_found)", async () => {
    fetchSpy.mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 }));
    await fetchRecordingSnapshot("front_door", 1791422400.9, 480.7);
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/api\/front_door\/recordings\/1791422400\/snapshot\.jpg\?height=480$/);

    frigateAnswers(404);
    const err = await fetchRecordingSnapshot("front_door", 1791422400, 480).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FrigateNotFoundError);
    expect((err as FrigateNotFoundError).code).toBe("recording_snapshot_not_found");
  });

  it("fetchRecordingSnapshot: a Frigate 5xx stays a plain Error, not a not-found", async () => {
    frigateAnswers(503);
    const err = await fetchRecordingSnapshot("front_door", 1791422400, 480).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(FrigateNotFoundError);
    expect((err as Error).message).toBe("Frigate recording snapshot: 503");
  });

  it.each([500, 502, 503])("a Frigate %i stays a plain Error, not a not-found", async (status) => {
    frigateAnswers(status);

    const thumb = await fetchEventThumbnail("ev-1").catch((e: unknown) => e);
    const del = await deleteEvent("ev-1").catch((e: unknown) => e);

    expect(thumb).not.toBeInstanceOf(FrigateNotFoundError);
    expect((thumb as Error).message).toBe(`Frigate thumbnail: ${status}`);
    expect(del).not.toBeInstanceOf(FrigateNotFoundError);
    expect((del as Error).message).toBe(`Frigate event delete: ${status}`);
  });
});
