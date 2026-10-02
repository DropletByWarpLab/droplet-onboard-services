/**
 * WARP-3007 — host exec boundary. Pins the one-shot container the
 * orchestrator creates to run the OTA helper ON THE HOST: its image (our own,
 * by ID), no network, `/:/host` + `chroot`, argv only, an env allowlist, and
 * the stdout/stderr/exit contract the runner and apply.ts rely on.
 */
import { describe, it, expect } from "vitest";
import {
  createHostExec,
  demuxDockerLogs,
  resolveHostExecContext,
  type DockerRequest,
} from "./host-exec.js";

const IMAGE = `sha256:${"d".repeat(64)}`;
const CTX = { image: IMAGE, hostUpdatesDir: "/var/lib/docker/volumes/docker_ota-updates/_data" };

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Scripted daemon: records every call, answers the one-shot lifecycle. */
function fakeDocker(opts: { exitCode?: number; logs?: Buffer; waitThrows?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const request: DockerRequest = async (method, apiPath, body) => {
    calls.push({ method, path: apiPath, body });
    const ok = (status: number, json?: unknown) => ({
      status,
      body: Buffer.from(json === undefined ? "" : JSON.stringify(json)),
    });
    if (apiPath === "/containers/create") return ok(201, { Id: "oneshot1" });
    if (apiPath.endsWith("/start")) return ok(204);
    if (apiPath.endsWith("/wait")) {
      if (opts.waitThrows) throw new Error("docker API POST wait timed out");
      return ok(200, { StatusCode: opts.exitCode ?? 0 });
    }
    if (apiPath.includes("/logs")) {
      return { status: 200, body: opts.logs ?? frame(1, '{"failed":[]}\n') };
    }
    return ok(204);
  };
  return { calls, request };
}

describe("createHostExec (WARP-3007)", () => {
  it("creates a no-network chroot one-shot off our own pinned image, argv only", async () => {
    const { calls, request } = fakeDocker();
    const exec = createHostExec({ request, context: CTX, env: { DROPLET_OTA_CONFIG_ROOT: "/opt/droplet" } });

    const out = await exec("/opt/droplet/docker/ota/apply-update.sh", [
      "recreate-services",
      "--services",
      "a;rm -rf /",
    ]);

    expect(out.stdout).toBe('{"failed":[]}\n');
    const create = calls[0]!;
    expect(create.path).toBe("/containers/create");
    expect(create.body).toEqual({
      Image: IMAGE,
      Entrypoint: ["chroot"],
      // The hostile value stays ONE argv token — nothing ever joins argv
      // into a shell string.
      Cmd: [
        "/host",
        "/bin/bash",
        "/opt/droplet/docker/ota/apply-update.sh",
        "recreate-services",
        "--services",
        "a;rm -rf /",
      ],
      User: "0:0",
      Env: [
        "DROPLET_OTA_CONFIG_ROOT=/opt/droplet",
        `DROPLET_OTA_UPDATES_DIR=${CTX.hostUpdatesDir}`,
        `DROPLET_OTA_HOST_IMAGE=${IMAGE}`,
      ],
      Labels: { "io.droplet.ota-host-exec": "recreate-services" },
      HostConfig: { Binds: ["/:/host"], NetworkMode: "none" },
    });
    // Lifecycle: create → start → wait → logs → remove.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /containers/create",
      "POST /containers/oneshot1/start",
      "POST /containers/oneshot1/wait",
      "GET /containers/oneshot1/logs?stdout=1&stderr=1",
      "DELETE /containers/oneshot1?force=1",
    ]);
  });

  it("adds per-call env (the pull token) to that call only", async () => {
    const { calls, request } = fakeDocker();
    const exec = createHostExec({ request, context: CTX, env: {} });
    await exec("/h.sh", ["pull-images"], { env: { DROPLET_OTA_GITHUB_TOKEN: "t" } });
    await exec("/h.sh", ["snapshot"]);
    const envs = calls
      .filter((c) => c.path === "/containers/create")
      .map((c) => (c.body as { Env: string[] }).Env);
    expect(envs[0]).toContain("DROPLET_OTA_GITHUB_TOKEN=t");
    expect(envs[1]!.some((e) => e.startsWith("DROPLET_OTA_GITHUB_TOKEN"))).toBe(false);
  });

  it("a non-zero exit rejects with stdout AND stderr attached (failed list, image-verify:)", async () => {
    const { calls, request } = fakeDocker({
      exitCode: 1,
      logs: Buffer.concat([
        frame(1, '{"failed":["routing"]}\n'),
        frame(2, "[apply-update] ERROR: image-verify: cosign rejected x\n"),
      ]),
    });
    const exec = createHostExec({ request, context: CTX, env: {} });
    const err = (await exec("/h.sh", ["pull-images"]).catch((e: unknown) => e)) as Error & {
      stdout?: string;
      stderr?: string;
    };
    expect(err).toBeInstanceOf(Error);
    expect(err.stdout).toBe('{"failed":["routing"]}\n');
    expect(err.stderr).toContain("image-verify:");
    // Removed even on failure.
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/containers/oneshot1?force=1" });
  });

  it("a wait timeout kills and removes the one-shot and rejects", async () => {
    const { calls, request } = fakeDocker({ waitThrows: true });
    const exec = createHostExec({ request, context: CTX, env: {} });
    await expect(exec("/h.sh", ["migrate-deploy"], { timeoutMs: 10 })).rejects.toThrow(
      /did not finish within 10 ms/,
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain("POST /containers/oneshot1/kill");
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });
});

describe("demuxDockerLogs", () => {
  it("splits the multiplexed stream by stream byte", () => {
    const buf = Buffer.concat([frame(1, "a"), frame(2, "err"), frame(1, "b")]);
    expect(demuxDockerLogs(buf)).toEqual({ stdout: "ab", stderr: "err" });
  });
});

describe("resolveHostExecContext", () => {
  const inspect = (json: unknown, status = 200): DockerRequest => async () => ({
    status,
    body: Buffer.from(JSON.stringify(json)),
  });

  it("returns our image ID and the host path behind the updates volume", async () => {
    const ctx = await resolveHostExecContext({
      containerId: "abc",
      updatesDir: "/data/updates",
      request: inspect({
        Image: IMAGE,
        Mounts: [
          { Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" },
          { Source: CTX.hostUpdatesDir, Destination: "/data/updates" },
        ],
      }),
    });
    expect(ctx).toEqual(CTX);
  });

  it("refuses a non-ID image or a missing updates volume", async () => {
    await expect(
      resolveHostExecContext({
        containerId: "abc",
        updatesDir: "/data/updates",
        request: inspect({ Image: "orchestrator:latest", Mounts: [] }),
      }),
    ).rejects.toThrow(/unexpected image id/);
    await expect(
      resolveHostExecContext({
        containerId: "abc",
        updatesDir: "/data/updates",
        request: inspect({ Image: IMAGE, Mounts: [] }),
      }),
    ).rejects.toThrow(/no volume is mounted/);
  });
});
