/**
 * Docker socket client for the service-control LLM tools (PR #5).
 *
 * Talks directly to the host Docker daemon via /var/run/docker.sock — no
 * shell-out, no exec, no PATH dependency. Uses node:http with `socketPath`
 * so we don't pull in dockerode just for three calls.
 *
 * Whitelist policy:
 *   The orchestrator itself, the API gateway (nginx), the database, the
 *   cache, the MQTT broker, and the ai-gateway are NEVER restartable via
 *   this surface — restarting any of them mid-call would either cut off
 *   the in-flight LLM agent loop or break the very session that issued
 *   the command. They're enumerated in SERVICE_RESTART_DENYLIST below.
 *
 * Whitelist vs. denylist: a denylist is safer here because new compose
 * services should default to "restartable by the user via the LLM" — most
 * additions are optional features the user wants to bounce when something
 * misbehaves. The few that would self-foot-gun are well-known.
 */

import http from "node:http";
import pino from "pino";

const logger = pino({ name: "docker-control" });

const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";

/** Containers that the LLM is NEVER allowed to restart. Names are the
 *  Docker compose service names (also the prefix of the container name). */
export const SERVICE_RESTART_DENYLIST = new Set([
  "orchestrator",  // restarting the orchestrator would kill the LLM mid-call
  "gateway",       // nginx — kills the user's HTTP session
  "db",            // postgres — orchestrator hard-depends on it
  "cache",         // redis — same
  "broker",        // mosquitto — kills MQTT events including ws-bridge
  "ai-gateway",    // would terminate the in-flight inference call
]);

/** Container name validation. Compose uses `<project>_<service>_<n>` or
 *  `<project>-<service>-<n>`; the service name we receive should be the
 *  short form. Accept lowercase letters, digits, hyphens, underscores,
 *  dots; reject anything that could land in a shell or SQL boundary. */
const CONTAINER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function isValidContainerName(name: string): boolean {
  return typeof name === "string" && CONTAINER_NAME_RE.test(name);
}

interface DockerError extends Error {
  statusCode?: number;
}

/** Send a request to the Docker daemon over the Unix socket and return
 *  the parsed JSON response. Streams aren't supported here — used by
 *  list/restart only; logs has its own path because it needs the body
 *  intact (Docker's log multiplex framing). */
async function dockerRequest<T = unknown>(
  method: "GET" | "POST",
  path: string,
  bodyJson?: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const body = bodyJson === undefined ? undefined : JSON.stringify(bodyJson);
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        headers: {
          ...(body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : {}),
        },
        // Each request gets its own socket. Keep-alive on Unix sockets to a
        // local Docker daemon doesn't gain anything (sub-millisecond connect)
        // and causes EPIPE when a kept-alive socket is reused after the
        // daemon closed it.
        agent: false,
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
            const err: DockerError = new Error(`docker ${res.statusCode}: ${text.slice(0, 200)}`);
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }
          if (text.length === 0) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("docker_socket_timeout"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

interface RawContainer {
  Id: string;
  Names: string[];                // Each starts with "/"
  Image: string;
  State: string;                  // "running" | "exited" | etc.
  Status: string;                 // "Up 2 hours" / "Exited (0) 5 minutes ago"
  Labels?: Record<string, string>;
  Created: number;
}

export interface ContainerInfo {
  id: string;
  name: string;                   // Without leading slash
  service: string | null;         // From `com.docker.compose.service` label
  image: string;
  state: string;
  status: string;
  restartable: boolean;
  created_at: string;
}

/** List every container Docker knows about (running + stopped). */
export async function listContainers(): Promise<ContainerInfo[]> {
  const raw = await dockerRequest<RawContainer[]>("GET", "/containers/json?all=true");
  return raw.map((c) => {
    const name = (c.Names[0] ?? "").replace(/^\//, "");
    const service = c.Labels?.["com.docker.compose.service"] ?? null;
    return {
      id: c.Id,
      name,
      service,
      image: c.Image,
      state: c.State,
      status: c.Status,
      restartable: !SERVICE_RESTART_DENYLIST.has(service ?? name),
      created_at: new Date(c.Created * 1000).toISOString(),
    };
  });
}

/** Restart a container by name. Returns the resolved compose-service name
 *  if available so callers can confirm. Throws if the target is in the
 *  denylist or doesn't exist. */
export async function restartContainer(target: string): Promise<{ service: string; restarted: true }> {
  if (!isValidContainerName(target)) {
    throw new Error("invalid_container_name");
  }
  // Resolve target → real container. Accept either the compose service name
  // (matched against the label) or the literal Docker container name.
  const containers = await listContainers();
  const match = containers.find(
    (c) => c.service === target || c.name === target || c.name === `docker-${target}-1` || c.name === `docker_${target}_1`,
  );
  if (!match) throw new Error(`container_not_found: ${target}`);
  const resolvedService = match.service ?? match.name;
  if (SERVICE_RESTART_DENYLIST.has(resolvedService)) {
    throw new Error(`restart_blocked_by_denylist: ${resolvedService}`);
  }
  // POST /containers/{id}/restart?t=<seconds>. t=10 sends SIGTERM then waits
  // 10s before SIGKILL — matches `docker compose restart` defaults.
  await dockerRequest("POST", `/containers/${encodeURIComponent(match.id)}/restart?t=10`);
  logger.info({ service: resolvedService, container: match.name }, "container restarted");
  return { service: resolvedService, restarted: true };
}

/** Fetch the last N lines of a container's combined stdout+stderr.
 *
 *  Docker's log endpoint multiplexes stdout/stderr into 8-byte-header
 *  frames when the container has no TTY. We strip those headers so the
 *  return value is plain text. With TTY=true the body is already plain
 *  text (no framing) — we detect that by absence of the multiplex magic
 *  in the first few bytes. */
export async function containerLogs(
  target: string,
  tail = 200,
  maxBytes = 256 * 1024, // 256 KB cap — even verbose services rarely need more for triage
): Promise<{ service: string; logs: string; truncated: boolean }> {
  if (!isValidContainerName(target)) throw new Error("invalid_container_name");
  const tailN = Math.max(1, Math.min(2000, Number(tail) || 200));

  const containers = await listContainers();
  const match = containers.find(
    (c) => c.service === target || c.name === target || c.name === `docker-${target}-1` || c.name === `docker_${target}_1`,
  );
  if (!match) throw new Error(`container_not_found: ${target}`);
  const resolvedService = match.service ?? match.name;

  // Logs endpoint requires GET with stdout=1 and stderr=1.
  const path = `/containers/${encodeURIComponent(match.id)}/logs?stdout=1&stderr=1&tail=${tailN}&timestamps=0`;

  const buf = await new Promise<Buffer>((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET_PATH, path, method: "GET", agent: false, timeout: 15_000 },
      (res) => {
        if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`docker logs ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.byteLength;
          if (total > maxBytes) {
            // Cancel further reads — we have enough. The truncated flag
            // surfaces this to the caller.
            chunks.push(c.subarray(0, c.byteLength - (total - maxBytes)));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("close", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("docker_logs_timeout")));
    req.on("error", reject);
    req.end();
  });

  const text = stripMultiplexFraming(buf);
  return {
    service: resolvedService,
    logs: text,
    truncated: buf.byteLength >= maxBytes,
  };
}

/** Strip Docker's stream-multiplexing 8-byte headers. Each frame is:
 *    byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
 *    bytes 1..3: zero padding
 *    bytes 4..7: big-endian uint32 payload length
 *  If the buffer doesn't look multiplexed (TTY containers stream raw),
 *  return as-is. */
function stripMultiplexFraming(buf: Buffer): string {
  // Heuristic: a multiplexed buffer's byte 0 is 0/1/2 and byte 1-3 are 0.
  // Any other shape, treat as plain text.
  const looksMultiplexed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksMultiplexed) return buf.toString("utf8");

  const out: Buffer[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos + 4);
    const start = pos + 8;
    const end = start + len;
    if (end > buf.length) break; // truncated mid-frame, give up gracefully
    out.push(buf.subarray(start, end));
    pos = end;
  }
  return Buffer.concat(out).toString("utf8");
}
