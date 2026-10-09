/** Image bytes are obtained with the acting person's ACL, never from tool
 * arguments or a remote URL. doc-render fully decodes and reconstructs pixels
 * before adding a picture to either output format. */
import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { config } from "../config.js";
import { checkSpaceAccess } from "../middleware/space.js";
import { resolveAssertedUser } from "./asserted-user.service.js";
import { isPathUnderUser } from "./brain-memory.service.js";
import { ncFetchFileResponse, ncGetFileId } from "./nextcloud.client.js";
import { resolveFileDepartment } from "./file-registry.service.js";
import { readOfficeBytes, OfficeFileError } from "./office-file.client.js";

export const SLIDE_IMAGE_BYTES = 3 * 1024 * 1024;
export const SLIDE_IMAGES_BYTES = 12 * 1024 * 1024;
export const SLIDE_IMAGES_MAX = 12;
export const SLIDE_IMAGES_PIXELS = 16_000_000;
const sourcePath = z.string().min(1).max(4096).refine((v) => v.startsWith("/") && !v.startsWith("//") && !/[\\%\p{Cc}\p{Cf}\p{Cs}]/u.test(v) && v.split("/").every((part) => part !== "." && part !== ".."), "image path must be an absolute File Store path without traversal or encoded controls");
const label = z.string().max(300).refine((v) => !/[\p{Cs}\p{Cf}\x00-\x08\x0b-\x1f\x7f]/u.test(v), "image text contains unsupported controls");
const sourceSchema = z.object({ path: sourcePath.optional(), item_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), caption: label.optional(), alt: label.optional() }).strict()
  .refine((v) => Boolean(v.path) !== Boolean(v.item_id), "image requires exactly one path or item_id");
export class SlideAssetError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function withSlideDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SlideAssetError(408, "Slide image processing was cancelled or exceeded its deadline."));
    if (signal.aborted) { abort(); void work.catch(() => {}); return; }
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function imageName(name: string): void {
  if (!/\.(png|jpe?g)$/i.test(name)) throw new SlideAssetError(400, "Slide image sources must be PNG or JPEG files.");
}

/** Inspect dimensions before forwarding bytes; the authenticated writer's
 * Pillow decode still validates CRCs, completeness, frame count and metadata. */
export function validateSlideRaster(bytes: Buffer): { width: number; height: number } {
  let width = 0; let height = 0;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR") {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let cursor = 2;
    while (cursor + 4 <= bytes.length) {
      if (bytes[cursor++] !== 0xff) break;
      while (cursor < bytes.length && bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (cursor + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(cursor);
      if (length < 2 || cursor + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(cursor + 3); width = bytes.readUInt16BE(cursor + 5); break;
      }
      cursor += length;
    }
  }
  if (!width || !height) throw new SlideAssetError(400, "Slide source does not contain a supported PNG or JPEG raster.");
  if (width > 8192 || height > 8192 || width * height > 16_000_000) throw new SlideAssetError(413, "Slide image exceeds the 8192 dimension or 16 million pixel limit.");
  return { width, height };
}

export async function hydrateSlideImages(
  slides: unknown[], context: { prisma: PrismaClient; req: Request; actor: { id: string; role: string }; token: string; login: string; signal: AbortSignal },
): Promise<unknown[]> {
  const { prisma, req, actor, token, login, signal } = context;
  // Validate every public descriptor before a read. A model-provided hydrated
  // image (including content_base64) can never cross this seam.
  const sources = slides.map((slide) => {
    if (!slide || typeof slide !== "object" || Array.isArray(slide) || !("image" in slide) || slide.image === null || slide.image === undefined) return null;
    const parsed = sourceSchema.safeParse(slide.image);
    if (!parsed.success) throw new SlideAssetError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
    return parsed.data;
  });
  if (sources.filter(Boolean).length > SLIDE_IMAGES_MAX) throw new SlideAssetError(413, "Decks accept at most 12 image slides.");
  const hydrated: unknown[] = [];
  let totalBytes = 0; let totalPixels = 0;
  async function currentReader() {
    if (!config.AUTH_ENABLED && actor.id === "dev") return actor;
    const current = await withSlideDeadline(resolveAssertedUser(prisma, actor.id), signal);
    if (!current.ok || current.user.id !== actor.id || !["owner", "admin", "family"].includes(current.user.role)) throw new SlideAssetError(403, "The acting person's image access is no longer available.");
    return { id: current.user.id, role: current.user.role };
  }
  for (let index = 0; index < slides.length; index++) {
    const source = sources[index];
    if (!source) { hydrated.push(slides[index]); continue; }
    await currentReader();
    let bytes: Buffer;
    try {
      const cap = Math.min(SLIDE_IMAGE_BYTES, SLIDE_IMAGES_BYTES - totalBytes);
      if (cap <= 0) throw new SlideAssetError(413, "Deck source images exceed 12 MiB.");
      if (source.item_id) {
        const item = await withSlideDeadline(prisma.brainMemoryItem.findUnique({ where: { id: source.item_id } }), signal);
        if (!item || item.userId !== actor.id || !item.hasOriginalBytes || !isPathUnderUser(actor.id, item.storagePath)) throw new SlideAssetError(404, "Slide image attachment not found.");
        if (item.ingestPolicy === "await_approval") throw new SlideAssetError(409, "Approve the image attachment before adding it to slides.");
        imageName(item.filename);
        await currentReader();
        bytes = await readOfficeBytes(Readable.toWeb(createReadStream(item.storagePath)) as ReadableStream<Uint8Array>, cap, signal);
      } else {
        imageName(source.path!);
        const fileId = await withSlideDeadline(ncGetFileId(token, login, source.path!, signal), signal);
        if (fileId === null) throw new SlideAssetError(404, "Slide image file not found.");
        const departmentId = await withSlideDeadline(resolveFileDepartment(prisma, fileId), signal);
        const reader = await currentReader();
        if (departmentId) {
          const access = await withSlideDeadline(checkSpaceAccess(prisma, req, reader, departmentId, "reader"), signal);
          if (!access.allowed) throw new SlideAssetError(access.status, access.error);
        }
        const response = await withSlideDeadline(ncFetchFileResponse(token, login, source.path!, undefined, signal), signal);
        if (!response) throw new SlideAssetError(404, "Slide image file not found.");
        bytes = await readOfficeBytes(response.body, cap, signal);
      }
    } catch (error) {
      if (error instanceof OfficeFileError) throw new SlideAssetError(error.code === "TOO_LARGE" ? 413 : error.code === "TIMEOUT" ? 408 : 400, "Slide images must be bounded valid PNG/JPEG files; the read failed or exceeded its deadline.");
      throw error;
    }
    const size = validateSlideRaster(bytes);
    totalPixels += size.width * size.height;
    if (totalPixels > SLIDE_IMAGES_PIXELS) throw new SlideAssetError(413, "Deck images exceed the 16 million total pixel budget. Use smaller images.");
    totalBytes += bytes.length;
    hydrated.push({ ...(slides[index] as Record<string, unknown>), image: { content_base64: bytes.toString("base64"), ...(source.caption !== undefined ? { caption: source.caption } : {}), ...(source.alt !== undefined ? { alt: source.alt } : {}) } });
  }
  return hydrated;
}
