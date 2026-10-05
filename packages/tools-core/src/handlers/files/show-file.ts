/**
 * `show_file` — show the user a file inline in the chat (WARP-3691).
 *
 * Named show_file, not open_file: `open_file` is already a Tier-2 desktop
 * client tool (ADR-014, opens a file on the user's own device).
 *
 * Read-only and byte-free: the tool only CONFIRMS the file exists for this
 * user and returns a `media` descriptor. The dashboard renders the card and
 * fetches bytes itself through the existing `/api/files/download` /
 * `/api/files/thumbnail` / `/api/files/brain/:id/download` routes, each of
 * which enforces its own ACL. No new byte route, no bytes through the model.
 *
 * "Exists for this user" is checked by listing the file's PARENT directory
 * with the caller's own Nextcloud token (the same `GET /?path=` call
 * `list_files` makes) and finding the entry. A file the user cannot see is
 * simply not in that listing, so it fails NOT_FOUND exactly like a missing
 * one — the tool never distinguishes "forbidden" from "absent".
 */
import {
  fileMediaFromBrainItem,
  fileMediaFromPath,
  mimeTypeForName,
} from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { validateNcPath } from "./_paths.js";
import { filesUnavailable, isFilesDegraded } from "./_unavailable.js";

const inputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description:
        "Full path of a file on the user's Droplet storage (e.g. /Documents/plan.pdf). Use list_files / search_files to find it first if you do not know it.",
    },
    itemId: {
      type: "string",
      description:
        "Id of a file the user attached in chat (a brain-memory item). Use instead of `path` for chat attachments.",
    },
  },
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

const NOT_FOUND = "File not found. Check the path with list_files or search_files.";

interface ListEntry {
  name?: unknown;
  path?: unknown;
  isDirectory?: unknown;
  size?: unknown;
  mimeType?: unknown;
}

async function openByPath(rawPath: unknown, ctx: ToolContext): Promise<ToolResult> {
  const v = validateNcPath(rawPath);
  if (!v.ok) return err("INVALID_PATH", v.error);
  const path = v.path;
  if (path === "/") return err("INVALID_PATH", "path must point to a file, not the root folder");

  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const parent = slash <= 0 ? "/" : path.slice(0, slash);

  const res = await ctx.http.nextcloud.get(`/?path=${encodeURIComponent(parent)}`, {
    headers: {
      "X-Nextcloud-Token": ctx.ncToken as string,
      "X-Nextcloud-User": ctx.userId as string,
    },
  });
  if (res.status === 404) return err("NOT_FOUND", NOT_FOUND);
  if (!res.ok) return err("OPEN_FAILED", `nextcloud returned ${res.status}`);
  if (isFilesDegraded(res)) return filesUnavailable();

  const listing = (await res.json()) as unknown;
  const entries: ListEntry[] = Array.isArray(listing) ? (listing as ListEntry[]) : [];
  const entry = entries.find((e) => e && typeof e.name === "string" && e.name === name);
  if (!entry) return err("NOT_FOUND", NOT_FOUND);
  if (entry.isDirectory === true) {
    return err("INVALID_PATH", "That is a folder, not a file. Use list_files to see what is inside it.");
  }

  const size = typeof entry.size === "number" ? entry.size : undefined;
  const declaredMime = typeof entry.mimeType === "string" ? entry.mimeType : null;
  const media = fileMediaFromPath(path, { name, mimeType: declaredMime, size });
  return {
    ok: true,
    data: {
      name: media.name,
      path,
      mimeType: media.mimeType,
      ...(size !== undefined ? { size } : {}),
      note: "The file is shown to the user inline in the chat.",
      media,
    },
  };
}

async function openByItemId(rawId: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (typeof rawId !== "string" || rawId.length === 0) {
    return err("INVALID_ARGS", "itemId must be a non-empty string");
  }
  // Shape-check BEFORE interpolating into a URL path; the route is owner-only
  // and 404s an item that is not the caller's.
  const probe = fileMediaFromBrainItem(rawId, { name: "x" });
  if (!probe) return err("INVALID_ARGS", "invalid itemId");

  const res = await ctx.http.nextcloud.get(`/brain/${encodeURIComponent(rawId)}`, {
    headers: {
      "X-Nextcloud-Token": ctx.ncToken as string,
      "X-Nextcloud-User": ctx.userId as string,
      Accept: "application/json",
    },
  });
  if (res.status === 404) return err("NOT_FOUND", "Attachment not found.");
  if (!res.ok) return err("OPEN_FAILED", `files service returned ${res.status}`);
  const item = (await res.json()) as { filename?: unknown; mimeType?: unknown; bytes?: unknown };
  const name = typeof item.filename === "string" && item.filename.length > 0 ? item.filename : null;
  if (!name) return err("NOT_FOUND", "Attachment not found.");
  const size = typeof item.bytes === "number" ? item.bytes : undefined;
  const mimeType = typeof item.mimeType === "string" && item.mimeType ? item.mimeType : mimeTypeForName(name);
  const media = fileMediaFromBrainItem(rawId, { name, mimeType, size });
  if (!media) return err("INVALID_ARGS", "invalid itemId");
  return {
    ok: true,
    data: {
      name,
      itemId: rawId,
      mimeType,
      ...(size !== undefined ? { size } : {}),
      note: "The file is shown to the user inline in the chat.",
      media,
    },
  };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // Same boundary as read_file / list_files: an authenticated Nextcloud
  // session plus validateNcPath. Low-privilege roles can reach read tools.
  if (!ctx.userId || !ctx.ncToken) {
    return err(
      "AUTH_REQUIRED",
      "File access isn't connected for this session. Ask the user to sign out of the Droplet dashboard and sign back in with their password — that reconnects file access and file tools will work again.",
    );
  }
  const hasPath = args.path !== undefined && args.path !== null && args.path !== "";
  const hasItem = args.itemId !== undefined && args.itemId !== null && args.itemId !== "";
  if (hasPath === hasItem) {
    return err("INVALID_ARGS", "provide exactly one of `path` or `itemId`");
  }
  return hasPath ? openByPath(args.path, ctx) : openByItemId(args.itemId, ctx);
}

const tool: Tool = {
  name: "show_file",
  description:
    "Show a file to the user inline in the chat — a picture, PDF, video, document or any file. Use this when the user asks to see, open, show or look at a file or image (find the path with list_files or search_files first). Images display directly; other files show as a card the user can open or download. The user sees the result, so do not paste links. This does NOT read the file's contents for you — use read_file or read_document_text to read text. Takes `path` (Droplet storage) or `itemId` (a file attached in chat).",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
