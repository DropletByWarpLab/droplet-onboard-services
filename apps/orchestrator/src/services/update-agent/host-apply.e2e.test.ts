/**
 * WARP-3007 / WARP-3017 — end-to-end-ish: a FAKE HOST (a repo root with a
 * `.env` and a compose file shaped like the appliance's: build:-only
 * services, `env_file: ../.env, required: false`) driven through the REAL
 * production chain against a REAL docker daemon:
 *
 *   createHostComposeRunner → createHostExec (Engine API one-shot,
 *   `chroot /host`, no network) → docker/ota/apply-update.sh on the host
 *   → host `docker compose`.
 *
 * Proves: (1) a recreated service carries the host `.env` values (the bug
 * was compose silently dropping them in-container); (2) the detached
 * self-swap supervisor waits for the new orchestrator to LISTEN (a
 * healthcheck that only passes after a boot delay) before calling the swap
 * good; (3) when it never listens in time, the supervisor restores configs
 * and the restored helper rolls every service back.
 *
 * Opt-in (needs a daemon whose host sees this path, e.g. colima or a Linux
 * box): DROPLET_OTA_E2E_DOCKER_SOCK=<socket> DROPLET_OTA_E2E_IMAGE=docker:27-cli.
 * The vehicle image only needs `chroot`; the host needs bash + docker compose.
 * Skipped everywhere else, CI included.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHostComposeRunner } from "./host-compose-runner.js";
import { createHostExec, dockerSocketRequest, type DockerRequest } from "./host-exec.js";
import type { ReleaseManifest } from "./manifest.js";

const SOCK = process.env.DROPLET_OTA_E2E_DOCKER_SOCK;
const VEHICLE = process.env.DROPLET_OTA_E2E_IMAGE ?? "docker:27-cli";
const REPO = path.resolve(__dirname, "../../../../..");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SOCK)("OTA host apply, end to end against a real daemon (WARP-3007)", () => {
  let request: DockerRequest;
  let root: string;
  let updates: string;
  let project: string;
  let image: string;

  const json = async (method: string, p: string) => {
    const r = await request(method, p);
    return JSON.parse(r.body.toString("utf8")) as unknown;
  };
  const containerOf = async (svc: string) => {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${svc}`],
      }),
    );
    const list = (await json("GET", `/containers/json?all=1&filters=${filters}`)) as Array<{ Id: string }>;
    return list[0]?.Id;
  };
  const envOf = async (svc: string) => {
    const id = await containerOf(svc);
    if (!id) return [];
    return ((await json("GET", `/containers/${id}/json`)) as { Config: { Env: string[] } }).Config.Env;
  };
  /** Wait for the detached supervisor to exit; returns its exit code + logs. */
  const waitSupervisor = async (updateId: string) => {
    const name = `droplet-ota-self-swap-${updateId}`;
    for (let i = 0; i < 120; i += 1) {
      const info = (await json("GET", `/containers/${name}/json`)) as {
        State?: { Status: string; ExitCode: number };
      };
      if (info.State?.Status === "exited") {
        const logs = await request("GET", `/containers/${name}/logs?stdout=1&stderr=1`);
        return { code: info.State.ExitCode, logs: logs.body.toString("utf8") };
      }
      await sleep(500);
    }
    throw new Error("supervisor never exited");
  };

  function runner(selfHealthAttempts: string) {
    const exec = createHostExec({
      request,
      context: { image, hostUpdatesDir: updates },
      env: {
        DROPLET_OTA_CONFIG_ROOT: root,
        DROPLET_OTA_SELF_HEALTH_ATTEMPTS: selfHealthAttempts,
        DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS: "1",
      },
    });
    return createHostComposeRunner({
      scriptPath: path.join(root, "docker/ota/apply-update.sh"),
      composeFile: path.join(root, "docker/docker-compose.yml"),
      updatesDir: updates,
      exec,
    });
  }

  function manifest(): ReleaseManifest {
    const svc = (name: string) => ({
      name,
      image,
      digest: image,
      healthcheck: { type: "none" as const },
    });
    return {
      schemaVersion: 1,
      release: {
        gitSha: "0".repeat(40),
        builtAt: "2026-09-23T00:00:00Z",
        channel: "stage",
        minOrchestratorSchema: 1,
      },
      services: [svc("web"), svc("orchestrator")],
      configs: { file: "configs.tar.gz", sha256: "0".repeat(64) },
    };
  }

  beforeAll(async () => {
    request = dockerSocketRequest(SOCK);
    image = ((await json("GET", `/images/${encodeURIComponent(VEHICLE)}/json`)) as { Id: string }).Id;
    // Under $HOME: colima shares it with the VM that is the "host" here.
    mkdirSync(path.join(homedir(), ".cache"), { recursive: true });
    root = mkdtempSync(path.join(homedir(), ".cache", "ota-e2e-"));
    updates = path.join(root, "updates");
    project = `otae2e${path.basename(root).slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    mkdirSync(path.join(root, "docker/ota"), { recursive: true });
    mkdirSync(path.join(root, "docker/ctx"), { recursive: true });
    writeFileSync(path.join(root, "docker/ctx/Dockerfile"), "FROM scratch\n");
    copyFileSync(path.join(REPO, "docker/ota/apply-update.sh"), path.join(root, "docker/ota/apply-update.sh"));
    writeFileSync(path.join(root, ".env"), "E2E_SECRET=from-host-dotenv\n");
    const envFile = "    env_file:\n      - path: ../.env\n        required: false\n";
    writeFileSync(
      path.join(root, "docker/docker-compose.yml"),
      // Top-level name: never collide with a real local stack ("docker").
      `name: ${project}\nservices:\n` +
        `  web:\n    build: { context: ./ctx }\n    command: ["sleep", "3600"]\n${envFile}` +
        `  orchestrator:\n    build: { context: ./ctx }\n` +
        // "Listens" only after a 4 s boot, like the orchestrator's
        // migrations + boot before server.listen (WARP-3017).
        `    command: ["sh", "-c", "sleep 4; touch /tmp/listening; sleep 3600"]\n${envFile}` +
        `    healthcheck:\n      test: ["CMD", "test", "-f", "/tmp/listening"]\n` +
        `      interval: 1s\n      timeout: 1s\n      retries: 60\n`,
    );
  });

  afterAll(async () => {
    if (!request) return;
    for (const svc of ["web", "orchestrator"]) {
      const id = await containerOf(svc).catch(() => undefined);
      if (id) await request("DELETE", `/containers/${id}?force=1`).catch(() => undefined);
    }
    for (const id of ["du-e2e-ok", "du-e2e-rb"]) {
      await request("DELETE", `/containers/droplet-ota-self-swap-${id}?force=1`).catch(() => undefined);
    }
    // The one-shot runs as root on the host, so its files are root-owned.
    await request("POST", "/containers/create", {
      Image: image,
      Cmd: ["rm", "-rf", `/host${root}`],
      HostConfig: { Binds: [`${root}:/host${root}`], AutoRemove: true },
    }).then(async (r) => {
      const { Id } = JSON.parse(r.body.toString("utf8")) as { Id: string };
      await request("POST", `/containers/${Id}/start`);
      await request("POST", `/containers/${Id}/wait`);
    }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("recreated services keep the host .env; the self-swap waits for listen", async () => {
    const r = runner("30");
    const updateId = "du-e2e-ok";
    await r.snapshot({
      updateId,
      manifest: manifest(),
      previousRefs: { web: image, orchestrator: image },
    });
    await r.recreateServices({ updateId, services: ["web"], target: "release" });
    expect(await envOf("web")).toContain("E2E_SECRET=from-host-dotenv");

    const started = Date.now();
    await r.recreateSelfDetached({ updateId, target: "release" });
    const sup = await waitSupervisor(updateId);
    expect(sup.code, sup.logs).toBe(0);
    expect(sup.logs).toContain("swap holds");
    // It waited for the 4 s "boot" instead of judging the container early.
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    expect(await envOf("orchestrator")).toContain("E2E_SECRET=from-host-dotenv");
  }, 120_000);

  it("never listening in time → configs restored, the restored helper rolls everything back", async () => {
    const r = runner("2"); // 2 × 1 s < the 4 s boot
    const updateId = "du-e2e-rb";
    await r.snapshot({
      updateId,
      manifest: manifest(),
      previousRefs: { web: image, orchestrator: image },
    });
    await r.recreateSelfDetached({ updateId, target: "release" });
    const sup = await waitSupervisor(updateId);
    expect(sup.logs).toContain("never went healthy");
    expect(sup.logs).toContain(`restore-configs ${updateId}`);
    expect(sup.logs).toContain("recreate-services [web,orchestrator] target=previous");
    expect(sup.code, sup.logs).toBe(0);
    expect(await envOf("web")).toContain("E2E_SECRET=from-host-dotenv");
    expect(await envOf("orchestrator")).toContain("E2E_SECRET=from-host-dotenv");
  }, 120_000);
});
