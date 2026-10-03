/**
 * WARP-3506 — an add is not done until the camera is actually running.
 *
 * `POST /api/cameras` answered `{ status: "ok" }` the moment Frigate accepted
 * the config, and the dashboard drew a tile — but on Frigate 0.17 the camera
 * does not exist until Frigate restarts, and a camera with a wrong password
 * never produces a frame at all. `waitForCameraStreaming` is the verification:
 * poll `/api/stats` until the camera key is there with `camera_fps > 0`, for a
 * bounded time, and say WHY when it is not.
 *
 * Fake timers: the poll loop sleeps between reads, and the window is tens of
 * seconds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import { waitForCameraStreaming } from "./frigate.client.js";
import { makeFakeFrigate, type FakeFrigate } from "../__tests__/helpers/fake-frigate.js";

const WITH_CAM = (key: string) => `cameras:\n  ${key}:\n    ffmpeg:\n      inputs:\n        - path: rtsp://cam/s\n`;

/** A Frigate that has the camera in its config and has just been restarted. */
async function restartedFrigate(
  key: string,
  opts: Parameters<typeof makeFakeFrigate>[0] = {},
): Promise<FakeFrigate> {
  const fake = makeFakeFrigate({ yaml: WITH_CAM(key), ...opts });
  vi.stubGlobal("fetch", fake.fetch);
  await fake.fetch("http://frigate:5000/api/restart", { method: "POST" });
  fake.calls.length = 0;
  return fake;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("waitForCameraStreaming", () => {
  it("answers at once when the camera is already producing frames", async () => {
    const fake = await restartedFrigate("front_door");

    const verdict = await waitForCameraStreaming("front_door", { timeoutMs: 45_000, intervalMs: 2_000 });

    expect(verdict).toEqual({ streaming: true, fps: 5 });
    expect(fake.calls.filter((c) => c.includes("/api/stats"))).toHaveLength(1);
  });

  it("rides out the connection errors Frigate gives while it restarts", async () => {
    const fake = await restartedFrigate("front_door", { downPollsAfterRestart: 3 });

    const pending = waitForCameraStreaming("front_door", { timeoutMs: 45_000, intervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ streaming: true, fps: 5 });
    // 3 failed reads + the one that worked.
    expect(fake.calls.filter((c) => c.includes("/api/stats"))).toHaveLength(4);
  });

  it("looks for the camera under its Frigate key, whatever case it is asked for in", async () => {
    await restartedFrigate("warp_lab_office");

    const verdict = await waitForCameraStreaming("Warp_Lab_Office", { timeoutMs: 45_000, intervalMs: 2_000 });

    expect(verdict.streaming).toBe(true);
  });

  it("says not_started when Frigate never starts the camera at all", async () => {
    await restartedFrigate("front_door", { fpsAfterRestart: { front_door: null } });

    const pending = waitForCameraStreaming("front_door", { timeoutMs: 45_000, intervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(47_000);

    await expect(pending).resolves.toEqual({ streaming: false, reason: "not_started" });
  });

  it("says no_frames when the camera started but never produced a frame (bad address or password)", async () => {
    await restartedFrigate("front_door", { fpsAfterRestart: { front_door: 0 } });

    const pending = waitForCameraStreaming("front_door", { timeoutMs: 45_000, intervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(47_000);

    await expect(pending).resolves.toEqual({ streaming: false, reason: "no_frames" });
  });

  it("says frigate_unreachable when Frigate never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const pending = waitForCameraStreaming("front_door", { timeoutMs: 45_000, intervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(47_000);

    await expect(pending).resolves.toEqual({ streaming: false, reason: "frigate_unreachable" });
  });

  it("stops polling once the window is spent — it is bounded", async () => {
    const fake = await restartedFrigate("front_door", { fpsAfterRestart: { front_door: 0 } });

    const pending = waitForCameraStreaming("front_door", { timeoutMs: 20_000, intervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(21_000);
    await pending;
    const polls = fake.calls.filter((c) => c.includes("/api/stats")).length;

    // Nothing is left scheduled: more time passing adds no reads.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls.filter((c) => c.includes("/api/stats"))).toHaveLength(polls);
    expect(polls).toBeLessThanOrEqual(12);
  });

  it("defaults to a window of at most ~45 s", async () => {
    await restartedFrigate("front_door", { fpsAfterRestart: { front_door: 0 } });

    let settled = false;
    const pending = waitForCameraStreaming("front_door").then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false); // still waiting well into the window…
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(true); // …and done by ~50 s.
    await expect(pending).resolves.toMatchObject({ streaming: false });
  });
});
