/**
 * WARP-1511 — blank/stale `ai.model.chat` resolves to the installed local
 * model instead of reporting a permanent blank on a perfectly healthy box.
 *
 * WARP-1112 shipped `resolveActiveChatModel` returning null for BOTH a
 * blank/never-set stored value AND a stored tag that's no longer installed —
 * even though the seed row's own comment (workspace-settings.service.ts)
 * already promised "the orchestrator + dashboard then fall back to
 * LLM_MODEL / the single installed model". This file locks the fallback
 * that promise never actually implemented, plus the pre-existing
 * (unchanged) `readActiveChatModel` / `localModelIdentifiers` contracts.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  ACTIVE_CHAT_MODEL_KEY,
  localModelIdentifiers,
  readActiveChatModel,
  resolveActiveChatModel,
} from "./active-model.service.js";
import type { ModelInfo } from "../types/index.js";

/** Minimal `prisma.workspaceSetting.findUnique` stub. */
function prismaStub(row: { valueJson: unknown } | null): PrismaClient {
  return {
    workspaceSetting: {
      findUnique: vi.fn().mockResolvedValue(row),
    },
  } as unknown as PrismaClient;
}

describe("readActiveChatModel (WARP-1112, unchanged by WARP-1511)", () => {
  it("returns null for the seeded blank string (the explicit unset state)", async () => {
    const prisma = prismaStub({ valueJson: "" });
    expect(await readActiveChatModel(prisma)).toBeNull();
  });

  it("returns null for a whitespace-only value", async () => {
    const prisma = prismaStub({ valueJson: "   " });
    expect(await readActiveChatModel(prisma)).toBeNull();
  });

  it("returns null when the row doesn't exist yet (pre-migration DB)", async () => {
    const prisma = prismaStub(null);
    expect(await readActiveChatModel(prisma)).toBeNull();
  });

  it("returns the trimmed stored tag", async () => {
    const prisma = prismaStub({ valueJson: "  gpt-oss:20b  " });
    expect(await readActiveChatModel(prisma)).toBe("gpt-oss:20b");
  });

  it("reads the canonical ai.model.chat key", async () => {
    const prisma = prismaStub({ valueJson: "gpt-oss:20b" });
    await readActiveChatModel(prisma);
    expect(prisma.workspaceSetting.findUnique).toHaveBeenCalledWith({
      where: { key: ACTIVE_CHAT_MODEL_KEY },
      select: { valueJson: true },
    });
    expect(ACTIVE_CHAT_MODEL_KEY).toBe("ai.model.chat");
  });
});

describe("localModelIdentifiers (unchanged by WARP-1511)", () => {
  it("collects id + name for ollama-provider entries only", () => {
    const models: ModelInfo[] = [
      { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: null },
      { id: "claude-sonnet", provider: "anthropic", name: "claude-sonnet", context_window: null },
    ];
    expect(localModelIdentifiers(models)).toEqual(new Set(["gpt-oss:20b"]));
  });

  it("returns an empty set for an empty models list", () => {
    expect(localModelIdentifiers([])).toEqual(new Set());
  });
});

describe("resolveActiveChatModel (WARP-1511 — blank/stale fallback)", () => {
  it("falls back to the sole installed model when the stored value is blank — the reported bug", () => {
    // Live evidence: ai.model.chat is "" (→ null via readActiveChatModel)
    // and gpt-oss:20b is the only installed model.
    expect(resolveActiveChatModel(null, new Set(["gpt-oss:20b"]))).toBe(
      "gpt-oss:20b",
    );
  });

  it("falls back to the first installed model (Set order) when blank and several are installed", () => {
    const installed = new Set(["gpt-oss:20b", "llama3.2:3b"]);
    expect(resolveActiveChatModel(null, installed)).toBe("gpt-oss:20b");
  });

  it("falls back to the first installed model when the stored tag is no longer installed", () => {
    const installed = new Set(["gpt-oss:20b", "llama3.2:3b"]);
    expect(resolveActiveChatModel("gemma4:26b", installed)).toBe(
      "gpt-oss:20b",
    );
  });

  it("returns the stored value unchanged when it IS installed", () => {
    const installed = new Set(["gpt-oss:20b", "llama3.2:3b"]);
    expect(resolveActiveChatModel("llama3.2:3b", installed)).toBe(
      "llama3.2:3b",
    );
  });

  it("stays honestly null when nothing is installed, even with a stored value", () => {
    expect(resolveActiveChatModel("gpt-oss:20b", new Set())).toBeNull();
  });

  it("stays null when nothing is installed and nothing is stored", () => {
    expect(resolveActiveChatModel(null, new Set())).toBeNull();
  });

  it("passes a valid stored value through unresolved when the installed set is unknown (probe failed) — never throws", () => {
    expect(() => resolveActiveChatModel("gpt-oss:20b", null)).not.toThrow();
    expect(resolveActiveChatModel("gpt-oss:20b", null)).toBe("gpt-oss:20b");
  });

  it("passes a blank stored value through as null when the installed set is unknown — never fabricates a fallback from an unconfirmed list", () => {
    expect(resolveActiveChatModel(null, null)).toBeNull();
  });
});
