/**
 * #11 — syncCamerasFromDb + deleteCamera: prune Frigate camera entries.
 *
 * On Frigate 0.17 the resolved /api/config is not save-round-trippable and
 * DELETE /api/config/cameras/<name> is a 404, so both operate on the AUTHORED
 * YAML: GET /api/config/raw -> edit -> POST /api/config/save. This guards that
 * survivors + non-camera config are preserved and only the targeted cameras
 * are dropped.
 *
 * WARP-3506 / WARP-3510 added the safety rails around that prune:
 *   - it compares CANONICAL keys, so a row whose name differs from its Frigate
 *     key only by case or punctuation is not an "orphan" (the live bug: the
 *     camera just added was pruned in the same request);
 *   - it takes the DB snapshot INSIDE the config lock, after any in-flight
 *     add has finished, so it cannot prune a camera whose row is not written yet;
 *   - it refuses to prune a key an ADOPTED row owns, and refuses a save that
 *     would leave `cameras` empty while ADOPTED rows exist;
 *   - every save is preceded by a timestamped pre-image of the YAML it replaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parse } from "yaml";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { warn, info, error } = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({ warn, info, error }),
}));

// FRIGATE_URL is read from config at import; stub it deterministically.
vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { syncCamerasFromDb, deleteCamera, addCamera } from "./frigate.client.js";
import { makeFakeFrigate } from "../__tests__/helpers/fake-frigate.js";

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
function stubRaw(yaml = BASE_YAML, saveStatus = 200, saveBody = "") {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/api/config/raw")) {
      return new Response(JSON.stringify(yaml), { status: 200 });
    }
    if (url.includes("/api/config/save")) {
      return new Response(saveBody, { status: saveStatus });
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

function noSave(fetchMock: ReturnType<typeof stubRaw>): boolean {
  return !fetchMock.mock.calls.some(([u]) => String(u).includes("/api/config/save"));
}

let preImageRoot: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  // Keep pre-images out of the real data dir; individual tests look inside.
  preImageRoot = mkdtempSync(join(tmpdir(), "frigate-preimage-"));
  process.env.FRIGATE_CONFIG_PREIMAGE_DIR = join(preImageRoot, "frigate-config");
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FRIGATE_CONFIG_PREIMAGE_DIR;
  rmSync(preImageRoot, { recursive: true, force: true });
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

  it("scrubs echoed stream credentials from config/save warning logs", async () => {
    const echoedPath = "rtsp://admin:camera-secret@frigate.local/live";
    stubRaw(BASE_YAML, 422, `invalid path ${echoedPath}`);

    await expect(syncCamerasFromDb([])).rejects.toThrow(/Frigate rejected the config: 422/);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ body: "invalid path rtsp://***@frigate.local/live" }),
      "Frigate config/save rejected during camera sync",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("camera-secret");
  });
});

describe("syncCamerasFromDb compares canonical keys (WARP-3506)", () => {
  it("does not prune the camera it was just given under a differently-cased name", async () => {
    // The live bug: the DB row said `Warp_Lab_Office`, Frigate had
    // `warp_lab_office`, the case-sensitive compare called it an orphan.
    const fetchMock = stubRaw(`cameras:\n  warp_lab_office:\n    ffmpeg:\n      inputs:\n        - path: rtsp://x\n`);

    const removed = await syncCamerasFromDb(["Warp_Lab_Office"]);

    expect(removed).toEqual([]);
    expect(noSave(fetchMock)).toBe(true);
  });

  it("treats a hyphenated DB name and its underscored Frigate key as the same camera", async () => {
    const fetchMock = stubRaw(`cameras:\n  front_door:\n    ffmpeg:\n      inputs:\n        - path: rtsp://x\n`);

    expect(await syncCamerasFromDb(["Front-Door"])).toEqual([]);
    expect(noSave(fetchMock)).toBe(true);
  });

  it("still prunes a genuinely unknown key next to it", async () => {
    const fetchMock = stubRaw(
      `cameras:\n  warp_lab_office:\n    ffmpeg:\n      inputs:\n        - path: rtsp://x\n  stale_one:\n    ffmpeg:\n      inputs:\n        - path: rtsp://y\n`,
    );

    expect(await syncCamerasFromDb(["Warp_Lab_Office"])).toEqual(["stale_one"]);
    expect(Object.keys(savedConfig(fetchMock).cameras)).toEqual(["warp_lab_office"]);
  });
});

describe("syncCamerasFromDb refuses to destroy an adopted camera (WARP-3510)", () => {
  it("never prunes a key an ADOPTED row owns, even when the name list left it out", async () => {
    // A stale or buggy name list is exactly how a live camera got pruned.
    const fetchMock = stubRaw();

    const removed = await syncCamerasFromDb(async () => ({ names: [], adopted: ["good_cam"] }));

    expect(removed).toEqual(["camera_192_168_20_176"]);
    expect(Object.keys(savedConfig(fetchMock).cameras)).toEqual(["good_cam"]);
  });

  it("compares the adopted keys canonically too", async () => {
    const fetchMock = stubRaw();

    const removed = await syncCamerasFromDb(async () => ({ names: [], adopted: ["Good-Cam"] }));

    expect(removed).toEqual(["camera_192_168_20_176"]);
    expect(Object.keys(savedConfig(fetchMock).cameras)).toEqual(["good_cam"]);
  });

  it("refuses a save that would leave `cameras` empty while ADOPTED rows exist", async () => {
    // The DB says there is an adopted camera, yet Frigate holds only orphans
    // and the prune would leave it with nothing: that is a wipe, not a tidy-up.
    const fetchMock = stubRaw();

    const removed = await syncCamerasFromDb(async () => ({
      names: ["front_door"],
      adopted: ["front_door"],
    }));

    expect(removed).toEqual([]);
    expect(noSave(fetchMock)).toBe(true);
  });

  it("still empties `cameras` when no ADOPTED row exists (the live-box state)", async () => {
    const fetchMock = stubRaw();

    const removed = await syncCamerasFromDb(async () => ({ names: ["leftover_candidate"], adopted: [] }));

    expect(removed.sort()).toEqual(["camera_192_168_20_176", "good_cam"]);
    expect(savedConfig(fetchMock).cameras ?? {}).toEqual({});
  });
});

describe("syncCamerasFromDb takes its DB snapshot inside the config lock (WARP-3510)", () => {
  it("does not read the snapshot until an in-flight add has finished", async () => {
    const fake = makeFakeFrigate({ yaml: "cameras: {}\n" });
    vi.stubGlobal("fetch", fake.fetch);
    const releaseSet = fake.hold("PUT /api/config/set");
    const readSnapshot = vi.fn(async () => ({ names: ["front_door"], adopted: ["front_door"] }));

    // The add is parked in Frigate's config/set — the camera is not in the DB yet.
    const adding = addCamera("front_door", "rtsp://10.0.0.9/s");
    await vi.waitFor(() => expect(fake.calls.some((c) => c.startsWith("PUT /api/config/set"))).toBe(true));

    const syncing = syncCamerasFromDb(readSnapshot);
    await new Promise((r) => setTimeout(r, 20));
    expect(readSnapshot).not.toHaveBeenCalled(); // queued behind the add

    releaseSet();
    await adding;
    await syncing;

    expect(readSnapshot).toHaveBeenCalledTimes(1);
    // The camera the add wrote is still there: the sync saw the post-add world.
    expect(fake.cameras()).toEqual(["front_door"]);
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

  it("scrubs echoed stream credentials from delete warning logs", async () => {
    const echoedPath = "rtsp://admin:camera-secret@frigate.local/live";
    stubRaw(BASE_YAML, 500, `invalid path ${echoedPath}`);

    await expect(deleteCamera("good_cam")).rejects.toThrow(/Delete camera: 500/);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ body: "invalid path rtsp://***@frigate.local/live" }),
      "Frigate config/save rejected while deleting camera",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("camera-secret");
  });

  it("deletes by the canonical key, whatever case the caller used", async () => {
    const fetchMock = stubRaw();
    await deleteCamera("Good_Cam");
    expect(Object.keys(savedConfig(fetchMock).cameras)).toEqual(["camera_192_168_20_176"]);
  });
});

describe("Frigate config writers do not lose each other's updates (WARP-3510)", () => {
  it("two overlapping deletes both land", async () => {
    // Without the lock both read the same two-camera YAML and the second save
    // brings the first one's camera back.
    const fake = makeFakeFrigate({ yaml: BASE_YAML });
    vi.stubGlobal("fetch", fake.fetch);
    const releaseFirstRead = fake.hold("GET /api/config/raw");

    const first = deleteCamera("good_cam");
    await vi.waitFor(() => expect(fake.calls).toContain("GET /api/config/raw"));
    const second = deleteCamera("camera_192_168_20_176");

    releaseFirstRead();
    await Promise.all([first, second]);

    expect(fake.cameras()).toEqual([]);
  });

  it("a delete and a prune running together keep both edits", async () => {
    const fake = makeFakeFrigate({
      yaml: `cameras:\n  keep_me:\n    ffmpeg:\n      inputs:\n        - path: rtsp://a\n  drop_me:\n    ffmpeg:\n      inputs:\n        - path: rtsp://b\n  orphan:\n    ffmpeg:\n      inputs:\n        - path: rtsp://c\n`,
    });
    vi.stubGlobal("fetch", fake.fetch);
    const releaseFirstRead = fake.hold("GET /api/config/raw");

    const pruning = syncCamerasFromDb(["keep_me", "drop_me"]);
    await vi.waitFor(() => expect(fake.calls).toContain("GET /api/config/raw"));
    const deleting = deleteCamera("drop_me");

    releaseFirstRead();
    await Promise.all([pruning, deleting]);

    expect(fake.cameras()).toEqual(["keep_me"]);
  });
});

describe("a pre-image precedes every save (WARP-3510)", () => {
  function preImages(): string[] {
    const dir = process.env.FRIGATE_CONFIG_PREIMAGE_DIR!;
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  it("writes the YAML it is about to replace, before the save goes out", async () => {
    let existedAtSave: string[] = [];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/api/config/raw")) return new Response(JSON.stringify(BASE_YAML), { status: 200 });
      if (url.includes("/api/config/save")) {
        existedAtSave = preImages();
        return new Response("", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncCamerasFromDb(["good_cam"]);

    expect(existedAtSave).toHaveLength(1); // already on disk when the save was sent
    const [file] = preImages();
    expect(file).toMatch(/^config-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.yml$/);
    expect(readFileSync(join(process.env.FRIGATE_CONFIG_PREIMAGE_DIR!, file), "utf8")).toBe(BASE_YAML);
  });

  it("is written by deleteCamera as well", async () => {
    stubRaw();
    await deleteCamera("good_cam");
    expect(preImages()).toHaveLength(1);
  });

  it("writes nothing for a prune that has nothing to prune (no save, nothing to undo)", async () => {
    stubRaw();
    await syncCamerasFromDb(["good_cam", "camera_192_168_20_176"]);
    expect(preImages()).toHaveLength(0);
  });

  it("is skipped without failing the save when there is no data dir", async () => {
    process.env.FRIGATE_CONFIG_PREIMAGE_DIR = join(preImageRoot, "no-such-volume", "frigate-config");
    const fetchMock = stubRaw();

    await expect(syncCamerasFromDb(["good_cam"])).resolves.toEqual(["camera_192_168_20_176"]);

    expect(Object.keys(savedConfig(fetchMock).cameras)).toEqual(["good_cam"]);
    expect(existsSync(join(preImageRoot, "no-such-volume"))).toBe(false); // no volume invented
  });
});
