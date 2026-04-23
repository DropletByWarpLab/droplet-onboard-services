/**
 * LLM tool registry.
 *
 * Each entry wraps a single read- or write-action the local LLM can
 * invoke: listing network devices, searching Nextcloud, scanning for
 * cameras, and so on. Handlers call the service-layer functions
 * directly (no HTTP round-trip back through our own API) so the agent
 * loop is fast and doesn't need to re-authenticate against ourselves.
 *
 * Scope today (Phase-1):
 *   Network  — list devices + DHCP leases, wifi info, block/unblock.
 *   Files    — list, search, recents.
 *   Cameras  — list, discovered, recent events, scan, accept.
 *   System   — rolled-up health, storage drives.
 *
 * Write tools are present but deliberately narrow. Anything destructive
 * (delete camera, remove share, forget lease) is intentionally NOT in
 * the registry and must be added explicitly with an audit-log hook.
 *
 * Adding a tool:
 *   1. Pick the right file section below.
 *   2. Define `parameters` as a JSON-Schema object — OpenAI/LiteLLM
 *      forwards it to the model unchanged.
 *   3. Implement `handler` returning JSON-serialisable data. Keep the
 *      response compact (models burn context on long JSON) and prefer
 *      human-friendly shapes over raw DB rows.
 */

import type { PrismaClient } from "@prisma/client";
import * as openwrt from "./openwrt.client.js";
import * as nc from "./nextcloud.client.js";
import * as frigate from "./frigate.client.js";
import * as healthMonitor from "./health-monitor.service.js";
import * as docker from "./docker-control.service.js";
import { config } from "../config.js";
import type { ToolDefinition } from "../types/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolContext {
  prisma: PrismaClient;
  /** Username of the caller, if an auth cookie was present. */
  userId?: string;
  /** Nextcloud session token (from resolveNcToken). Required only for the
   *  file tools — other tools work without it. */
  ncToken?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

// Small utility: convert the registry into the tools[] payload the
// model's API expects (OpenAI "function-calling" shape).
export function toolsForModel(): ToolDefinition[] {
  return Object.values(TOOL_REGISTRY).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = TOOL_REGISTRY[name];
  if (!tool) {
    return { error: `unknown_tool: ${name}` };
  }
  try {
    return await tool.handler(args, ctx);
  } catch (err) {
    // Tool errors are returned as data, not thrown — the model decides
    // whether to retry, explain, or give up.
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

const list_network_devices: Tool = {
  name: "list_network_devices",
  description:
    "List every device the router has seen on the LAN, with MAC, IP, " +
    "hostname, vendor (from OUI lookup), presence status, and whether it " +
    "is currently blocked by the firewall.",
  parameters: {
    type: "object",
    properties: {
      online_only: {
        type: "boolean",
        description: "If true, only return devices seen in the last 15 minutes.",
      },
    },
  },
  handler: async (args, ctx) => {
    const onlineOnly = args.online_only === true;
    const devices = await ctx.prisma.networkDevice.findMany({
      orderBy: { lastSeen: "desc" },
      take: 100,
    });
    const cutoff = Date.now() - 15 * 60 * 1000;
    return devices
      .filter((d) => !onlineOnly || (d.lastSeen && d.lastSeen.getTime() > cutoff))
      .map((d) => ({
        mac: d.mac,
        ip: d.lastIp,
        hostname: d.hostname,
        vendor: d.vendor,
        name: d.displayName,
        last_seen: d.lastSeen?.toISOString() ?? null,
        is_blocked: d.isBlocked,
      }));
  },
};

const list_dhcp_leases: Tool = {
  name: "list_dhcp_leases",
  description:
    "Return the router's live DHCP lease table. Useful when you need " +
    "current IPs that haven't yet been correlated with the device database " +
    "(for example, a camera that just joined the cameras VLAN).",
  parameters: { type: "object", properties: {} },
  handler: async () => {
    const leases = await openwrt.fetchDhcpLeases();
    // DhcpLease fields are macaddr/ipaddr/expire (see types/network.ts) —
    // the UCI column names, not our prettier ones.
    return leases.map((l) => ({
      mac: l.macaddr,
      ip: l.ipaddr,
      hostname: l.hostname,
      expires: l.expire,
    }));
  },
};

const get_wifi_info: Tool = {
  name: "get_wifi_info",
  description:
    "Return the current Wi-Fi SSID, channel, encryption mode, and the " +
    "list of associated wireless clients.",
  parameters: { type: "object", properties: {} },
  handler: async () => {
    const [status, clients] = await Promise.all([
      openwrt.fetchWirelessStatus(),
      openwrt.fetchWirelessClients("wlan0").catch(() => []),
    ]);
    return {
      status,
      client_count: clients.length,
      clients: clients.slice(0, 50),
    };
  },
};

const block_device: Tool = {
  name: "block_device",
  description:
    "Block a device from accessing the LAN / internet by adding a MAC-filter " +
    "rule on the router. The device keeps its DHCP lease but drops all " +
    "forwarded traffic until unblock_device is called.",
  parameters: {
    type: "object",
    properties: {
      mac: {
        type: "string",
        description: "Device MAC address, e.g. 80:d2:1d:dc:8b:d3",
      },
      reason: {
        type: "string",
        description: "Human-readable reason for the audit log.",
      },
    },
    required: ["mac"],
  },
  handler: async (args, ctx) => {
    const mac = String(args.mac).toLowerCase();
    const device = await ctx.prisma.networkDevice.findUnique({
      where: { mac },
    });
    if (!device) {
      return { error: `unknown_device: ${mac}` };
    }
    // Write Prisma FIRST, then OpenWrt. The ordering is chosen so that a
    // failure between the two steps is the safer direction: DB says
    // "blocked" but router hasn't applied the rule yet. The device-
    // reconcile-poller re-dispatches `isBlocked` to the router on its
    // next pass, so the block heals automatically. The opposite order
    // (OpenWrt first, then Prisma) would leave a live MAC-filter rule
    // with no DB record, and the reconciler would try to REMOVE it on
    // the next pass, leaving the device un-blocked without anyone
    // noticing.
    await ctx.prisma.networkDevice.update({
      where: { mac },
      data: { isBlocked: true },
    });
    try {
      await openwrt.blockDevice(mac, (args.reason as string) ?? device.displayName ?? "llm");
    } catch (err) {
      // Surface the error but leave isBlocked=true; the reconciler will
      // retry. Model sees the error and can explain to the user.
      return {
        mac,
        blocked: true,
        pending_router_apply: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { mac, blocked: true, device_name: device.displayName };
  },
};

const unblock_device: Tool = {
  name: "unblock_device",
  description:
    "Remove a MAC-filter block previously added by block_device. No-op if " +
    "the device was not blocked.",
  parameters: {
    type: "object",
    properties: {
      mac: { type: "string", description: "Device MAC address." },
    },
    required: ["mac"],
  },
  handler: async (args, ctx) => {
    const mac = String(args.mac).toLowerCase();
    await openwrt.unblockDevice(mac);
    await ctx.prisma.networkDevice.update({
      where: { mac },
      data: { isBlocked: false },
    }).catch(() => undefined); // OK if the device isn't in our DB
    return { mac, blocked: false };
  },
};

// ---------------------------------------------------------------------------
// Nextcloud files
// ---------------------------------------------------------------------------

const list_files: Tool = {
  name: "list_files",
  description:
    "List files and folders inside a Nextcloud path (default: root). Returns " +
    "name, path, size in bytes, mtime, and a 'is_dir' flag. Use search_files " +
    "for keyword lookup across the whole drive.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Folder path (default '/'). Example: '/Photos/2026'.",
      },
    },
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const path = (args.path as string) || "/";
    const items = await nc.ncListFiles(ctx.ncToken, ctx.userId, path);
    return items.slice(0, 200).map((f) => ({
      name: f.name,
      path: f.path,
      is_dir: f.isDirectory,
      size: f.size,
      mtime: f.modifiedAt,
      mime: f.mimeType,
    }));
  },
};

const search_files: Tool = {
  name: "search_files",
  description:
    "Search Nextcloud by filename (substring, case-insensitive). For " +
    "full-text semantic search across document content use search_content.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term." },
    },
    required: ["query"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const results = await nc.ncSearchFiles(ctx.ncToken, ctx.userId, {
      query: String(args.query),
      limit: 50,
    });
    return results;
  },
};

const list_recent_files: Tool = {
  name: "list_recent_files",
  description: "List the 30 most recently modified files across Nextcloud.",
  parameters: { type: "object", properties: {} },
  handler: async (_args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const items = await nc.ncListRecents(ctx.ncToken, ctx.userId, 30);
    return items;
  },
};

// ---------------------------------------------------------------------------
// Cameras / NVR
// ---------------------------------------------------------------------------

const list_cameras: Tool = {
  name: "list_cameras",
  description:
    "List every camera currently configured in Frigate, with its name, " +
    "detection/recording state, and last-seen motion timestamp.",
  parameters: { type: "object", properties: {} },
  handler: async () => {
    const raw = await frigate.fetchCameras();
    return Object.entries(raw).map(([name, cfg]) => {
      const c = cfg as Record<string, unknown>;
      return {
        name,
        enabled: c.enabled ?? true,
        detect: (c.detect as { enabled?: boolean })?.enabled ?? null,
        record: (c.record as { enabled?: boolean })?.enabled ?? null,
      };
    });
  },
};

const list_discovered_cameras: Tool = {
  name: "list_discovered_cameras",
  description:
    "List IP cameras the camera-discovery service has found on the cameras " +
    "VLAN but that have NOT yet been accepted into Frigate. Use " +
    "accept_discovered_camera (with the camera id) to add one.",
  parameters: { type: "object", properties: {} },
  handler: async (_args, ctx) => {
    const pending = await ctx.prisma.camera.findMany({
      where: { enabled: false, autoDiscovered: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return pending.map((c) => ({
      id: c.id,
      name: c.name,
      ip: c.ipAddress,
      mac: c.macAddress,
      manufacturer: c.manufacturer,
      model: c.model,
      discovered_at: c.createdAt.toISOString(),
    }));
  },
};

const list_recent_camera_events: Tool = {
  name: "list_recent_camera_events",
  description:
    "Fetch the most recent Frigate detection events (motion/person/car/etc). " +
    "Default 20 events. Use camera_name to filter to one camera.",
  parameters: {
    type: "object",
    properties: {
      camera_name: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  handler: async (args) => {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const events = await frigate.fetchEvents(
      limit,
      args.camera_name as string | undefined,
    );
    return events;
  },
};

const scan_for_cameras: Tool = {
  name: "scan_for_cameras",
  description:
    "Kick an on-demand ONVIF + RTSP scan on the cameras VLAN. Returns " +
    "immediately; call list_discovered_cameras a few seconds later to see " +
    "what showed up.",
  parameters: { type: "object", properties: {} },
  handler: async () => {
    const resp = await fetch(`${config.CAMERA_DISCOVERY_URL}/scan`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      return { error: `scan failed (${resp.status})` };
    }
    return { status: "scan_started" };
  },
};

const accept_discovered_camera: Tool = {
  name: "accept_discovered_camera",
  description:
    "Accept a discovered camera into the Frigate config so it starts " +
    "recording. Pass the `id` from list_discovered_cameras (NOT the mac " +
    "— id is the orchestrator's internal camera primary key).",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Camera id from list_discovered_cameras." },
    },
    required: ["id"],
  },
  handler: async (args, ctx) => {
    const camera = await ctx.prisma.camera.update({
      where: { id: String(args.id) },
      data: { enabled: true },
    });
    return { status: "accepted", camera: camera.name };
  },
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

const get_system_health: Tool = {
  name: "get_system_health",
  description:
    "Rolled-up health of every component the orchestrator tracks: DB, " +
    "Redis, MQTT, router, Frigate, ai-gateway, and so on. Use when the user " +
    "asks 'is the system OK?' or wants to diagnose which service is down.",
  parameters: { type: "object", properties: {} },
  handler: async () => {
    return await healthMonitor.getAggregateHealth();
  },
};

const list_drives: Tool = {
  name: "list_drives",
  description:
    "List every data drive mounted under /mnt on the Jetson — NVMe " +
    "partitions (cameras, cloud-storage) plus any hot-plugged USB drives. " +
    "Returns device, mount point, label, total/used/free bytes.",
  parameters: { type: "object", properties: {} },
  handler: async () => {
    // Hit the device-bridge on the host. The bridge is the only component
    // that sees host /proc/mounts + the automount state file. Try the
    // Docker-provided host alias first, fall back to the known Jetson LAN
    // IP; both paths must treat non-2xx as a failure too (bridge can be up
    // but serving 500 while the automount state is mid-rewrite).
    const candidates = [
      "http://host.docker.internal:9090/drives",
      "http://192.168.50.197:9090/drives",
    ];
    let lastErr = "device_bridge_unreachable";
    for (const url of candidates) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) {
          lastErr = `bridge_status_${res.status}`;
          continue;
        }
        return await res.json();
      } catch (err) {
        lastErr = err instanceof Error ? err.name : "fetch_failed";
        continue;
      }
    }
    return { error: lastErr };
  },
};

// ---------------------------------------------------------------------------
// Service control + logs (PR #5)
// ---------------------------------------------------------------------------
//
// These let the LLM help the user diagnose and bounce misbehaving services.
// restart_service is guarded by a denylist that EXCLUDES the orchestrator
// itself (would kill the in-flight LLM call), gateway/db/cache/broker (would
// cut off the user's session), and ai-gateway. See docker-control.service.ts.

const list_services: Tool = {
  name: "list_services",
  description:
    "List every Docker container on the Droplet with its current state and " +
    "status. Each result has `name`, `service` (compose service name), " +
    "`state` ('running'/'exited'/etc.), human-readable `status`, and a " +
    "`restartable` flag — if false, the model should NOT call restart_service " +
    "because it's in the denylist (orchestrator / gateway / db / cache / " +
    "broker / ai-gateway — restarting those would break this chat).",
  parameters: { type: "object", properties: {} },
  handler: async (_args, _ctx) => {
    try {
      const containers = await docker.listContainers();
      return {
        count: containers.length,
        services: containers.map((c) => ({
          name: c.name,
          service: c.service,
          state: c.state,
          status: c.status,
          image: c.image,
          restartable: c.restartable,
        })),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const restart_service: Tool = {
  name: "restart_service",
  description:
    "Restart a Droplet service by compose service name (e.g. 'frigate', " +
    "'homeassistant', 'file-indexer'). Sends SIGTERM then SIGKILL after 10s, " +
    "then starts the container again. Refuses to restart gateway, " +
    "orchestrator, ai-gateway, db, cache, broker — those are in the denylist. " +
    "Confirm with the user before calling; service bounces can take 30-60s.",
  parameters: {
    type: "object",
    properties: {
      service: { type: "string", description: "Compose service name (e.g. 'frigate')." },
    },
    required: ["service"],
  },
  handler: async (args, _ctx) => {
    try {
      const result = await docker.restartContainer(String(args.service ?? ""));
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const get_service_logs: Tool = {
  name: "get_service_logs",
  description:
    "Fetch the last N lines of a service's combined stdout+stderr. Useful " +
    "when the user asks 'why is frigate not detecting anything' or 'show me " +
    "the last errors from file-indexer'. Tail capped at 2000 lines / 256 KB.",
  parameters: {
    type: "object",
    properties: {
      service: { type: "string", description: "Compose service name." },
      tail: { type: "integer", minimum: 1, maximum: 2000, description: "Default 200." },
    },
    required: ["service"],
  },
  handler: async (args, _ctx) => {
    try {
      const result = await docker.containerLogs(
        String(args.service ?? ""),
        Number(args.tail) || 200,
      );
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOL_REGISTRY: Record<string, Tool> = Object.fromEntries(
  [
    list_network_devices,
    list_dhcp_leases,
    get_wifi_info,
    block_device,
    unblock_device,
    list_files,
    search_files,
    list_recent_files,
    list_cameras,
    list_discovered_cameras,
    list_recent_camera_events,
    scan_for_cameras,
    accept_discovered_camera,
    get_system_health,
    list_drives,
    // Service control + logs (PR #5)
    list_services,
    restart_service,
    get_service_logs,
  ].map((t) => [t.name, t]),
);
