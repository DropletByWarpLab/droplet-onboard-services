/**
 * WARP-3506 — `POST /api/cameras` no longer says `ok` the moment Frigate
 * accepts the config. It answers 200 only once the camera is producing video,
 * and a distinct 202 `added_no_stream` (with a reason the operator can act on)
 * when the camera was added but is not streaming — a wrong password, or a
 * camera Frigate did not start. `addCameraManual` has to carry that through
 * instead of treating every 2xx as "done".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { addCameraManual } from "./api";
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

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("addCameraManual", () => {
  it("posts the details as typed — the server files the camera under its own key", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: { status: "ok", camera: "front_door" } }));

    await addCameraManual("Front-Door", "rtsp://192.168.9.60:554/stream1", "Hanwha", "XNV-C8083R");

    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/cameras$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Front-Door",
      rtspUrl: "rtsp://192.168.9.60:554/stream1",
      manufacturer: "Hanwha",
      model: "XNV-C8083R",
    });
  });

  it("reports ok when the camera is streaming", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: { status: "ok", camera: "front_door" } }));

    await expect(addCameraManual("front_door", "rtsp://192.168.9.60/s")).resolves.toEqual({ status: "ok" });
  });

  it("carries the reason through when the camera was added but is not streaming", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: true,
        status: 202,
        json: {
          status: "added_no_stream",
          camera: "front_door",
          code: "no_frames",
          reason: "The camera was added, but no video is coming from it.",
        },
      }),
    );

    await expect(addCameraManual("front_door", "rtsp://192.168.9.60/s")).resolves.toEqual({
      status: "added_no_stream",
      reason: "The camera was added, but no video is coming from it.",
    });
  });

  it("throws the server's message on a failure", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: false, status: 500, json: { error: "Failed to add camera to Frigate" } }),
    );

    await expect(addCameraManual("front_door", "rtsp://192.168.9.60/s")).rejects.toThrow(
      "Failed to add camera to Frigate",
    );
  });

  it("does not choke on a 2xx with no JSON body", async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error("no body")),
    } as unknown as Response);

    await expect(addCameraManual("front_door", "rtsp://192.168.9.60/s")).resolves.toEqual({ status: "ok" });
  });
});
