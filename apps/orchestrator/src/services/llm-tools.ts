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

import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import * as openwrt from "./openwrt.client.js";
import * as nc from "./nextcloud.client.js";
import * as frigate from "./frigate.client.js";
import * as healthMonitor from "./health-monitor.service.js";
import { exportClip as exportClipSvc, signShareUrl } from "./clips.service.js";
import { config } from "../config.js";
import type { ToolDefinition } from "../types/index.js";

function parseModelDate(input: unknown): Date | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Path validation for Nextcloud-scoped write tools
//
// The LLM is driven by user-controlled prompt text (and any document the
// agent has just read). A malicious prompt — or a poisoned doc the agent
// pulled in via search_content — could try to coerce a write to '../etc/...'
// or '/' to delete the whole drive. WebDAV would reject most of these too,
// but defense-in-depth at the tool boundary costs nothing and gives us a
// clean error the model can show the user.
// ---------------------------------------------------------------------------

const MAX_PATH_LEN = 4096;
const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB cap on LLM-driven writes

function validateNcPath(
  input: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "path must be a string" };
  if (input.length === 0) return { ok: false, error: "path is required" };
  if (input.length > MAX_PATH_LEN) return { ok: false, error: "path too long" };
  if (input.includes("\0")) return { ok: false, error: "null byte in path" };

  // Iteratively percent-decode until a fixed point. Sabre/DAV (Nextcloud's
  // WebDAV layer) decodes percent escapes before resolving paths, so a literal
  // '%2e%2e' segment would slip past a naive '..' check and only get treated
  // as traversal once the server decoded it. Decoding here lets us reject
  // both '/foo/../bar' and '/foo/%2e%2e/bar' (and double-encoded variants)
  // with the same rule.
  let decoded = input;
  for (let i = 0; i < 4 && decoded.includes("%"); i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return { ok: false, error: "malformed percent-encoding in path" };
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("\0")) return { ok: false, error: "null byte in path" };
  // Reject traversal both in the raw and the fully-decoded form. Also reject
  // alt separators (backslash) that Nextcloud may treat as path separators
  // on some platforms.
  for (const candidate of [input, decoded]) {
    if (candidate.split(/[\\/]/).some((seg) => seg === "..")) {
      return { ok: false, error: "path traversal not allowed" };
    }
  }

  const normalized = path.posix.normalize(decoded.startsWith("/") ? decoded : "/" + decoded);
  // Root is a legitimate Nextcloud path (e.g. write_file may want to know that
  // a write to "/" has no filename, and create_directory wants to refuse it
  // with a clean message). Tools that don't accept root check `v.path === "/"`
  // explicitly. The empty-segment check below would otherwise reject "/" since
  // its split is `["", ""]`.
  if (normalized === "/") return { ok: true, path: "/" };
  if (normalized.split("/").slice(1).some((seg) => seg === "")) {
    return { ok: false, error: "empty path segment" };
  }
  return { ok: true, path: normalized };
}

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

// ── Write tools ──
//
// All writes require ctx.userId + ctx.ncToken (the caller's resolved
// Nextcloud session). The /api/llm/agent route filters these out of the
// advertised tool set for non-owner/admin users (see WRITE_TOOLS in
// routes/llm.ts) so the model never sees them as an option for an
// unprivileged caller; this is belt-and-braces in case a privileged
// session's prompt is poisoned into trying a write anyway.

const write_file: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a file in the user's Nextcloud. Pass `path` (full " +
    "target path including filename, e.g. '/Notes/idea.md') and either " +
    "`content` (UTF-8 text) or `content_base64` (binary, base64-encoded). " +
    "Max 10 MB per call. Confirm the destination with the user before " +
    "overwriting an existing file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Full target path including filename." },
      content: {
        type: "string",
        description: "UTF-8 text content (use this OR content_base64).",
      },
      content_base64: {
        type: "string",
        description: "Base64-encoded binary content (use this OR content).",
      },
    },
    required: ["path"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const v = validateNcPath(args.path);
    if (!v.ok) return { error: v.error };

    let buffer: Buffer;
    if (typeof args.content === "string") {
      buffer = Buffer.from(args.content, "utf8");
    } else if (typeof args.content_base64 === "string") {
      // Validate strict base64 — Buffer.from('base64') silently drops
      // anything outside the alphabet, which would let the model smuggle
      // junk through. Re-encode and compare to catch malformed input.
      const cleaned = args.content_base64.replace(/\s+/g, "");
      buffer = Buffer.from(cleaned, "base64");
      if (buffer.toString("base64").replace(/=+$/, "") !== cleaned.replace(/=+$/, "")) {
        return { error: "invalid base64 content" };
      }
    } else {
      return { error: "either content or content_base64 is required" };
    }
    if (buffer.byteLength > MAX_WRITE_BYTES) {
      return { error: `content too large (max ${MAX_WRITE_BYTES} bytes)` };
    }

    const dir = path.posix.dirname(v.path) || "/";
    const filename = path.posix.basename(v.path);
    if (!filename) return { error: "path must include a filename" };

    await nc.ncUploadFile(ctx.ncToken, ctx.userId, dir, filename, buffer);
    return { written: v.path, bytes: buffer.byteLength };
  },
};

const delete_file: Tool = {
  name: "delete_file",
  description:
    "Delete a file or directory in the user's Nextcloud. The item is moved " +
    "to Nextcloud's trash and can be restored from the dashboard. Recursive " +
    "for directories. Always confirm with the user before calling — this " +
    "tool will happily delete a 10-year archive folder.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Full path to the file or directory." },
    },
    required: ["path"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const v = validateNcPath(args.path);
    if (!v.ok) return { error: v.error };
    if (v.path === "/") return { error: "refusing to delete root" };

    await nc.ncDeleteFile(ctx.ncToken, ctx.userId, v.path);
    return { deleted: v.path };
  },
};

const create_directory: Tool = {
  name: "create_directory",
  description:
    "Create a directory in the user's Nextcloud. No-op if the directory " +
    "already exists. Pass full path, e.g. '/Projects/2026/Q2'. Note: parent " +
    "directories are NOT auto-created — call this once per level if needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Full directory path." },
    },
    required: ["path"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const v = validateNcPath(args.path);
    if (!v.ok) return { error: v.error };
    if (v.path === "/") return { error: "cannot create root" };

    await nc.ncCreateDirectory(ctx.ncToken, ctx.userId, v.path);
    return { created: v.path };
  },
};

const rename_file: Tool = {
  name: "rename_file",
  description:
    "Rename a file or directory in place (parent directory unchanged). Pass " +
    "the current full path and the new basename (filename only, no slashes). " +
    "Use move_file to change parent directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Current full path." },
      new_name: {
        type: "string",
        description: "New filename (basename only, no '/').",
      },
    },
    required: ["path", "new_name"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const v = validateNcPath(args.path);
    if (!v.ok) return { error: v.error };
    if (v.path === "/") return { error: "cannot rename root" };

    const newName = String(args.new_name ?? "");
    if (!newName) return { error: "new_name is required" };
    // Iteratively percent-decode so '%2f', '%2e%2e' etc. can't smuggle a
    // separator or traversal segment past the literal-character check.
    let decodedName = newName;
    for (let i = 0; i < 4 && decodedName.includes("%"); i++) {
      let next: string;
      try {
        next = decodeURIComponent(decodedName);
      } catch {
        return { error: "malformed percent-encoding in new_name" };
      }
      if (next === decodedName) break;
      decodedName = next;
    }
    for (const candidate of [newName, decodedName]) {
      if (
        candidate.includes("/") ||
        candidate.includes("\\") ||
        candidate.includes("\0") ||
        candidate === "." ||
        candidate === ".."
      ) {
        return {
          error:
            "new_name must be a plain filename — no slashes, no '.', '..', or null bytes",
        };
      }
    }

    const dir = path.posix.dirname(v.path) || "/";
    const dest = dir === "/" ? `/${newName}` : `${dir}/${newName}`;
    await nc.ncMoveFile(ctx.ncToken, ctx.userId, v.path, dest, false);
    return { renamed_from: v.path, renamed_to: dest };
  },
};

const move_file: Tool = {
  name: "move_file",
  description:
    "Move a file or directory to a new location. Pass `from_path` (current " +
    "location) and `to_path` (destination, including new name). Fails if the " +
    "destination already exists; pass overwrite=true to replace it.",
  parameters: {
    type: "object",
    properties: {
      from_path: { type: "string", description: "Current full path." },
      to_path: { type: "string", description: "Destination full path." },
      overwrite: {
        type: "boolean",
        description: "Replace destination if it exists. Default false.",
      },
    },
    required: ["from_path", "to_path"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const f = validateNcPath(args.from_path);
    if (!f.ok) return { error: `from_path: ${f.error}` };
    const t = validateNcPath(args.to_path);
    if (!t.ok) return { error: `to_path: ${t.error}` };
    if (f.path === t.path) return { error: "from_path and to_path are the same" };
    if (f.path === "/" || t.path === "/") return { error: "refusing to move root" };

    await nc.ncMoveFile(
      ctx.ncToken,
      ctx.userId,
      f.path,
      t.path,
      args.overwrite === true,
    );
    return { moved_from: f.path, moved_to: t.path };
  },
};

const copy_file: Tool = {
  name: "copy_file",
  description:
    "Copy a file or directory to a new location (recursive for directories). " +
    "Pass `from_path` and `to_path`. Fails if the destination exists; pass " +
    "overwrite=true to replace.",
  parameters: {
    type: "object",
    properties: {
      from_path: { type: "string", description: "Source full path." },
      to_path: { type: "string", description: "Destination full path." },
      overwrite: {
        type: "boolean",
        description: "Replace destination if it exists. Default false.",
      },
    },
    required: ["from_path", "to_path"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const f = validateNcPath(args.from_path);
    if (!f.ok) return { error: `from_path: ${f.error}` };
    const t = validateNcPath(args.to_path);
    if (!t.ok) return { error: `to_path: ${t.error}` };
    if (f.path === t.path) return { error: "from_path and to_path are the same" };
    if (f.path === "/" || t.path === "/") return { error: "refusing to copy root" };

    await nc.ncCopyFile(
      ctx.ncToken,
      ctx.userId,
      f.path,
      t.path,
      args.overwrite === true,
    );
    return { copied_from: f.path, copied_to: t.path };
  },
};

// ── Semantic content search (read-only) ──
//
// Calls the same gRPC embedder + pgvector path as GET /api/files/search/content.
// Mirrors the route's defensive checks (gRPC availability, finite-vector
// validation) so a degraded ai-gateway returns a clean tool error rather than
// a 500 the model has to interpret.

const search_content: Tool = {
  name: "search_content",
  description:
    "Semantic full-text search across the user's Nextcloud documents. Returns " +
    "the most relevant text snippets ranked by cosine similarity, each with " +
    "the source file path and a relevance score (0..1). Use this when the user " +
    "asks 'find that doc where I wrote about X' or wants to surface content by " +
    "meaning rather than filename. For filename-only lookup use search_files.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query (>= 2 characters).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max results to return (default 10).",
      },
    },
    required: ["query"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId) return { error: "auth_required" };
    const query = String(args.query ?? "").trim();
    if (query.length < 2) return { error: "query must be at least 2 characters" };
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));

    let embedVec: number[];
    try {
      const { grpcEmbedText, isGrpcAvailable } = await import(
        "./ai-gateway.grpc-client.js"
      );
      if (!isGrpcAvailable()) return { error: "embedding_service_unavailable" };
      const vectors = await grpcEmbedText([query]);
      if (!vectors?.[0] || !Array.isArray(vectors[0])) {
        return { error: "embedding_service_returned_no_vector" };
      }
      embedVec = vectors[0];
      if (!embedVec.every((v) => typeof v === "number" && Number.isFinite(v))) {
        return { error: "embedding_service_returned_invalid_vector" };
      }
    } catch {
      return { error: "embedding_service_unavailable" };
    }

    const vecLiteral = `[${embedVec.join(",")}]`;
    const rows: Array<{ path: string; score: number; text: string }> =
      await ctx.prisma.$queryRawUnsafe(
        `
        SELECT path, score, text FROM (
          SELECT DISTINCT ON ("ncFileId")
            "path",
            1 - ("embedding" <=> $1::vector) AS score,
            "text"
          FROM "FileContentChunk"
          WHERE "userId" = $2
          ORDER BY "ncFileId", "embedding" <=> $1::vector
        ) ranked
        ORDER BY score DESC
        LIMIT $3
        `,
        vecLiteral,
        ctx.userId,
        limit,
      );
    return { query, results: rows };
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
// Camera clips + live URLs (PR #3)
// ---------------------------------------------------------------------------

const list_clips: Tool = {
  name: "list_clips",
  description:
    "List recent camera clips (Frigate events with a recorded video). Each " +
    "result includes the camera, label (person/car/animal/etc.), confidence " +
    "score, time range, and a thumbnail URL the user can open in the dashboard.",
  parameters: {
    type: "object",
    properties: {
      camera: { type: "string", description: "Optional camera name to filter by." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 30." },
    },
  },
  handler: async (args, _ctx) => {
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 30));
    const camera = args.camera as string | undefined;
    const events = (await frigate.fetchEvents(limit, camera)) as Array<Record<string, unknown>>;
    return {
      count: events.length,
      clips: events
        .filter((e) => e.has_clip === true)
        .map((e) => ({
          id: e.id,
          camera: e.camera,
          label: e.label,
          score: e.score,
          start_time: e.start_time,
          end_time: e.end_time,
          thumbnail_url: `/api/cameras/events/${e.id}/thumbnail`,
          clip_url: `/api/cameras/clips/event/${e.id}`,
        })),
    };
  },
};

const export_clip: Tool = {
  name: "export_clip",
  description:
    "Render a custom-range clip from a camera's recordings and save it to " +
    "the user's Nextcloud at /Clips/<camera>/<timestamp>.mp4. Useful when " +
    "the user asks 'save the last 5 minutes from the front door'. Times are " +
    "ISO-8601. Max 30 minutes per export. Returns the Nextcloud path so the " +
    "model can also surface it in the Files app.",
  parameters: {
    type: "object",
    properties: {
      camera: { type: "string" },
      starts_at: { type: "string", description: "ISO-8601." },
      ends_at: { type: "string", description: "ISO-8601 (must be after starts_at)." },
    },
    required: ["camera", "starts_at", "ends_at"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId || !ctx.ncToken) return { error: "auth_required" };
    const startsAt = parseModelDate(args.starts_at);
    const endsAt = parseModelDate(args.ends_at);
    if (!startsAt || !endsAt) return { error: "invalid_iso8601" };
    try {
      const result = await exportClipSvc(ctx.ncToken, ctx.userId, {
        camera: String(args.camera ?? ""),
        startsAt,
        endsAt,
      });
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const get_camera_live_url: Tool = {
  name: "get_camera_live_url",
  description:
    "Return the dashboard URL for a live camera view. The user opens this " +
    "in their browser; playback uses their existing session. For shareable " +
    "links use share_clip on a saved clip instead.",
  parameters: {
    type: "object",
    properties: { camera: { type: "string" } },
    required: ["camera"],
  },
  handler: async (args, _ctx) => {
    const name = String(args.camera ?? "");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return { error: "invalid_camera_name" };
    return {
      live_url: `/cameras/${encodeURIComponent(name)}`,
      snapshot_url: `/api/cameras/${encodeURIComponent(name)}/snapshot`,
    };
  },
};

const share_clip: Tool = {
  name: "share_clip",
  description:
    "Generate a short-lived signed URL for a saved clip in the user's " +
    "Nextcloud (e.g. result of export_clip). Anyone with the link can " +
    "watch the clip until it expires. Default TTL 60 minutes; max 24 hours.",
  parameters: {
    type: "object",
    properties: {
      nc_path: { type: "string", description: "Path returned by export_clip (e.g. /Clips/front/20260423-140000Z.mp4)." },
      ttl_minutes: { type: "integer", minimum: 1, maximum: 1440 },
    },
    required: ["nc_path"],
  },
  handler: async (args, ctx) => {
    if (!ctx.userId) return { error: "auth_required" };
    const ttlMin = Math.max(1, Math.min(1440, Number(args.ttl_minutes) || 60));
    const token = signShareUrl(ctx.userId, String(args.nc_path), ttlMin * 60);
    const filename = String(args.nc_path).split("/").pop() ?? "clip.mp4";
    return {
      url: `/api/cameras/clips/share/${encodeURIComponent(filename)}?t=${encodeURIComponent(token)}`,
      expires_at: new Date(Date.now() + ttlMin * 60 * 1000).toISOString(),
    };
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
    write_file,
    delete_file,
    create_directory,
    rename_file,
    move_file,
    copy_file,
    search_content,
    list_cameras,
    list_discovered_cameras,
    list_recent_camera_events,
    scan_for_cameras,
    accept_discovered_camera,
    get_system_health,
    list_drives,
    // Camera clips + live URLs (PR #3)
    list_clips,
    export_clip,
    get_camera_live_url,
    share_clip,
  ].map((t) => [t.name, t]),
);
