/**
 * #11 — syncCamerasFromDb: prune Frigate camera entries orphaned by a prior
 * version / Postgres wipe (e.g. camera_192_168_20_176), preserving the full
 * block of every camera still in the DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// FRIGATE_URL is read from config at import; stub it deterministically.
vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000" },
}));

import { syncCamerasFromDb } from "./frigate.client.js";

/** Route fetch by URL: /api/config returns the snapshot; /api/config/save 200s. */
function stubConfig(
  cameras: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/api/config")) {
      return new Response(
        JSON.stringify({ mqtt: { enabled: true }, ...extra, cameras }),
        { status: 200 },
      );
    }
    if (url.includes("/api/config/save")) {
      return new Response("", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncCamerasFromDb (#11)", () => {
  it("prunes cameras not in the DB and POSTs the full config back", async () => {
    const fetchMock = stubConfig({
      good_cam: {
        ffmpeg: { inputs: [{ path: "rtsp://x" }] },
        detect: { enabled: true },
      },
      camera_192_168_20_176: { ffmpeg: { inputs: [{ path: "rtsp://stale" }] } },
    });

    const removed = await syncCamerasFromDb(["good_cam"]);

    expect(removed).toEqual(["camera_192_168_20_176"]);
    const saveCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/api/config/save"),
    );
    expect(saveCall).toBeTruthy();
    const [saveUrl, saveInit] = saveCall!;
    expect(String(saveUrl)).toContain("save_option=restart");
    expect((saveInit as RequestInit).method).toBe("POST");
    expect((saveInit as RequestInit).headers).toMatchObject({
      "Content-Type": "text/plain",
    });
    const body = JSON.parse((saveInit as RequestInit).body as string);
    expect(Object.keys(body.cameras)).toEqual(["good_cam"]);
    expect(body.cameras.good_cam.detect.enabled).toBe(true); // survivor preserved
    expect(body.mqtt).toEqual({ enabled: true }); // non-camera config preserved
  });

  it("is a no-op (no save) when there are no orphans", async () => {
    const fetchMock = stubConfig({ good_cam: { ffmpeg: {} } });
    const removed = await syncCamerasFromDb(["good_cam"]);
    expect(removed).toEqual([]);
    expect(
      fetchMock.mock.calls.some(([u]) =>
        String(u).includes("/api/config/save"),
      ),
    ).toBe(false);
  });

  it("removes ALL cameras when the DB is empty (the live-box state)", async () => {
    const fetchMock = stubConfig({ camera_192_168_20_176: { ffmpeg: {} } });
    const removed = await syncCamerasFromDb([]);
    expect(removed).toEqual(["camera_192_168_20_176"]);
    const saveCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/api/config/save"),
    );
    const body = JSON.parse((saveCall![1] as RequestInit).body as string);
    expect(body.cameras).toEqual({});
  });

  it("throws when Frigate rejects the save (so callers can log)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.endsWith("/api/config")) {
          return new Response(
            JSON.stringify({ cameras: { orphan: {} } }),
            { status: 200 },
          );
        }
        return new Response("bad", { status: 422 });
      }),
    );
    await expect(syncCamerasFromDb([])).rejects.toThrow(
      /Frigate rejected the config: 422/,
    );
  });
});
