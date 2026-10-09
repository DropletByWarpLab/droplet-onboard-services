/**
 * WARP-3691 — inline media in AI chat.
 *
 * A tool result can carry a `media` descriptor (one item or a list) inside its
 * `data`. The dashboard renders each as a card under the assistant message:
 * camera snapshots, live feeds, clips/events and file previews.
 *
 * This is a DESCRIPTOR, not a byte route. Every URL here is a same-origin
 * `/api/...` path that already exists and already enforces its own ACL
 * (`requireCameraAccess`, Nextcloud per-user tokens, brain owner-only). The
 * descriptor grants nothing: a URL the caller cannot open 404s in the browser
 * exactly as it would if typed by hand.
 *
 * Producers (tools-core handlers) build descriptors with the helpers below so
 * identifiers are validated and encoded in one place. Consumers (the
 * dashboard) run untrusted tool-result data through `parseChatMedia`, which
 * re-validates every URL — persisted tool calls and model-shaped data are not
 * trusted just because a tool "should" have produced them.
 */

/** Same convention the orchestrator's camera routes enforce (cameras.ts). */
export const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** Frigate event ids (`1700000000.123-abc123`). Mirrors cameras.ts EVENT_ID_RE. */
export const EVENT_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
/** brain-memory item ids are cuid / uuid shaped. */
export const BRAIN_ITEM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface CameraSnapshotMedia {
  kind: "camera_snapshot";
  camera: string;
  /** `/api/cameras/<name>/snapshot` or `/api/cameras/events/<id>/snapshot`. */
  snapshotUrl: string;
  /** Present for a current-frame snapshot; lets the card offer "Go live". */
  liveUrl?: string;
  /** Set when the snapshot belongs to a recorded event (static, not refreshable). */
  eventId?: string;
  label?: string;
}

export interface CameraLiveMedia {
  kind: "camera_live";
  camera: string;
  /** MJPEG stream, `/api/cameras/<name>/live`. */
  liveUrl: string;
  /** Poster frame shown until (and after) the stream is connected. */
  snapshotUrl: string;
}

export interface CameraClipMedia {
  kind: "camera_clip";
  camera?: string;
  eventId?: string;
  /** Progressive MP4 for one event: `/api/cameras/clips/event/<id>`. */
  clipUrl?: string;
  /** HLS playlist: `/api/cameras/<name>/playback.m3u8?...`. */
  playbackUrl?: string;
  thumbnailUrl?: string;
  label?: string;
  startTime?: number;
  endTime?: number;
}

export interface FileMedia {
  kind: "file";
  /** Files-tree path (`/Docs/a.pdf`); absent for brain-memory items. */
  path?: string;
  /** Brain-memory item id (chat attachments); absent for files-tree files. */
  itemId?: string;
  name: string;
  mimeType: string;
  size?: number;
  /** Bytes for rendering (`disposition=inline`; server safelists inert types). */
  previewUrl: string;
  downloadUrl: string;
  thumbnailUrl?: string;
}

export type ChatMedia = CameraSnapshotMedia | CameraLiveMedia | CameraClipMedia | FileMedia;

// ── URL guard ────────────────────────────────────────────────────────────

/**
 * True only for a same-origin `/api/...` path. Rejects absolute and
 * protocol-relative URLs, backslashes (browsers treat `\` as `/`), control
 * characters and `..` path segments. Same rule SafeImage applies to markdown.
 */
export function isSafeMediaUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length === 0 || u.length > 2048) return false;
  if (!u.startsWith("/api/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(u)) return false;
  const pathOnly = u.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return false;
  }
  return !decoded.split("/").includes("..");
}

// ── Builders (producer side) ─────────────────────────────────────────────

export function cameraSnapshotUrl(camera: string): string {
  return `/api/cameras/${encodeURIComponent(camera)}/snapshot`;
}
export function cameraLiveUrl(camera: string): string {
  return `/api/cameras/${encodeURIComponent(camera)}/live`;
}
export function eventSnapshotUrl(eventId: string): string {
  return `/api/cameras/events/${encodeURIComponent(eventId)}/snapshot`;
}
export function eventThumbnailUrl(eventId: string): string {
  return `/api/cameras/events/${encodeURIComponent(eventId)}/thumbnail`;
}
export function eventClipUrl(eventId: string): string {
  return `/api/cameras/clips/event/${encodeURIComponent(eventId)}`;
}

/** Null when the camera name would not pass the orchestrator's own check. */
export function cameraSnapshotMedia(camera: string): CameraSnapshotMedia | null {
  if (!CAMERA_NAME_RE.test(camera)) return null;
  return {
    kind: "camera_snapshot",
    camera,
    snapshotUrl: cameraSnapshotUrl(camera),
    liveUrl: cameraLiveUrl(camera),
  };
}

export function cameraLiveMedia(camera: string): CameraLiveMedia | null {
  if (!CAMERA_NAME_RE.test(camera)) return null;
  return {
    kind: "camera_live",
    camera,
    liveUrl: cameraLiveUrl(camera),
    snapshotUrl: cameraSnapshotUrl(camera),
  };
}

/**
 * WARP-3927 — one still FROM RECORDED FOOTAGE at an instant (not the current
 * frame). `at` is epoch seconds. No `liveUrl`: the card must not offer a
 * refresh or "go live" for a moment in the past, and no `eventId`: the still
 * belongs to a recording, not to a detection event.
 */
export function recordingSnapshotUrl(camera: string, at: number): string {
  return `/api/cameras/${encodeURIComponent(camera)}/recordings/snapshot?at=${Math.trunc(at)}`;
}
export function recordingSnapshotMedia(camera: string, at: number, label?: string): CameraSnapshotMedia | null {
  if (!CAMERA_NAME_RE.test(camera) || !Number.isFinite(at) || at <= 0) return null;
  return {
    kind: "camera_snapshot",
    camera,
    snapshotUrl: recordingSnapshotUrl(camera, at),
    ...(label ? { label } : {}),
  };
}

/** Recorded-footage URLs for a window (epoch seconds): progressive MP4 (<= 30 min) and HLS. */
export function recordingClipUrl(camera: string, after: number, before: number): string {
  return `/api/cameras/${encodeURIComponent(camera)}/playback?after=${Math.trunc(after)}&before=${Math.trunc(before)}`;
}
export function recordingPlaybackUrl(camera: string, after: number, before: number): string {
  return `/api/cameras/${encodeURIComponent(camera)}/playback.m3u8?after=${Math.trunc(after)}&before=${Math.trunc(before)}`;
}

function pickStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}
function pickNum(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}
function pickBool(o: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((k) => o[k] === true);
}

/**
 * Media for one Frigate event as the orchestrator returns it (either casing:
 * `/cameras/events/recent` is camelCase, `/cameras/clips` is snake_case).
 * A clip wins over a still; an event with neither yields null.
 */
export function eventMedia(event: unknown): CameraClipMedia | CameraSnapshotMedia | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const id = pickStr(e, "id");
  if (!id || !EVENT_ID_RE.test(id)) return null;
  const rawCamera = pickStr(e, "camera");
  const camera = rawCamera && CAMERA_NAME_RE.test(rawCamera) ? rawCamera : undefined;
  const label = pickStr(e, "label");
  const hasClip = pickBool(e, "hasClip", "has_clip");
  const hasSnapshot = pickBool(e, "hasSnapshot", "has_snapshot");
  if (hasClip) {
    const startTime = pickNum(e, "startTime", "start_time");
    const endTime = pickNum(e, "endTime", "end_time");
    return {
      kind: "camera_clip",
      ...(camera ? { camera } : {}),
      eventId: id,
      clipUrl: eventClipUrl(id),
      thumbnailUrl: eventThumbnailUrl(id),
      ...(label ? { label } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
    };
  }
  if (hasSnapshot && camera) {
    return {
      kind: "camera_snapshot",
      camera,
      eventId: id,
      snapshotUrl: eventSnapshotUrl(id),
      ...(label ? { label } : {}),
    };
  }
  return null;
}

/** Cap so a 200-event list doesn't become 200 cards. */
export const MAX_EVENT_MEDIA = 6;

export function eventsMedia(events: unknown, max = MAX_EVENT_MEDIA): ChatMedia[] {
  if (!Array.isArray(events)) return [];
  const out: ChatMedia[] = [];
  for (const ev of events) {
    const m = eventMedia(ev);
    if (m) out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Best-effort MIME from a filename; `application/octet-stream` when unknown. */
export function mimeTypeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** A files-tree file. `path` must already be validated (no traversal). */
export function fileMediaFromPath(
  path: string,
  info: { name?: string; mimeType?: string | null; size?: number } = {},
): FileMedia {
  const name = info.name || path.split("/").filter(Boolean).pop() || path;
  const enc = encodeURIComponent(path);
  const mimeType =
    info.mimeType && info.mimeType.length > 0 && info.mimeType !== "application/octet-stream"
      ? info.mimeType
      : mimeTypeForName(name);
  return {
    kind: "file",
    path,
    name,
    mimeType,
    ...(typeof info.size === "number" ? { size: info.size } : {}),
    previewUrl: `/api/files/download?path=${enc}&disposition=inline`,
    downloadUrl: `/api/files/download?path=${enc}`,
    ...(mimeType.startsWith("image/")
      ? { thumbnailUrl: `/api/files/thumbnail?path=${enc}&x=512&y=512` }
      : {}),
  };
}

/** A brain-memory item (chat attachment). Null when the id is malformed. */
export function fileMediaFromBrainItem(
  itemId: string,
  info: { name: string; mimeType?: string | null; size?: number },
): FileMedia | null {
  if (!BRAIN_ITEM_ID_RE.test(itemId)) return null;
  const enc = encodeURIComponent(itemId);
  const mimeType = info.mimeType || mimeTypeForName(info.name);
  return {
    kind: "file",
    itemId,
    name: info.name,
    mimeType,
    ...(typeof info.size === "number" ? { size: info.size } : {}),
    previewUrl: `/api/files/brain/${enc}/download?disposition=inline`,
    downloadUrl: `/api/files/brain/${enc}/download`,
  };
}

// ── Parser (consumer side) ───────────────────────────────────────────────

function str(v: unknown, max = 512): string | undefined {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}
function safeUrl(v: unknown): string | undefined {
  return isSafeMediaUrl(v) ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function camName(v: unknown): string | undefined {
  return typeof v === "string" && CAMERA_NAME_RE.test(v) ? v : undefined;
}

/** Validate ONE untrusted descriptor; null when it is unusable or unsafe. */
export function parseOneChatMedia(raw: unknown): ChatMedia | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  switch (m.kind) {
    case "camera_snapshot": {
      const camera = camName(m.camera);
      const snapshotUrl = safeUrl(m.snapshotUrl);
      if (!camera || !snapshotUrl) return null;
      const eventId = typeof m.eventId === "string" && EVENT_ID_RE.test(m.eventId) ? m.eventId : undefined;
      const liveUrl = safeUrl(m.liveUrl);
      const label = str(m.label, 128);
      return {
        kind: "camera_snapshot",
        camera,
        snapshotUrl,
        ...(liveUrl ? { liveUrl } : {}),
        ...(eventId ? { eventId } : {}),
        ...(label ? { label } : {}),
      };
    }
    case "camera_live": {
      const camera = camName(m.camera);
      const liveUrl = safeUrl(m.liveUrl);
      const snapshotUrl = safeUrl(m.snapshotUrl);
      if (!camera || !liveUrl || !snapshotUrl) return null;
      return { kind: "camera_live", camera, liveUrl, snapshotUrl };
    }
    case "camera_clip": {
      const clipUrl = safeUrl(m.clipUrl);
      const playbackUrl = safeUrl(m.playbackUrl);
      if (!clipUrl && !playbackUrl) return null;
      const camera = camName(m.camera);
      const eventId = typeof m.eventId === "string" && EVENT_ID_RE.test(m.eventId) ? m.eventId : undefined;
      const thumbnailUrl = safeUrl(m.thumbnailUrl);
      const label = str(m.label, 128);
      const startTime = num(m.startTime);
      const endTime = num(m.endTime);
      return {
        kind: "camera_clip",
        ...(camera ? { camera } : {}),
        ...(eventId ? { eventId } : {}),
        ...(clipUrl ? { clipUrl } : {}),
        ...(playbackUrl ? { playbackUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(label ? { label } : {}),
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
      };
    }
    case "file": {
      const name = str(m.name, 255);
      const previewUrl = safeUrl(m.previewUrl);
      const downloadUrl = safeUrl(m.downloadUrl);
      if (!name || !previewUrl || !downloadUrl) return null;
      const thumbnailUrl = safeUrl(m.thumbnailUrl);
      const path = str(m.path, 4096);
      const itemId = typeof m.itemId === "string" && BRAIN_ITEM_ID_RE.test(m.itemId) ? m.itemId : undefined;
      const size = num(m.size);
      return {
        kind: "file",
        ...(path ? { path } : {}),
        ...(itemId ? { itemId } : {}),
        name,
        mimeType: str(m.mimeType, 255) ?? mimeTypeForName(name),
        ...(size !== undefined ? { size } : {}),
        previewUrl,
        downloadUrl,
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      };
    }
    default:
      return null;
  }
}

/** Hard cap on cards per tool call, whatever the producer sent. */
export const MAX_MEDIA_PER_CALL = 12;

/**
 * Read `media` out of a tool result's `data` (also accepts the MCP-wrapped
 * `{ data: { media } }` shape). Returns only validated descriptors; invalid
 * entries are dropped, never repaired.
 */
export function parseChatMedia(data: unknown): ChatMedia[] {
  if (!data || typeof data !== "object") return [];
  const d = data as { media?: unknown; data?: { media?: unknown } | null };
  const raw = d.media ?? (d.data && typeof d.data === "object" ? d.data.media : undefined);
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: ChatMedia[] = [];
  for (const item of list.slice(0, MAX_MEDIA_PER_CALL)) {
    const parsed = parseOneChatMedia(item);
    if (parsed) out.push(parsed);
  }
  return out;
}
