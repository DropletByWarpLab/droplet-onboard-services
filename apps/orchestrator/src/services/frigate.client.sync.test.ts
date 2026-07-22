/**
 * #11 — syncCamerasFromDb + deleteCamera: prune Frigate camera entries.
 *
 * On Frigate 0.17 the resolved /api/config is not save-round-trippable and
 * DELETE /api/config/cameras/<name> is a 404, so both operate on the AUTHORED
 * YAML: GET /api/config/raw -> edit -> POST /api/config/save. This guards that
 * survivors + non-camera config are preserved and only the targeted cameras
 * are dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parse } from "yaml";

// FRIGATE_URL is read from config at import; stub it deterministically.
vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { syncCamerasFromDb, deleteCamera } from "./frigate.client.js";

const BASE_YAML = `mqtt:
  enabled: true
detectors:
  cpu:
    type: cpu
cameras:
  good_cam:
    ffmpeg:
      inputs:
        - path: rtsp://good
          roles: [detect, record]
    detect:
      enabled: true
  camera_192_168_20_176:
    ffmpeg:
      inputs:
        - path: rtsp://stale
`;

/**
 * /api/config/raw returns the authored YAML JSON-string-encoded (as Frigate
 * 0.17 does); /api/config/save 200s. `yaml` is the raw YAML text to serve.
 */
function stubRaw(yaml = BASE_YAML, saveStatus = 200) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/api/config/raw")) {
      return new Response(JSON.stringify(yaml), { status: 200 });
    }
    if (url.includes("/api/config/save")) {
      return new Response("", { status: saveStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Parse the YAML body of the (single) /api/config/save call. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function savedConfig(fetchMock: any) {
  const saveCall = fetchMock.mock.calls.find(([u]: [string]) =>
    String(u).includes("/api/config/save"),
  );
  expect(saveCall).toBeTruthy();
  const [saveUrl, saveInit] = saveCall!;
  expect(String(saveUrl)).toContain("save_option=restart");
  expect((saveInit as RequestInit).method).toBe("POST");
  expect((saveInit as RequestInit).headers).toMatchObject({
    "Content-Type": "text/plain",
  });
  return parse((saveInit as RequestInit).body as string);
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncCamerasFromDb (#11)", () => {
  it("prunes cameras not in the DB and saves the authored YAML back", async () => {
    const fetchMock = stubRaw();

    const removed = await syncCamerasFromDb(["good_cam"]);

    expect(removed).toEqual(["camera_192_168_20_176"]);
    // Never touches the resolved /api/config (not round-trippable on 0.17).
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).endsWith("/api/config")),
    ).toBe(false);

    const cfg = savedConfig(fetchMock);
    expect(Object.keys(cfg.cameras)).toEqual(["good_cam"]);
    expect(cfg.cameras.good_cam.detect.enabled).toBe(true); // survivor preserved
    expect(cfg.mqtt).toEqual({ enabled: true }); // non-camera config preserved
    expect(cfg.detectors).toEqual({ cpu: { type: "cpu" } });
  });

  it("is a no-op (no save) when there are no orphans", async () => {
    const fetchMock = stubRaw();
    const removed = await syncCamerasFromDb(["good_cam", "camera_192_168_20_176"]);
    expect(removed).toEqual([]);
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("/api/config/save")),
    ).toBe(false);
  });

  it("removes ALL cameras when the DB is empty (the live-box state)", async () => {
    const fetchMock = stubRaw();
    const removed = await syncCamerasFromDb([]);
    expect(removed.sort()).toEqual(["camera_192_168_20_176", "good_cam"]);
    const cfg = savedConfig(fetchMock);
    expect(cfg.cameras ?? {}).toEqual({});
  });

  it("throws when Frigate rejects the save (so callers can log)", async () => {
    stubRaw(BASE_YAML, 422);
    await expect(syncCamerasFromDb([])).rejects.toThrow(
      /Frigate rejected the config: 422/,
    );
  });
});

describe("deleteCamera", () => {
  it("drops the camera from the authored YAML and saves it back", async () => {
    const fetchMock = stubRaw();
    await deleteCamera("good_cam");
    const cfg = savedConfig(fetchMock);
    expect(Object.keys(cfg.cameras)).toEqual(["camera_192_168_20_176"]);
    expect(cfg.mqtt).toEqual({ enabled: true });
  });

  it("throws on a failed save", async () => {
    stubRaw(BASE_YAML, 500);
    await expect(deleteCamera("good_cam")).rejects.toThrow(/Delete camera: 500/);
  });
});
