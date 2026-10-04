/**
 * addCamera: the manual "Add Camera" flow. Regression guard for the Frigate
 * 0.17 break where addCamera POSTed a bare {cameras:{…}} body to the removed
 * /api/config/set endpoint (405), so every add failed. Frigate 0.17 replaced
 * that with a PUT {config_data, requires_restart} envelope that deep-merges,
 * which is what we send now (the same call the camera-discovery service uses).
 *
 * WARP-3506 added two more contracts, both measured on a live 0.17.1 box:
 *
 *   1. The camera is filed under ONE canonical key (`toFrigateKey`), the same
 *      one the DB row carries — `Warp_Lab_Office` and `Front-Door` go in as
 *      `warp_lab_office` / `front_door`.
 *   2. `config/set` with `requires_restart: 1` only WRITES config.yml and
 *      answers "restart to apply". Nothing starts until Frigate restarts, so
 *      addCamera restarts it itself (what camera-discovery's add already did).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// FRIGATE_URL is read from config at import; stub it deterministically.
vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { addCamera } from "./frigate.client.js";
import { makeFakeFrigate } from "../__tests__/helpers/fake-frigate.js";

const preImage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./frigate-config-preimage.js", () => ({ writeConfigPreImage: preImage }));
const OLD_CONFIG = "cameras:\n  existing:\n    ffmpeg:\n      inputs: []\n";

/**
 * config/set PUT returns {success:true}; /api/restart 200s; anything else is
 * unexpected. `restartStatus` makes the restart call fail.
 */
function stubSet(response: Record<string, unknown> = { success: true }, status = 200, restartStatus = 200) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/api/config/raw")) return new Response(OLD_CONFIG);
    if (url.includes("/api/config/set")) {
      return new Response(JSON.stringify(response), { status });
    }
    if (url.includes("/api/restart")) {
      return new Response(JSON.stringify({ success: restartStatus < 400 }), { status: restartStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The (method, path) of every call a mock saw, in order. */
function sequence(fetchMock: ReturnType<typeof stubSet>): string[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    const path = new URL(String(url)).pathname;
    return `${((init as RequestInit | undefined)?.method ?? "GET").toUpperCase()} ${path}`;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  preImage.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("addCamera", () => {
  it("keeps the exact previous authored YAML before a camera can overwrite its fields", async () => {
    const fetchMock = stubSet();
    await addCamera("existing", "rtsp://192.168.9.60/new_path");
    expect(preImage).toHaveBeenCalledWith(OLD_CONFIG);
    expect(preImage.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[1]);
  });

  it("PUTs a merge envelope to /api/config/set with only the new camera block", async () => {
    const fetchMock = stubSet();

    const ok = await addCamera("Front Door", "rtsp://192.168.100.101:554/stream1");
    expect(ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("http://frigate:5000/api/config/set");
    // PUT with the 0.17 envelope — NOT the removed POST, NOT config/save.
    expect((init as RequestInit).method).toBe("PUT");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
    });

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.requires_restart).toBe(1);
    // Sends ONLY the new camera (Frigate deep-merges) — sanitized name, wired
    // for detect + record.
    expect(Object.keys(body.config_data.cameras)).toEqual(["front_door"]);
    expect(body.config_data.cameras.front_door.ffmpeg.inputs[0]).toEqual({
      path: "rtsp://192.168.100.101:554/stream1",
      roles: ["detect", "record"],
    });
    expect(body.config_data.cameras.front_door.detect.enabled).toBe(true);
    expect(body.config_data.cameras.front_door.record.enabled).toBe(true);
    expect(body.config_data.cameras.front_door.snapshots.enabled).toBe(true);
  });

  it("gives the new camera retention windows, not just record.enabled (WARP-1957)", async () => {
    const fetchMock = stubSet();
    await addCamera("Front Door", "rtsp://192.168.100.101:554/stream1");

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const record = body.config_data.cameras.front_door.record;

    // `record.enabled: true` on its own is the bug, not the fix: Frigate
    // 0.17 defaults `continuous` and `motion` to 0, so the camera kept
    // ONLY segments overlapping an alert while the UI said "Recording".
    expect(record.continuous.days).toBeGreaterThan(0);
    expect(record.motion.days).toBeGreaterThan(0);

    // Padding around each event, capped at Frigate's le=60 bound.
    expect(record.alerts.pre_capture).toBeGreaterThan(0);
    expect(record.alerts.pre_capture).toBeLessThanOrEqual(60);
    expect(record.detections.post_capture).toBeLessThanOrEqual(60);

    // Snapshots get an explicit window too, rather than inheriting one.
    expect(body.config_data.cameras.front_door.snapshots.retain.default).toBeGreaterThan(0);
  });

  it("honors detect=false", async () => {
    const fetchMock = stubSet();
    await addCamera("doorbell", "rtsp://10.0.0.9/s", false);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.config_data.cameras.doorbell.detect.enabled).toBe(false);
  });

  it("returns false when Frigate reports success:false (200 but rejected)", async () => {
    stubSet({ success: false, message: "invalid config" }, 200);
    const ok = await addCamera("bad", "rtsp://10.0.0.1/s");
    expect(ok).toBe(false);
  });

  it("returns false (does not throw) on a non-2xx status", async () => {
    stubSet({ detail: "nope" }, 400);
    const ok = await addCamera("bad", "rtsp://10.0.0.1/s");
    expect(ok).toBe(false);
  });

  it("treats a missing `success` key as failure, not silent success", async () => {
    stubSet({}, 200);
    const ok = await addCamera("shape_changed", "rtsp://10.0.0.2/s");
    expect(ok).toBe(false);
  });
});

describe("addCamera — one canonical key (WARP-3506)", () => {
  it.each([
    ["Warp_Lab_Office", "warp_lab_office"],
    ["Front-Door", "front_door"],
    ["FRONT DOOR", "front_door"],
  ])("files %s in Frigate as %s", async (typed, key) => {
    const fetchMock = stubSet();

    await addCamera(typed, "rtsp://10.0.0.9/s");

    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(Object.keys(body.config_data.cameras)).toEqual([key]);
  });

  it("refuses a name with no usable key, without touching Frigate", async () => {
    const fetchMock = stubSet();

    const ok = await addCamera("---", "rtsp://10.0.0.9/s");

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("addCamera — applies the write (WARP-3506)", () => {
  it("restarts Frigate after the config write — config/set alone never starts the camera", async () => {
    const fetchMock = stubSet();

    const ok = await addCamera("front_door", "rtsp://10.0.0.9/s");

    expect(ok).toBe(true);
    expect(sequence(fetchMock)).toEqual(["GET /api/config/raw", "PUT /api/config/set", "POST /api/restart"]);
  });

  it("does not restart when Frigate refused the config (nothing changed)", async () => {
    const fetchMock = stubSet({ success: false, message: "invalid config" });

    await addCamera("front_door", "rtsp://10.0.0.9/s");

    expect(sequence(fetchMock)).toEqual(["GET /api/config/raw", "PUT /api/config/set"]);
  });

  it("still reports the add when the restart call itself fails — verification is the arbiter", async () => {
    // The config IS on disk; the next restart picks it up. Failing the add here
    // would drop the DB row for a camera Frigate already has.
    stubSet({ success: true }, 200, 500);

    await expect(addCamera("front_door", "rtsp://10.0.0.9/s")).resolves.toBe(true);
  });

  it("still reports the add when the restart connection drops (Frigate dies before it answers)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/config/set")) return new Response(JSON.stringify({ success: true }), { status: 200 });
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(addCamera("front_door", "rtsp://10.0.0.9/s")).resolves.toBe(true);
  });

  it("brings the camera up end to end against a Frigate that behaves like 0.17", async () => {
    const fake = makeFakeFrigate();
    vi.stubGlobal("fetch", fake.fetch);

    await addCamera("Warp_Lab_Office", "rtsp://10.0.0.9/s");

    // Written to config.yml AND running — which only a restart achieves.
    expect(fake.cameras()).toEqual(["warp_lab_office"]);
    expect(fake.restarts()).toBe(1);
    const stats = await (await fake.fetch("http://frigate:5000/api/stats")).json();
    expect(stats.cameras.warp_lab_office.camera_fps).toBe(5);
  });
});
