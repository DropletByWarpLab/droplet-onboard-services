/**
 * WARP-1847 — the camera-discovery client contract.
 *
 * Two things the UI depends on and neither was expressible before:
 *   1. `discoveryOnline` — whether anything is even scanning, so the page can
 *      tell "no cameras on your network" apart from "nothing is looking".
 *   2. the scan response carries the candidates it found, so pressing
 *      "Scan network" can render a list instead of silently returning counts.
 *
 * The bare-array case is the mixed-version box: a dashboard bundle newer than
 * the orchestrator it's talking to (mid-deploy) must still render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  acceptDiscoveredCamera,
  addCameraManual,
  addDiscoveredCameraWithCredentials,
  fetchCameraCandidates,
  fetchDiscoveredCameras,
  triggerCameraScan,
} from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(init: { ok: boolean; status: number; json: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(init.json),
  } as unknown as Response;
}

const CANDIDATE = {
  id: "mac:E4:30:22:50:2A:FD",
  name: "XNV_C8083R",
  ip: "192.168.9.219",
  status: "needs_credentials",
};

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("fetchCameraCandidates", () => {
  it("returns the envelope as sent", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { cameras: [CANDIDATE], discoveryOnline: true } }),
    );
    await expect(fetchCameraCandidates()).resolves.toEqual({
      cameras: [CANDIDATE],
      discoveryOnline: true,
    });
  });

  it("carries discoveryOnline false through", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { cameras: [], discoveryOnline: false } }),
    );
    await expect(fetchCameraCandidates()).resolves.toEqual({
      cameras: [],
      discoveryOnline: false,
    });
  });

  it("accepts the older bare-array shape from a not-yet-updated orchestrator", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: [CANDIDATE] }));
    await expect(fetchCameraCandidates()).resolves.toEqual({
      cameras: [CANDIDATE],
      discoveryOnline: true,
    });
  });

  it("throws on a failed read rather than reporting an empty network", async () => {
    authFetchMock.mockResolvedValue(res({ ok: false, status: 500, json: {} }));
    await expect(fetchCameraCandidates()).rejects.toThrow(/500/);
  });

  it("fetchDiscoveredCameras still returns a plain array for its existing callers", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { cameras: [CANDIDATE], discoveryOnline: true } }),
    );
    await expect(fetchDiscoveredCameras()).resolves.toEqual([CANDIDATE]);
  });
});

describe("triggerCameraScan", () => {
  it("returns the candidates the scan found along with the counts", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: true,
        status: 200,
        json: { status: "scan_complete", known: 0, pending: 1, cameras: [CANDIDATE] },
      }),
    );
    await expect(triggerCameraScan()).resolves.toEqual({
      status: "scan_complete",
      known: 0,
      pending: 1,
      message: undefined,
      cameras: [CANDIDATE],
      discoveryOnline: true,
    });
  });

  it("reports discovery offline on the scan_unavailable envelope", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: true,
        status: 200,
        json: {
          status: "scan_unavailable",
          cameras: [],
          message: "Camera discovery service is not running.",
        },
      }),
    );
    const result = await triggerCameraScan();
    expect(result.discoveryOnline).toBe(false);
    expect(result.message).toMatch(/not running/);
  });

  it("tolerates a pre-WARP-1847 orchestrator that returns counts only", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: true, status: 200, json: { status: "scan_complete", known: 2, pending: 0 } }),
    );
    const result = await triggerCameraScan();
    expect(result.cameras).toEqual([]);
    expect(result.discoveryOnline).toBe(true);
  });
});

describe("acceptDiscoveredCamera", () => {
  it("url-encodes the mac: id so the colons survive the path", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: {} }));
    await acceptDiscoveredCamera("mac:E4:30:22:50:2A:FD");
    expect(authFetchMock.mock.calls[0][0]).toContain(
      "/api/cameras/discovered/mac%3AE4%3A30%3A22%3A50%3A2A%3AFD/accept",
    );
  });

  it("surfaces the orchestrator's explanation instead of a status code", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 422,
        json: { error: "Camera stream did not verify — the RTSP path or credentials are likely wrong." },
      }),
    );
    await expect(acceptDiscoveredCamera("mac:AA:BB")).rejects.toThrow(/did not verify/);
  });
});

describe("addDiscoveredCameraWithCredentials (WARP-3505)", () => {
  it("POSTs the credentials as a JSON body — never in the URL — to the credentials route", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: { status: "accepted" } }));
    await addDiscoveredCameraWithCredentials("mac:E4:30:22:50:2A:FD", "admin", "s3cret!");

    const [url, init] = authFetchMock.mock.calls[0];
    expect(url).toContain("/api/cameras/discovered/mac%3AE4%3A30%3A22%3A50%3A2A%3AFD/credentials");
    expect(String(url)).not.toContain("s3cret");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: "admin",
      password: "s3cret!",
    });
  });

  it.each([
    ["auth_failed", "AUTH_FAILED"],
    ["locked", "LOCKED"],
    ["no_stream_path", "NO_STREAM_PATH"],
    ["unreachable", "UNREACHABLE"],
    ["discovery_unavailable", "DISCOVERY_UNAVAILABLE"],
  ])("maps the server's %s to a %s error code for friendly copy", async (serverCode, expected) => {
    authFetchMock.mockResolvedValue(
      res({ ok: false, status: 422, json: { error: "Prose.", code: serverCode } }),
    );
    await expect(addDiscoveredCameraWithCredentials("mac:AA:BB", "admin", "s3cret!")).rejects.toMatchObject({
      code: expected,
      status: 422,
    });
  });

  it("does not put the password in the thrown error", async () => {
    authFetchMock.mockResolvedValue(res({ ok: false, status: 500, json: {} }));
    const err = await addDiscoveredCameraWithCredentials("mac:AA:BB", "admin", "s3cret!").catch((e) => e);
    expect(String(err.message)).not.toContain("s3cret");
  });
});

describe("addCameraManual credentials (WARP-3505)", () => {
  it("sends username and password in the body when given", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: {} }));
    await addCameraManual("front_door", "rtsp://192.168.9.60:554/live", "Hanwha", "XNV", "admin", "s3cret!");
    const body = JSON.parse((authFetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ name: "front_door", rtspUrl: "rtsp://192.168.9.60:554/live", username: "admin", password: "s3cret!" });
    expect(String(authFetchMock.mock.calls[0][0])).not.toContain("s3cret");
  });

  it("omits them when blank, so a URL with embedded credentials still works", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: {} }));
    await addCameraManual("front_door", "rtsp://u:p@192.168.9.60/live");
    const body = JSON.parse((authFetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("username");
    expect(body).not.toHaveProperty("password");
  });
});
