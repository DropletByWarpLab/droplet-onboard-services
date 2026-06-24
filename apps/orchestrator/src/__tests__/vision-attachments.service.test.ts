import { describe, expect, it, vi } from "vitest";

// Mock fs + the path guard so the unit test exercises ordering/cap/dedup logic
// without touching disk or the BRAIN_ROOT env.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (p: string) => {
    if (String(p).includes("missing")) throw new Error("ENOENT");
    return Buffer.from(`bytes-for:${p}`);
  }),
}));
vi.mock("../services/brain-memory.service.js", () => ({
  isPathUnderUser: () => true,
}));

import type { ChatMessage } from "../types/index.js";
import {
  attachImageBlocksToLastUserMessage,
  buildImageBlocks,
  decideVisionRoute,
} from "../services/vision-attachments.service.js";

function fakePrisma(items: Array<Record<string, unknown>>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    brainMemoryItem: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        calls.push(args);
        return items;
      }),
    },
  } as never;
}

const img = (id: string, suffix = "jpg") => ({
  id,
  userId: "alice",
  status: "ready",
  mimeType: `image/${suffix === "jpg" ? "jpeg" : suffix}`,
  hasVisionRender: true,
  storagePath: `/data/brain-memory/alice/${id}/original.png`,
});

describe("decideVisionRoute", () => {
  const base = {
    selectedModel: "mistral:7b-instruct",
    visionModel: "llava:7b",
  };
  it("returns none when there are no images", () => {
    expect(
      decideVisionRoute({
        ...base,
        hasImages: false,
        selectedVision: false,
        visionModelVision: true,
      }),
    ).toEqual({ model: "mistral:7b-instruct", mode: "none" });
  });
  it("uses the selected model when it is vision-capable", () => {
    expect(
      decideVisionRoute({
        ...base,
        hasImages: true,
        selectedVision: true,
        visionModelVision: true,
      }),
    ).toEqual({ model: "mistral:7b-instruct", mode: "image" });
  });
  it("auto-routes to the local VISION_MODEL when selected can't see", () => {
    expect(
      decideVisionRoute({
        ...base,
        hasImages: true,
        selectedVision: false,
        visionModelVision: true,
      }),
    ).toEqual({ model: "llava:7b", mode: "image" });
  });
  it("falls back to OCR when no vision model is available", () => {
    expect(
      decideVisionRoute({
        hasImages: true,
        selectedModel: "mistral:7b-instruct",
        selectedVision: false,
        visionModel: null,
        visionModelVision: false,
      }),
    ).toEqual({ model: "mistral:7b-instruct", mode: "ocr" });
  });
});

describe("buildImageBlocks", () => {
  it("builds data-URL blocks, deduped, capped to the most recent N", async () => {
    const prisma = fakePrisma([img("a"), img("b"), img("c")]);
    const res = await buildImageBlocks(
      prisma,
      "alice",
      ["a", "b", "a", "c"], // dup 'a'
      { maxImages: 2 },
    );
    // dedup → [a,b,c]; cap to most-recent 2 → [b,c]
    expect(res.usedItemIds).toEqual(["b", "c"]);
    expect(res.blocks).toHaveLength(2);
    expect(res.blocks[0]).toMatchObject({ type: "image_url" });
    expect(
      (res.blocks[0] as { image_url: { url: string } }).image_url.url,
    ).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("scopes the query to owned, ready, rendered images", async () => {
    const prisma = fakePrisma([img("a")]);
    await buildImageBlocks(prisma, "alice", ["a"], { maxImages: 3 });
    const where = (prisma as never as { calls: Array<{ where: Record<string, unknown> }> })
      .calls[0].where;
    expect(where).toMatchObject({
      userId: "alice",
      status: "ready",
      hasVisionRender: true,
      mimeType: { startsWith: "image/" },
    });
  });

  it("skips an item whose render is missing on disk", async () => {
    const missing = { ...img("m"), storagePath: "/data/brain-memory/alice/missing/original.png" };
    const prisma = fakePrisma([missing, img("ok")]);
    const res = await buildImageBlocks(prisma, "alice", ["m", "ok"], {
      maxImages: 5,
    });
    expect(res.usedItemIds).toEqual(["ok"]);
    expect(res.blocks).toHaveLength(1);
  });

  it("returns empty for no itemIds", async () => {
    const prisma = fakePrisma([]);
    const res = await buildImageBlocks(prisma, "alice", [], { maxImages: 3 });
    expect(res).toEqual({ blocks: [], usedItemIds: [] });
  });
});

describe("attachImageBlocksToLastUserMessage", () => {
  it("converts the last user message to text + image blocks", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "what is this?" },
    ];
    attachImageBlocksToLastUserMessage(messages, [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
    ]);
    expect(messages[1].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
    ]);
    expect(messages[0].content).toBe("sys"); // untouched
  });

  it("is a no-op with no blocks", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    attachImageBlocksToLastUserMessage(messages, []);
    expect(messages[0].content).toBe("hi");
  });
});
