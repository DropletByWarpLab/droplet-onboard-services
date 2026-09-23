/**
 * WARP-3007 — run the OTA helper ON THE HOST.
 *
 * The orchestrator image has no docker CLI, and compose run inside it cannot
 * read the host `.env`, so every recreated service silently lost its
 * `env_file` values. Decision (Romain, 2026-09-23, approach A): the whole
 * apply runs host-side. This module is the exec boundary that does it — an
 * `ExecFn` that, instead of `execFile`-ing locally, creates a ONE-SHOT
 * container over the orchestrator's docker socket:
 *
 *   image       this orchestrator's own image, pinned by image ID (already on
 *               the box, content-addressed, never pulled)
 *   network     none
 *   mounts      `/:/host`
 *   entrypoint  `chroot` → argv `/host /bin/bash <helper> <subcommand> …`
 *   env         an explicit allowlist (below) — never this process's env
 *
 * Inside the chroot the helper (docker/ota/apply-update.sh, shipped in every
 * release's configs.tar.gz) runs with the host's docker CLI, `.env` and boot
 * unit. Same pattern as #2320's reconcile-env.
 *
 * SECURITY: this grants nothing the socket mount does not already grant (a
 * docker socket is host root). What keeps it narrow is unchanged: argv only,
 * never a shell string; the helper's fixed subcommand surface; only a
 * cosign-verified manifest reaches the runner. See WARP-2924 (security review
 * of the host-execution model, pending).
 */
import http from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import type pino from "pino";
import { createLogger } from "../../lib/logger.js";
import type { ApplyRunner } from "./apply.js";
import { createHostComposeRunner, type ExecFn } from "./host-compose-runner.js";

const defaultLog = createLogger("update-agent");

/** One Docker Engine API round-trip. Injectable for tests. */
export type DockerRequest = (
  method: string,
  apiPath: string,
  body?: unknown,
  opts?: { timeoutMs?: number },
) => Promise<{ status: number; body: Buffer }>;

/** Docker Engine API over the unix socket — plain node:http, no dependency. */
export function dockerSocketRequest(socketPath = "/var/run/docker.sock"): DockerRequest {
  return (method, apiPath, body, opts) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath,
          method,
          path: apiPath,
          headers: payload
            ? { "content-type": "application/json", "content-length": payload.length }
            : {},
          // Idle timeout: /wait sends nothing until the container exits, so
          // this bounds the whole call.
          timeout: opts?.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error(`docker API ${method} ${apiPath} timed out`)),
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
}

/**
 * Split a non-TTY container log stream into stdout/stderr. Each frame is an
 * 8-byte header (stream byte, 3 zero bytes, uint32 BE length) + payload.
 */
export function demuxDockerLogs(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const stream = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const frame = buf.subarray(i + 8, i + 8 + len);
    if (stream === 2) err.push(frame);
    else out.push(frame);
    i += 8 + len;
  }
  return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

export interface HostExecContext {
  /** This orchestrator's image ID (`sha256:<hex>`) — the one-shot's image. */
  image: string;
  /** HOST path of the volume mounted at the orchestrator's updatesDir. */
  hostUpdatesDir: string;
}

const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;

/**
 * Inspect our own container: the pinned image ID and the host path behind
 * the updates volume (the helper runs on the host, so it needs host paths).
 */
export async function resolveHostExecContext(opts: {
  request: DockerRequest;
  updatesDir: string;
  /** Default: os.hostname(), which docker sets to the short container id. */
  containerId?: string;
}): Promise<HostExecContext> {
  const id = opts.containerId ?? hostname();
  const res = await opts.request("GET", `/containers/${encodeURIComponent(id)}/json`);
  if (res.status !== 200) {
    throw new Error(`cannot inspect the orchestrator's own container ${id}: HTTP ${res.status}`);
  }
  const info = JSON.parse(res.body.toString("utf8")) as {
    Image?: string;
    Mounts?: Array<{ Source?: string; Destination?: string }>;
  };
  if (typeof info.Image !== "string" || !IMAGE_ID_RE.test(info.Image)) {
    throw new Error(`orchestrator container reports an unexpected image id: ${String(info.Image)}`);
  }
  const source = info.Mounts?.find((m) => m.Destination === opts.updatesDir)?.Source;
  if (!source || !path.isAbsolute(source)) {
    throw new Error(`no volume is mounted at ${opts.updatesDir} on the orchestrator`);
  }
  return { image: info.Image, hostUpdatesDir: source };
}

/**
 * The host ExecFn. `file` is the helper's HOST path; `env` (per call) is
 * added to the fixed allowlist — the runner uses it for the registry token on
 * pull-images only, so the token never sits in any other container's config.
 */
export function createHostExec(opts: {
  request: DockerRequest;
  context: HostExecContext;
  /** Fixed allowlisted env for every call. */
  env: Record<string, string>;
  logger?: pino.Logger;
}): ExecFn {
  const log = opts.logger ?? defaultLog;
  const { request, context } = opts;
  return async (file, args, callOpts) => {
    const timeoutMs = callOpts?.timeoutMs ?? 120_000;
    const env = {
      ...opts.env,
      ...(callOpts?.env ?? {}),
      DROPLET_OTA_UPDATES_DIR: context.hostUpdatesDir,
      DROPLET_OTA_HOST_IMAGE: context.image,
    };
    const created = await request("POST", "/containers/create", {
      Image: context.image,
      Entrypoint: ["chroot"],
      Cmd: ["/host", "/bin/bash", file, ...args],
      User: "0:0",
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { "io.droplet.ota-host-exec": args[0] ?? "" },
      HostConfig: { Binds: ["/:/host"], NetworkMode: "none" },
    });
    if (created.status !== 201) {
      throw new Error(
        `OTA host exec: container create failed (HTTP ${created.status}): ${created.body.toString("utf8").slice(0, 300)}`,
      );
    }
    const id = (JSON.parse(created.body.toString("utf8")) as { Id: string }).Id;
    try {
      const started = await request("POST", `/containers/${id}/start`);
      if (started.status !== 204 && started.status !== 304) {
        throw new Error(`OTA host exec: container start failed (HTTP ${started.status})`);
      }
      let exitCode: number;
      try {
        const waited = await request("POST", `/containers/${id}/wait`, undefined, { timeoutMs });
        exitCode = (JSON.parse(waited.body.toString("utf8")) as { StatusCode: number }).StatusCode;
      } catch (err) {
        await request("POST", `/containers/${id}/kill`).catch(() => undefined);
        throw new Error(
          `OTA host exec: ${args[0]} did not finish within ${timeoutMs} ms (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      const logs = await request("GET", `/containers/${id}/logs?stdout=1&stderr=1`);
      const { stdout, stderr } = demuxDockerLogs(logs.body);
      if (exitCode !== 0) {
        // Same shape defaultExec gives: callers read err.stdout (the
        // structured {"failed":[…]} list) and err.stderr (image-verify:).
        const err = new Error(
          `OTA host helper ${args[0]} exited ${exitCode}: ${stderr.trim().split("\n").at(-1) ?? ""}`,
        ) as Error & { stdout?: string; stderr?: string };
        err.stdout = stdout;
        err.stderr = stderr;
        throw err;
      }
      return { stdout, stderr };
    } finally {
      await request("DELETE", `/containers/${id}?force=1`).catch((err: unknown) =>
        log.warn({ err, containerId: id }, "OTA host exec: could not remove the one-shot container"),
      );
    }
  };
}

export interface OtaHost {
  runner: ApplyRunner;
  exec: ExecFn;
  /** HOST path of the helper — always the release-shipped docker/ota copy. */
  helperPath: string;
}

let current: OtaHost | null = null;

/** The provisioned OTA host surface, or null when apply is off on this box. */
export function getOtaHost(): OtaHost | null {
  return current;
}

/**
 * Boot wiring (index.ts). Resolves the host context once and builds the
 * runner every OTA caller shares (apply window, resume, apply-now, helper
 * GC). Any failure leaves apply OFF with a loud log — the poller still runs.
 */
export async function initOtaHost(opts: {
  composeFile: string;
  configRoot: string;
  updatesDir: string;
  githubToken?: string;
  request?: DockerRequest;
  logger?: pino.Logger;
}): Promise<OtaHost | null> {
  const log = opts.logger ?? defaultLog;
  const request = opts.request ?? dockerSocketRequest();
  const configRoot = opts.configRoot || path.dirname(path.dirname(opts.composeFile));
  try {
    const context = await resolveHostExecContext({ request, updatesDir: opts.updatesDir });
    const env: Record<string, string> = { DROPLET_OTA_CONFIG_ROOT: configRoot };
    for (const k of [
      "DROPLET_OTA_SELF_HEALTH_ATTEMPTS",
      "DROPLET_OTA_SELF_HEALTH_INTERVAL_SECONDS",
    ] as const) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    const exec = createHostExec({ request, context, env, logger: log });
    const helperPath = path.join(configRoot, "docker", "ota", "apply-update.sh");
    const runner = createHostComposeRunner({
      scriptPath: helperPath,
      composeFile: opts.composeFile,
      updatesDir: opts.updatesDir,
      helperUpdatesDir: context.hostUpdatesDir,
      githubToken: opts.githubToken,
      exec,
      logger: log,
    });
    current = { runner, exec, helperPath };
    log.info(
      { event: "update.host_exec_ready", image: context.image, helperPath },
      "OTA apply provisioned — helper runs on the host",
    );
  } catch (err) {
    current = null;
    log.error(
      { event: "update.host_exec_unavailable", err: err instanceof Error ? err.message : String(err) },
      "OTA apply is enabled but the host exec context could not be resolved — apply stays OFF",
    );
  }
  return current;
}
