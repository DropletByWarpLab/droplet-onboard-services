/**
 * WARP-3504 (ADR-068) — where each heartbeat fact comes from. Every source is
 * one the box already reads for its own pages; nothing here reaches into
 * customer data. Collectors return primitives and enums only (builders.ts
 * turns them into the wire shape), and each degrades on its own: a missing
 * Docker socket gives no services, an idle GPU gives no card, never a zero.
 *
 *   release      newest committed DeviceUpdate (tag, sha, channel), else the
 *                factory image on the update agent's persisted channel
 *   os           Docker Engine `/info` (the HOST's kernel and distro; the
 *                orchestrator's own container reports Debian)
 *   uptime       os.uptime() (host-wide: /proc/uptime is not namespaced)
 *   services     Docker Engine API over the socket the OTA agent already
 *                uses: compose-labelled containers, inspected for health and
 *                restart count
 *   cpu / mem    node:os (host-wide, /proc/stat and /proc/meminfo)
 *   disk         statfs of the OTA volume: the system disk
 *   network      /proc/net/dev of this container: bytes crossing the Droplet
 *                control plane's own interface (not the whole LAN)
 *   gpu          the host device-bridge GET /gpu (the Models page source)
 *   activity     COUNT queries over ChatMessage, AgentRun, ActivityRow and
 *                DeviceUpdate; OTA checks and log classes from the sender
 */
import * as os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import type { DockerRequest } from "../update-agent/host-exec.js";
import { getUpdateAgentSettings } from "../update-agent/settings.js";
import type { GpuTelemetry } from "../../lib/gpu-telemetry.js";
import { SERVICE_NAME_RE, type ServiceHealth, type ServiceState } from "./contract.js";
import type { HeartbeatFacts } from "./builders.js";

export interface ContainerFact {
  name: string;
  state: ServiceState;
  health: ServiceHealth;
  restarts: number;
  exitCode: number | null;
}

const DOCKER_STATES: Readonly<Record<string, ServiceState>> = {
  running: "running",
  exited: "exited",
  restarting: "restarting",
  created: "created",
  paused: "paused",
  dead: "dead",
  // Being removed: the closest state the contract has.
  removing: "exited",
};
const DOCKER_HEALTH: Readonly<Record<string, ServiceHealth>> = {
  healthy: "healthy",
  unhealthy: "unhealthy",
  starting: "starting",
};
const INSPECT_CONCURRENCY = 8;

async function dockerJson<T>(request: DockerRequest, apiPath: string): Promise<T | null> {
  const res = await request("GET", apiPath, undefined, { timeoutMs: 10_000 });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`docker API ${apiPath.split("?")[0]} answered ${res.status}`);
  return JSON.parse(res.body.toString("utf8")) as T;
}

interface ListEntry {
  Id: string;
  State?: string;
  Labels?: Record<string, string>;
}
interface Inspect {
  RestartCount?: number;
  State?: { Status?: string; ExitCode?: number; Health?: { Status?: string } };
}

/**
 * Every compose service container: state, health, restart count, last exit
 * code. Throws when the Docker socket cannot be reached (the caller treats
 * that as "no container data this tick").
 */
export async function readContainers(request: DockerRequest): Promise<ContainerFact[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: ["com.docker.compose.service"] }));
  const list = (await dockerJson<ListEntry[]>(request, `/containers/json?all=1&filters=${filters}`)) ?? [];
  const wanted = list.flatMap((c) => {
    const name = c.Labels?.["com.docker.compose.service"] ?? "";
    // One-shot `compose run` containers are not services. Names are the
    // compose file's own (static), pinned to the contract's name shape.
    if (!SERVICE_NAME_RE.test(name) || c.Labels?.["com.docker.compose.oneoff"] === "True") return [];
    return [{ id: c.Id, name }];
  });
  const out = new Map<string, ContainerFact>();
  for (let i = 0; i < wanted.length; i += INSPECT_CONCURRENCY) {
    const facts = await Promise.all(
      wanted.slice(i, i + INSPECT_CONCURRENCY).map(async ({ id, name }): Promise<ContainerFact | null> => {
        const c = await dockerJson<Inspect>(request, `/containers/${encodeURIComponent(id)}/json`);
        const state = DOCKER_STATES[c?.State?.Status ?? ""];
        if (!c || !state) return null; // gone since the list, or a state the contract has no name for
        return {
          name,
          state,
          health: DOCKER_HEALTH[c.State?.Health?.Status ?? ""] ?? "none",
          restarts: c.RestartCount ?? 0,
          exitCode: typeof c.State?.ExitCode === "number" ? c.State.ExitCode : null,
        };
      }),
    );
    // ponytail: one container per compose service in this stack; the first wins if that ever changes.
    for (const f of facts) if (f && !out.has(f.name)) out.set(f.name, f);
  }
  return [...out.values()];
}

const printable = (s: unknown): string => {
  const t = typeof s === "string" ? s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 128) : "";
  return t || "unknown";
};

/** The HOST's kernel and distro from Docker Engine `/info`. */
export async function readHostOs(request: DockerRequest): Promise<{ kernel: string; distro: string }> {
  const info = await dockerJson<{ KernelVersion?: string; OperatingSystem?: string }>(request, "/info");
  return { kernel: printable(info?.KernelVersion), distro: printable(info?.OperatingSystem) };
}

/** Percent busy; the first call is the average since boot, later calls the interval since the previous one. */
export function createCpuSampler(cpus: () => os.CpuInfo[] = os.cpus): () => number {
  let prev = { idle: 0, total: 0 };
  return () => {
    let idle = 0;
    let total = 0;
    for (const { times: t } of cpus()) {
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    const dTotal = total - prev.total;
    const dIdle = idle - prev.idle;
    prev = { idle, total };
    return dTotal > 0 ? (100 * (dTotal - dIdle)) / dTotal : 0;
  };
}

export const memPct = (total = os.totalmem(), free = os.freemem()): number =>
  total > 0 ? (100 * (total - free)) / total : 0;

/** Same figure as `df`: used / (used + available to unprivileged users). */
export async function readDiskPct(
  paths: readonly string[],
  statfsFn: typeof statfs = statfs,
): Promise<number> {
  let last: unknown = new Error("no path to measure");
  for (const p of paths) {
    try {
      const s = await statfsFn(p);
      const used = s.blocks - s.bfree;
      if (used + s.bavail > 0) return (100 * used) / (used + s.bavail);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** Sum of received and transmitted bytes over every interface but loopback. */
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of text.split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest || name.trim() === "lo") continue;
    const f = rest.trim().split(/\s+/).map(Number);
    if (f.length >= 9 && Number.isFinite(f[0]) && Number.isFinite(f[8])) {
      rx += f[0];
      tx += f[8];
    }
  }
  return { rx, tx };
}

/** At most one card, and only when all four counters are known (a null is not a zero). */
export function gpuFacts(t: GpuTelemetry | null): HeartbeatFacts["usage"]["gpus"] {
  if (
    !t?.available ||
    t.busyPercent === null ||
    t.vramUsedBytes === null ||
    t.vramTotalBytes === null ||
    t.tempC === null
  ) {
    return [];
  }
  const mb = (bytes: number) => bytes / (1024 * 1024);
  return [
    {
      utilPct: t.busyPercent,
      vramUsedMb: mb(t.vramUsedBytes),
      vramTotalMb: mb(t.vramTotalBytes),
      tempC: t.tempC,
    },
  ];
}

/** COUNT queries over the window. Counts only: no row content is read, no id leaves. */
export async function readActivityCounts(prisma: PrismaClient, from: Date) {
  const [chatTurns, agentRuns, actors, downloads, applies, rollbacks, failures] = await Promise.all([
    prisma.chatMessage.count({ where: { role: "user", kind: "message", createdAt: { gte: from } } }),
    prisma.agentRun.count({ where: { createdAt: { gte: from } } }),
    // Distinct actors only to count them; the ids stay in this function.
    prisma.activityRow.findMany({
      where: { at: { gte: from }, actorType: "user", actorId: { not: null } },
      distinct: ["actorId"],
      select: { actorId: true },
    }),
    prisma.deviceUpdate.count({ where: { createdAt: { gte: from } } }),
    prisma.deviceUpdate.count({ where: { status: "committed", updatedAt: { gte: from } } }),
    prisma.deviceUpdate.count({ where: { status: "rolled_back", updatedAt: { gte: from } } }),
    prisma.deviceUpdate.count({ where: { status: { in: ["failed", "rejected"] }, updatedAt: { gte: from } } }),
  ]);
  return { chatTurns, agentRuns, activeUsers: actors.length, downloads, applies, rollbacks, failures };
}

/** The installed release, or the factory image on the update agent's channel. */
export async function readRelease(prisma: PrismaClient): Promise<HeartbeatFacts["release"]> {
  const row = await prisma.deviceUpdate.findFirst({
    where: { status: "committed" },
    orderBy: { updatedAt: "desc" },
    select: { releaseTag: true, gitSha: true, channel: true },
  });
  const settings = await getUpdateAgentSettings(prisma);
  const channel = [row?.channel, settings.channel].find((c) => c === "stage" || c === "stable");
  return {
    // A committed row with no tag is labelled as the health page labels it.
    tag: row ? (row.releaseTag ?? `git-${row.gitSha.slice(0, 10)}`) : null,
    gitSha: row?.gitSha ?? null,
    channel: channel === "stage" ? "stage" : "stable",
  };
}

/** What the sender hands the collector for one heartbeat window. */
export interface HeartbeatWindow {
  now: Date;
  windowSec: number;
  otaChecks: number;
  /** Releases the poller fetched but refused to track (no DeviceUpdate row exists for them). */
  otaVerifyFailures: number;
}

export interface CollectorDeps {
  prisma: PrismaClient;
  /** Null when there is no Docker socket (dev, CI). */
  docker: DockerRequest | null;
  fetchGpu: () => Promise<GpuTelemetry | null>;
  /** Paths tried in order for the system disk. */
  diskPaths: readonly string[];
}

export function createCollectors(deps: CollectorDeps) {
  const cpuPct = createCpuSampler();
  return {
    /** Null when Docker cannot be read this time. */
    async containers(): Promise<ContainerFact[] | null> {
      if (!deps.docker) return null;
      return readContainers(deps.docker).catch(() => null);
    },
    async heartbeat(w: HeartbeatWindow): Promise<HeartbeatFacts> {
      const from = new Date(w.now.getTime() - w.windowSec * 1000);
      const [release, hostOs, containers, disk, net, gpu, counts] = await Promise.all([
        readRelease(deps.prisma),
        deps.docker ? readHostOs(deps.docker).catch(() => null) : null,
        deps.docker ? readContainers(deps.docker).catch(() => []) : [],
        readDiskPct(deps.diskPaths),
        readFile("/proc/net/dev", "utf8").then(parseNetDev),
        deps.fetchGpu(),
        readActivityCounts(deps.prisma, from),
      ]);
      const uptimeSec = os.uptime();
      return {
        now: w.now,
        release,
        os: hostOs ?? { kernel: printable(os.release()), distro: "unknown" },
        bootedAt: new Date(w.now.getTime() - uptimeSec * 1000),
        uptimeSec,
        services: containers.map(({ exitCode: _exitCode, ...service }) => service),
        usage: {
          cpuPct: cpuPct(),
          memPct: memPct(),
          diskPct: disk,
          netRxBytes: net.rx,
          netTxBytes: net.tx,
          gpus: gpuFacts(gpu),
        },
        activity: {
          windowSec: w.windowSec,
          chatTurns: counts.chatTurns,
          agentRuns: counts.agentRuns,
          activeUsers: counts.activeUsers,
          ota: {
            checks: w.otaChecks,
            downloads: counts.downloads,
            applies: counts.applies,
            rollbacks: counts.rollbacks,
            failures: counts.failures + w.otaVerifyFailures,
          },
          // The sender fills this from its own log aggregate after a successful collect.
          errorsByClass: {},
        },
      };
    },
  };
}
