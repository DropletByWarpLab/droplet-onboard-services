/**
 * WARP-3505 F7 — a credentials submit can legitimately run for most of a
 * minute: camera-discovery tries ONVIF (<= 10 s) and then walks the stream
 * paths (<= 30 s), and the orchestrator waits up to 60 s for the answer. Every
 * proxy hop between the browser and the orchestrator has to outlast that, or a
 * camera that WAS added reads as a failed request.
 *
 * Two hops exist:
 *   - production: nginx `location /api/` straight to the orchestrator;
 *   - `next dev`: the Next rewrite, whose proxy gives up after 30 s unless
 *     `experimental.proxyTimeout` says otherwise (a 40 s request was cut).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

import { packagePath, readRepoFile } from "./helpers/test-paths";

/** The orchestrator's own wait for camera-discovery (camera-candidates.service.ts), plus slack. */
const LONGEST_CREDENTIALS_SUBMIT_MS = 65_000;

describe("credentials submit — proxy hops outlast the probe", () => {
  it("the next dev rewrite proxy waits at least as long as the probe can run", () => {
    const nextConfig = createRequire(packagePath("package.json"))("./next.config.js") as {
      experimental?: { proxyTimeout?: number };
    };
    expect(nextConfig.experimental?.proxyTimeout).toBeGreaterThanOrEqual(LONGEST_CREDENTIALS_SUBMIT_MS);
  });

  it("the production nginx /api/ location waits at least as long as the probe can run", () => {
    const conf = readRepoFile("docker/nginx/nginx.conf");
    const start = conf.indexOf("location /api/ {");
    expect(start).toBeGreaterThan(-1);
    const block = conf.slice(start, conf.indexOf("\n        }", start));
    const read = /proxy_read_timeout\s+(\d+)s;/.exec(block);
    expect(read, "location /api/ sets proxy_read_timeout").not.toBeNull();
    expect(Number(read![1]) * 1000).toBeGreaterThanOrEqual(LONGEST_CREDENTIALS_SUBMIT_MS);
  });
});
