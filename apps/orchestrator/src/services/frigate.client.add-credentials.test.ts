/**
 * WARP-3505 — Frigate echoes the config path in its error replies, and the path
 * the manual "Add camera" flow writes carries the camera's password. Whatever
 * Frigate says back is scrubbed before it reaches a log (NET-05).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { addCamera } from "./frigate.client.js";

const PW = "C@mera!2024";

beforeEach(() => {
  warn.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("addCamera — what Frigate says back is not logged with the credentials in it", () => {
  it("scrubs the offending path from a non-2xx reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`Invalid input path: rtsp://admin:${PW}@192.168.9.5:554/x for camera front`, { status: 400 })),
    );

    expect(await addCamera("front", `rtsp://admin:${PW}@192.168.9.5:554/x`)).toBe(false);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("mera!2024");
    expect(logged).toContain("Invalid input path"); // the rest of the message is kept
  });

  it("scrubs a percent-encoded form too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad rtsp://john.doe:C%40mera%212024@192.168.9.5/x", { status: 400 })),
    );
    await addCamera("front", "rtsp://192.168.9.5/x");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("mera%212024");
  });
});
