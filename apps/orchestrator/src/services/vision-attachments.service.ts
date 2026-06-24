import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PrismaClient } from "@prisma/client";

import type { ChatMessage, ContentBlock } from "../types/index.js";
import { contentToText } from "../types/index.js";
import { isPathUnderUser } from "./brain-memory.service.js";

export interface ImageBlocksResult {
  /** OpenAI-style image_url blocks, in oldest→newest order, capped. */
  blocks: ContentBlock[];
  /** itemIds actually turned into image blocks (so the caller can exclude
   *  them from the OCR-text path and avoid a misleading "no text" note). */
  usedItemIds: string[];
}

/**
 * Build image content blocks from the caller's attachments that are images with
 * a normalized vision render on disk.
 *
 * - Ownership + readiness enforced in the query (`userId`, `status=ready`,
 *   `hasVisionRender`, `mimeType` startsWith "image/"), same posture as the
 *   OCR-text path — a foreign/unknown/not-ready id simply drops out.
 * - `itemIds` are taken in the caller's order (oldest→newest across the
 *   conversation). The most recent `maxImages` are kept; older images are
 *   dropped to bound token cost.
 * - Each render is base64'd into a `data:image/jpeg;base64,...` URL. A render
 *   missing on disk is skipped (the caller falls back to OCR for that item).
 */
export async function buildImageBlocks(
  prisma: PrismaClient,
  userId: string,
  itemIds: string[],
  opts: { maxImages: number },
): Promise<ImageBlocksResult> {
  const ids = Array.from(new Set(itemIds));
  if (ids.length === 0) return { blocks: [], usedItemIds: [] };

  const items = await prisma.brainMemoryItem.findMany({
    where: {
      id: { in: ids },
      userId,
      status: "ready",
      hasVisionRender: true,
      mimeType: { startsWith: "image/" },
    },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  // Preserve the caller's order, then keep only the most recent N images.
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((i): i is NonNullable<typeof i> => Boolean(i));
  const capped = ordered.slice(-opts.maxImages);

  const blocks: ContentBlock[] = [];
  const usedItemIds: string[] = [];
  for (const item of capped) {
    const renderPath = join(dirname(item.storagePath), "vision.jpg");
    // Defense-in-depth: never read outside the user's tree even if storagePath
    // were somehow tampered with.
    if (!isPathUnderUser(userId, renderPath)) continue;
    try {
      const bytes = await readFile(renderPath);
      const url = `data:image/jpeg;base64,${bytes.toString("base64")}`;
      blocks.push({ type: "image_url", image_url: { url } });
      usedItemIds.push(item.id);
    } catch {
      // Render missing/unreadable on disk → skip; OCR fallback covers it.
    }
  }
  return { blocks, usedItemIds };
}

/**
 * Attach image blocks to the most recent user message, converting its content
 * to `[{text}, ...imageBlocks]`. No-op when there is no user message or no
 * blocks. Mutates the array in place (replaces the target message object).
 */
export function attachImageBlocksToLastUserMessage(
  messages: ChatMessage[],
  blocks: ContentBlock[],
): void {
  if (blocks.length === 0) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const text = contentToText(messages[i].content);
      const textBlocks: ContentBlock[] = text ? [{ type: "text", text }] : [];
      messages[i] = { ...messages[i], content: [...textBlocks, ...blocks] };
      return;
    }
  }
}

export type VisionRouteMode = "image" | "ocr" | "none";

export interface VisionRoute {
  model: string;
  mode: VisionRouteMode;
}

/**
 * Decide how an attachment turn is routed (pure — unit-tested in isolation):
 *
 * - no images          → `none` (selected model, unchanged).
 * - selected can see    → `image` on the selected model.
 * - else a configured local VISION_MODEL can see → `image` on that model
 *   (auto-route, this turn only; never silently to cloud — cloud vision is
 *   reached by explicitly selecting a cloud model, which lands in the case
 *   above).
 * - otherwise            → `ocr` (selected model + extracted-text fallback).
 */
export function decideVisionRoute(opts: {
  hasImages: boolean;
  selectedModel: string;
  selectedVision: boolean;
  visionModel: string | null;
  visionModelVision: boolean;
}): VisionRoute {
  if (!opts.hasImages) return { model: opts.selectedModel, mode: "none" };
  if (opts.selectedVision) return { model: opts.selectedModel, mode: "image" };
  if (opts.visionModel && opts.visionModelVision) {
    return { model: opts.visionModel, mode: "image" };
  }
  return { model: opts.selectedModel, mode: "ocr" };
}
