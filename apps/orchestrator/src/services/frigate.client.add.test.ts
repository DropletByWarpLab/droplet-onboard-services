/**
 * addCamera: the manual "Add Camera" flow. Regression guard for the Frigate
 * 0.17 break where addCamera POSTed a bare {cameras:{…}} body to the removed
 * /api/config/set endpoint (405), so every add failed. Frigate 0.17 replaced
 * that with a PUT {config_data, requires_restart} envelope that deep-merges,
 * which is what we send now (the same call the camera-discovery service uses).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// FRIGATE_URL is read from config at import; stub it deterministically.
vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { addCamera } from "./frigate.client.js";

/** config/set PUT returns {success:true}; anything else is unexpected. */
function stubSet(response: Record<string, unknown> = { success: true }, status = 200) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/api/config/set")) {
      return new Response(JSON.stringify(response), { status });
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

describe("addCamera", () => {
  it("PUTs a merge envelope to /api/config/set with only the new camera block", async () => {
    const fetchMock = stubSet();

    const ok = await addCamera("Front Door", "rtsp://192.168.100.101:554/stream1");
    expect(ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
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

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
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
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
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
