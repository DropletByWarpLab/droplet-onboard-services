/**
 * tool-vision.service.ts — WARP-3692.
 *
 * Lets the MODEL see an image a tool just returned (a camera snapshot, a
 * photo `show_file` opened), so "is anyone at the front door?" can be
 * answered from the picture instead of from the user's eyes.
 *
 * WARP-3691 made those tools return a `media` descriptor (a same-origin URL
 * the DASHBOARD fetches). The model never saw bytes. This module is the
 * missing half: after a tool result, the agent loop asks `inspect()` which
 * images that result carries, and gets back OpenAI `image_url` blocks to
 * inject as a synthetic user message (see `injectToolImages` in
 * llm-agent.service.ts — a tool-role message cannot carry an image).
 *
 * THE RULES THIS FILE ENFORCES (each pinned by tool-vision.service.test.ts):
 *
 *  1. AS THE USER, NEVER AS A SERVICE. Bytes are fetched in-process through
 *     the same ACL functions the routes use, bound to the REQUESTING user:
 *     `canAccessCamera` (per-camera grants + role) for cameras, the user's own
 *     Nextcloud token + username for files-tree paths, and the owner-only
 *     `userId` filter for brain-memory items. The `_service:mcp` principal is
 *     never used, so a user cannot see through the assistant what the
 *     dashboard would 404 for them. A denial is silent for the image and
 *     reported to the model only as "could not view it".
 *  2. SIZE-BOUNDED. Resized at the SOURCE (Frigate `h`, Nextcloud preview
 *     x/y, the file-indexer's 1024px vision render) — the orchestrator ships
 *     no native image library (`sharp` is only Next's transitive dependency
 *     in web-dashboard), and a resize on this event loop would be the wrong
 *     place for it anyway. Whatever comes back is then magic-byte checked
 *     (never trust a Content-Type) and hard-capped in bytes while streaming.
 *  3. CAPPED. At most `MAX_TOOL_IMAGES_PER_TURN` images per agent turn.
 *  4. VISION MODELS ONLY, ON-BOX ONLY. A non-vision model gets a one-line
 *     note instead of bytes. An off-LAN (cloud) turn gets NO bytes at all —
 *     the same rule `stored-content-egress.service.ts` applies to attached
 *     images (WARP-1983): a turn that leaves the LAN carries none of the
 *     customer's stored content, and a camera frame is exactly that.
 *  5. NEVER PERSISTED, NEVER EMITTED. This module returns blocks to the loop;
 *     the loop appends them to its in-memory `messages` only. The trace, the
 *     SSE `tool_result` event and the checkpoint hold the descriptor, not
 *     bytes. The client already renders the media card.
 *  6. AUDITED. A camera frame the AI views is written to the same signed
 *     camera-watch log a human viewing the camera is, actor = the user,
 *     `via = "ai"`.
 *
 * Failure policy: nothing in here may fail a tool call or a turn. Every error
 * degrades to "could not view" for that one image.
 */
import type { PrismaClient } from "@prisma/client";
import { parseChatMedia, type ChatMedia } from "@droplet/shared-types";

import { createLogger } from "../lib/logger.js";
import type { ContentBlock } from "../types/index.js";
import { buildImageBlocks } from "./vision-attachments.service.js";
import { auditCameraWatch } from "./camera-watch-audit.js";
import { canAccessCamera, CAMERA_VIEW_ROLES } from "./camera-access.service.js";
import {
  fetchEventCamera,
  fetchEventSnapshot,
  fetchEventThumbnail,
  fetchSnapshot,
} from "./frigate.client.js";
import { ncFetchThumbnail, ncGetFileId } from "./nextcloud.client.js";

const logger = createLogger("tool-vision");

/**
 * Images the model may be shown in ONE agent turn (one `runAgent` call, all
 * its iterations). A lookup tool that lists six events must not turn into six
 * images on a 16K-window local model; the first four are enough to answer, the
 * rest the user sees as cards.
 */
export const MAX_TOOL_IMAGES_PER_TURN = 4;

/**
 * Hard ceiling on one image's bytes, enforced while streaming. A 1024px JPEG
 * is ~100-300 KB; 1.5 MB leaves room for a detailed PNG without letting a
 * hostile or broken upstream stream gigabytes into the orchestrator.
 */
export const MAX_TOOL_IMAGE_BYTES = 1_500_000;

/**
 * Long-edge budget (px). Frigate resizes by HEIGHT only, so the live-frame
 * height is the long edge for a portrait stream and ~1138 for 16:9 — close
 * enough to the file-indexer's 1024px vision render. Nextcloud previews are
 * asked for exactly 1024x1024 (aspect kept).
 */
export const TOOL_IMAGE_MAX_EDGE = 1024;
export const TOOL_IMAGE_FRAME_HEIGHT = 640;

/**
 * Per-image budget for the whole fetch (ACL checks + bytes). A slow camera or
 * Nextcloud must not stall the turn; on expiry the image is "could not view".
 */
export const TOOL_IMAGE_FETCH_TIMEOUT_MS = 8_000;

export const NOTE_NOT_VISION =
  "[image not viewable by the current model; the user can see it inline]";
export const NOTE_OFF_LAN =
  "[image withheld: the current model runs off this device, and images from your cameras and files are never sent there; the user can see it inline]";
export const NOTE_COULD_NOT_VIEW =
  "[could not view the image; the user can see it inline]";
export const NOTE_OVER_CAP =
  "[image not attached: the per-turn image limit was reached; the user can see it inline]";

/** A single image a tool result asks to be shown to the model. */
export type ToolImageRef =
  | { kind: "camera_frame"; camera: string }
  | { kind: "event_snapshot"; eventId: string; camera?: string }
  | { kind: "event_thumbnail"; eventId: string; camera?: string }
  | { kind: "file_path"; path: string; name: string }
  | { kind: "brain_item"; itemId: string; name: string };

const VIEWABLE_FILE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Which images does this tool result carry? Pure. Works off
 * `parseChatMedia` — the same validator the dashboard runs — so a descriptor
 * with an unsafe URL or malformed identifier never reaches a fetcher.
 * `camera_live` is skipped on purpose: it is a stream, and its poster frame is
 * the same frame `get_camera_snapshot` returns.
 */
export function selectImageRefs(payload: unknown): ToolImageRef[] {
  const refs: ToolImageRef[] = [];
  for (const m of parseChatMedia(payload) as ChatMedia[]) {
    switch (m.kind) {
      case "camera_snapshot":
        refs.push(
          m.eventId
            ? { kind: "event_snapshot", eventId: m.eventId, camera: m.camera }
            : { kind: "camera_frame", camera: m.camera },
        );
        break;
      case "camera_clip":
        if (m.eventId && m.thumbnailUrl) {
          refs.push({ kind: "event_thumbnail", eventId: m.eventId, camera: m.camera });
        }
        break;
      case "file":
        if (VIEWABLE_FILE_MIME.has(m.mimeType.toLowerCase())) {
          if (m.itemId) refs.push({ kind: "brain_item", itemId: m.itemId, name: m.name });
          else if (m.path) refs.push({ kind: "file_path", path: m.path, name: m.name });
        }
        break;
      default:
        break;
    }
  }
  return refs;
}

/** What the loop gets back for one tool result. */
export interface ToolVisionOutcome {
  /**
   * Alternating `[text marker, image_url]` blocks to inject as ONE synthetic
   * user message after the tool results. Empty when nothing was attached.
   */
  blocks: ContentBlock[];
  /** Short bracketed notes to append to the tool result the model reads. */
  notes: string[];
  attached: number;
}

export interface ToolVision {
  inspect(toolName: string, payload: unknown): Promise<ToolVisionOutcome>;
}

const NONE: ToolVisionOutcome = { blocks: [], notes: [], attached: 0 };

/** The I/O the session needs; injectable so tests never touch the network. */
export interface ToolVisionPorts {
  canAccessCamera(camera: string): Promise<boolean>;
  eventCamera(eventId: string): Promise<string | null>;
  fetchFrame(camera: string, height: number): Promise<Response>;
  fetchEventSnapshot(eventId: string, height: number): Promise<Response>;
  fetchEventThumbnail(eventId: string): Promise<Response>;
  fileId(path: string): Promise<number | null>;
  fileThumbnail(
    fileId: number,
    edge: number,
  ): Promise<{ body: ArrayBuffer; contentType: string } | null>;
  /** The owner's normalised vision render as an image_url block, or null. */
  brainImage(itemId: string): Promise<ContentBlock | null>;
  auditCamera(camera: string, eventId?: string): Promise<void>;
}

export interface ToolVisionOptions {
  /** True when the turn's resolved provider is off-LAN (cloud). */
  offLan: boolean;
  /** Lazily asks whether the model this turn runs on can see. Memoised. */
  isVisionModel: () => Promise<boolean>;
  ports: ToolVisionPorts;
  now?: () => Date;
}

export function createToolVision(opts: ToolVisionOptions): ToolVision {
  let remaining = MAX_TOOL_IMAGES_PER_TURN;
  let vision: Promise<boolean> | null = null;
  const canSee = (): Promise<boolean> => {
    vision ??= opts.isVisionModel().catch(() => false);
    return vision;
  };
  const now = opts.now ?? (() => new Date());

  return {
    async inspect(toolName, payload) {
      const refs = selectImageRefs(payload);
      if (refs.length === 0) return NONE;

      // Egress first: an off-LAN turn never fetches, so nothing is even read.
      if (opts.offLan) return { blocks: [], notes: [NOTE_OFF_LAN], attached: 0 };
      if (!(await canSee())) return { blocks: [], notes: [NOTE_NOT_VISION], attached: 0 };

      const blocks: ContentBlock[] = [];
      const notes: string[] = [];
      let attached = 0;
      let couldNot = 0;
      let overCap = 0;
      for (const ref of refs) {
        if (remaining <= 0) {
          overCap++;
          continue;
        }
        let fetched: FetchedImage | null = null;
        try {
          fetched = await withTimeout(fetchRef(ref, opts.ports), TOOL_IMAGE_FETCH_TIMEOUT_MS);
        } catch (err) {
          // Never log the descriptor's path/filename beyond its kind: a file
          // name can be PHI. The error class is what an operator needs.
          logger.debug({ tool: toolName, ref: ref.kind, err: errName(err) }, "tool_vision_fetch_failed");
        }
        if (!fetched) {
          couldNot++;
          continue;
        }
        remaining--;
        attached++;
        blocks.push({ type: "text", text: marker(toolName, fetched.label, now()) });
        blocks.push({ type: "image_url", image_url: { url: fetched.dataUrl } });
      }
      if (couldNot > 0) notes.push(NOTE_COULD_NOT_VIEW);
      if (overCap > 0) notes.push(NOTE_OVER_CAP);
      return { blocks, notes, attached };
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tool image fetch timed out")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/** `[Image from tool get_camera_snapshot: front_door, captured 2026-…Z]` */
function marker(toolName: string, label: Label, now: Date): string {
  const when = label.capturedAt ?? now;
  return `[Image from tool ${toolName}: ${label.subject}, captured ${when.toISOString()}]`;
}

interface Label {
  subject: string;
  capturedAt?: Date;
}
interface FetchedImage {
  dataUrl: string;
  label: Label;
}

/** Frigate event ids start with the epoch seconds: `1700000000.123-abc123`. */
function eventTime(eventId: string): Date | undefined {
  const m = /^(\d{9,11})(?:\.\d+)?-/.exec(eventId);
  if (!m) return undefined;
  const t = Number(m[1]) * 1000;
  return Number.isFinite(t) ? new Date(t) : undefined;
}

/** Filenames are user content: keep a conservative alphabet, bounded. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ._()-]/g, "_").slice(0, 80);
  return cleaned || "image";
}

async function fetchRef(ref: ToolImageRef, p: ToolVisionPorts): Promise<FetchedImage | null> {
  switch (ref.kind) {
    case "camera_frame": {
      if (!(await p.canAccessCamera(ref.camera))) return null;
      const bytes = await readCapped(await p.fetchFrame(ref.camera, TOOL_IMAGE_FRAME_HEIGHT));
      const url = toDataUrl(bytes);
      if (!url) return null;
      await auditQuiet(p, ref.camera);
      return { dataUrl: url, label: { subject: ref.camera } };
    }
    case "event_snapshot":
    case "event_thumbnail": {
      // The descriptor's `camera` is a claim; the ACL decision is made on the
      // camera Frigate says recorded the event (the same resolution
      // requireCameraAccess uses for `:eventId` routes). Unknown event = deny.
      const owner = await p.eventCamera(ref.eventId);
      if (!owner || !(await p.canAccessCamera(owner))) return null;
      const resp =
        ref.kind === "event_snapshot"
          ? await p.fetchEventSnapshot(ref.eventId, TOOL_IMAGE_FRAME_HEIGHT)
          : await p.fetchEventThumbnail(ref.eventId);
      const url = toDataUrl(await readCapped(resp));
      if (!url) return null;
      await auditQuiet(p, owner, ref.eventId);
      return { dataUrl: url, label: { subject: owner, capturedAt: eventTime(ref.eventId) } };
    }
    case "file_path": {
      const id = await p.fileId(ref.path);
      if (id === null) return null;
      const thumb = await p.fileThumbnail(id, TOOL_IMAGE_MAX_EDGE);
      if (!thumb) return null;
      const url = toDataUrl(new Uint8Array(thumb.body));
      return url ? { dataUrl: url, label: { subject: safeName(ref.name) } } : null;
    }
    case "brain_item": {
      const block = await p.brainImage(ref.itemId);
      if (!block || block.type !== "image_url") return null;
      const url = block.image_url.url;
      // The render is size-bounded by the file-indexer; still enforce OUR cap
      // (base64 is 4/3 of the bytes).
      if (url.length > Math.ceil((MAX_TOOL_IMAGE_BYTES * 4) / 3) + 64) return null;
      return { dataUrl: url, label: { subject: safeName(ref.name) } };
    }
  }
}

async function auditQuiet(p: ToolVisionPorts, camera: string, eventId?: string): Promise<void> {
  try {
    await p.auditCamera(camera, eventId);
  } catch (err) {
    // Same posture as every recordActivity caller: a failed audit row is
    // logged by the recorder and never blocks the footage.
    logger.warn({ err: errName(err) }, "tool_vision_audit_failed");
  }
}

/** Read a response body with a hard byte ceiling; null-safe. */
async function readCapped(resp: Response): Promise<Uint8Array> {
  if (!resp.ok) throw new Error(`upstream ${resp.status}`);
  const declared = Number(resp.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_TOOL_IMAGE_BYTES) {
    await resp.body?.cancel().catch(() => undefined);
    throw new Error("image too large");
  }
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer()).subarray(0, 0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_TOOL_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("image too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Sniff the real type from the bytes (an upstream Content-Type is not
 * trusted) and build the data URL. Null for anything that is not a raster
 * image the providers accept, for an empty body, or over the byte cap —
 * SVG and HTML in particular never pass.
 */
export function toDataUrl(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TOOL_IMAGE_BYTES) return null;
  const mime = sniffImageMime(bytes);
  if (!mime) return null;
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  return null;
}

// ── Production ports ─────────────────────────────────────────────────────

export interface ToolVisionUser {
  id: string;
  role: string;
  username: string;
}

/**
 * Ports bound to ONE requesting user. `ncToken` is that user's own Nextcloud
 * credential (`resolveNcToken(req)`); without it file paths cannot be read.
 */
export function userToolVisionPorts(args: {
  prisma: PrismaClient;
  user: ToolVisionUser;
  ncToken?: string;
}): ToolVisionPorts {
  const { prisma, user, ncToken } = args;
  return {
    async canAccessCamera(camera) {
      // Role gate first (the routes' `requireRole(...CAMERA_VIEW_ROLES)`),
      // then the per-camera grant (`requireCameraAccess`).
      if (!(CAMERA_VIEW_ROLES as readonly string[]).includes(user.role)) return false;
      return canAccessCamera(prisma, { id: user.id, role: user.role }, camera);
    },
    eventCamera: (eventId) => fetchEventCamera(eventId),
    fetchFrame: (camera, height) => fetchSnapshot(camera, height),
    fetchEventSnapshot: (eventId, height) => fetchEventSnapshot(eventId, height),
    fetchEventThumbnail: (eventId) => fetchEventThumbnail(eventId),
    async fileId(path) {
      if (!ncToken) return null;
      return ncGetFileId(ncToken, user.username, path);
    },
    async fileThumbnail(fileId, edge) {
      if (!ncToken) return null;
      return ncFetchThumbnail(ncToken, fileId, edge, edge);
    },
    async brainImage(itemId) {
      // Owner-only, ready, has a vision render: buildImageBlocks' own query.
      const { blocks } = await buildImageBlocks(prisma, user.id, [itemId], { maxImages: 1 });
      return blocks[0] ?? null;
    },
    auditCamera: (camera, eventId) =>
      auditCameraWatch(
        { user: { id: user.id, role: user.role, username: user.username } },
        camera,
        "snapshot",
        { via: "ai", ...(eventId ? { eventId } : {}) },
      ),
  };
}

// ── Context-guard accounting ─────────────────────────────────────────────

/**
 * What the in-loop context guard charges for ONE injected image: ~1,500
 * tokens at the guard's chars/4 convention. A 1024px image costs a vision
 * model on that order; charging the base64 length instead (~300k tokens for a
 * 1 MB frame) would trip `context_budget` on the very next iteration and end
 * the turn before the model could use what it was just shown.
 */
export const IMAGE_TOKEN_ESTIMATE_CHARS = 1_500 * 4;
const IMAGE_PLACEHOLDER = "x".repeat(IMAGE_TOKEN_ESTIMATE_CHARS);

/**
 * `JSON.stringify(messages).length` as the agent loop's context guard
 * measures it, except that the images in the messages THIS FEATURE injected
 * (`injected`) are charged `IMAGE_TOKEN_ESTIMATE_CHARS` each. Every other
 * message — including an attached-image user turn — is measured exactly as
 * before.
 */
export function serializedMessageChars(
  messages: readonly { content: unknown }[],
  injected: WeakSet<object>,
): number {
  const view = messages.map((m) => {
    if (!injected.has(m) || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: (m.content as ContentBlock[]).map((b) =>
        b.type === "image_url" ? { type: "image_url", image_url: { url: IMAGE_PLACEHOLDER } } : b,
      ),
    };
  });
  return JSON.stringify(view).length;
}
