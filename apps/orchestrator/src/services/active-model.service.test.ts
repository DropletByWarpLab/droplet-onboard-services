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
 * (unchanged) `readActiveChatModel` contract.
 *
 * WARP-3047 — the blank/stale fallback now prefers LLM_MODEL (when it is
 * installed) over "first listed", and `resolveActiveModel` is the ONE async
 * answer every server-side consumer asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const getCachedModelListing = vi.hoisted(() => vi.fn());
vi.mock("./ai-gateway.client.js", () => ({ getCachedModelListing }));
const warmDefaultModel = vi.hoisted(() => vi.fn(async (_model?: string | null) => undefined));
vi.mock("./model-readiness.service.js", () => ({ warmDefaultModel }));

import {
  ACTIVE_CHAT_MODEL_KEY,
  resolveStoredChatModel,
  readActiveChatModel,
  resolveActiveChatModel,
  resolveActiveModel,
  warmActiveModel,
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

// The WARP-1511 "first installed" cases below predate the LLM_MODEL
// preference; pin the env blank so the host's own value can't leak in.
beforeEach(() => {
  vi.stubEnv("LLM_MODEL", "");
  getCachedModelListing.mockReset();
  warmDefaultModel.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("resolveStoredChatModel (WARP-2882 — legacy display name → runtime id)", () => {
  const models: ModelInfo[] = [
    { id: "llama3.2:3b", provider: "local", name: "Llama3.2 3B", context_window: null },
    { id: "docker.io/ai/gpt-oss:20B-F16", provider: "local", name: "Gpt-oss 20B F16", context_window: null },
    { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet", context_window: 200000 },
  ];

  it("maps a stored DISPLAY name to the id instead of falling back to the first model", () => {
    expect(resolveStoredChatModel("Gpt-oss 20B F16", models)).toBe("docker.io/ai/gpt-oss:20B-F16");
  });

  it("leaves a stored id unchanged", () => {
    expect(resolveStoredChatModel("docker.io/ai/gpt-oss:20B-F16", models)).toBe("docker.io/ai/gpt-oss:20B-F16");
  });

  it("stale / blank → first installed LOCAL id (WARP-1511 fallback kept)", () => {
    expect(resolveStoredChatModel("gemma4:26b", models)).toBe("llama3.2:3b");
    expect(resolveStoredChatModel(null, models)).toBe("llama3.2:3b");
  });

  it("never resolves to a cloud model, even by its display name", () => {
    expect(resolveStoredChatModel("Claude Sonnet", models)).toBe("llama3.2:3b");
    expect(resolveStoredChatModel("Claude Sonnet", [models[2]])).toBeNull();
  });

  it("passes the stored value through when the installed set is unknown", () => {
    expect(resolveStoredChatModel("Gpt-oss 20B F16", null)).toBe("Gpt-oss 20B F16");
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

// ── WARP-3047 ────────────────────────────────────────────────────────────
// Two installed models, listed B-first (DMR /api/tags order is not a
// preference). A is what the box was provisioned with (LLM_MODEL): it is
// what the boot pull fetched and what every consumer used before this
// ticket, so a blank row must mean A — not whichever id DMR lists first.
const A = "docker.io/ai/gpt-oss:20B-F16";
const B = "docker.io/ai/qwen3:8B-Q4_K_M";
const listed: ModelInfo[] = [
  { id: B, provider: "local", name: "Qwen3 8B Q4 K M", context_window: null, capabilities: { tools: true } },
  { id: A, provider: "local", name: "Gpt-oss 20B F16", context_window: null, capabilities: { tools: true } },
];

describe("blank/stale fallback prefers LLM_MODEL (WARP-3047)", () => {
  it("installed=[B, A], blank row, LLM_MODEL=A → A (not the first-listed B)", () => {
    vi.stubEnv("LLM_MODEL", A);
    expect(resolveStoredChatModel(null, listed)).toBe(A);
    expect(resolveActiveChatModel(null, new Set([B, A]))).toBe(A);
  });

  it("a stale stored tag also falls back to LLM_MODEL first", () => {
    vi.stubEnv("LLM_MODEL", A);
    expect(resolveStoredChatModel("gemma4:26b", listed)).toBe(A);
  });

  it("an installed stored choice still wins over LLM_MODEL", () => {
    vi.stubEnv("LLM_MODEL", A);
    expect(resolveStoredChatModel(B, listed)).toBe(B);
  });

  it("LLM_MODEL that is NOT installed falls through to the first installed model", () => {
    vi.stubEnv("LLM_MODEL", "gpt-oss:20b");
    expect(resolveStoredChatModel(null, listed)).toBe(B);
  });

  it("never falls back to a cloud model even when LLM_MODEL names one", () => {
    vi.stubEnv("LLM_MODEL", "claude-sonnet");
    const withCloud: ModelInfo[] = [
      ...listed,
      { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet", context_window: 200000 },
    ];
    expect(resolveStoredChatModel(null, withCloud)).toBe(B);
  });
});

function listing(models: ModelInfo[], degradedProviders: string[] = []) {
  return { models, degradedProviders };
}

describe("resolveActiveModel — the one async answer (WARP-3047)", () => {
  it("returns the stored choice when it is installed", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(listing(listed));
    expect(await resolveActiveModel(prismaStub({ valueJson: B }))).toBe(B);
  });

  it("blank row + installed=[B, A] + LLM_MODEL=A → A", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(listing(listed));
    expect(await resolveActiveModel(prismaStub({ valueJson: "" }))).toBe(A);
  });

  it("maps a legacy display-name row to the runtime id", async () => {
    getCachedModelListing.mockResolvedValue(listing(listed));
    expect(await resolveActiveModel(prismaStub({ valueJson: "Qwen3 8B Q4 K M" }))).toBe(B);
  });

  it("unreachable listing: non-strict passes the stored choice through", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(null);
    expect(await resolveActiveModel(prismaStub({ valueJson: B }))).toBe(B);
  });

  it("unreachable listing + blank row: non-strict falls back to LLM_MODEL", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(null);
    expect(await resolveActiveModel(prismaStub({ valueJson: "" }))).toBe(A);
  });

  it("unreachable listing: strict answers null (filing semantics — never an unconfirmed model)", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(null);
    expect(await resolveActiveModel(prismaStub({ valueJson: B }), { strict: true })).toBeNull();
  });

  it("a DEGRADED local listing counts as unconfirmed", async () => {
    vi.stubEnv("LLM_MODEL", A);
    // The local provider raised during the fan-out: its list is partial.
    getCachedModelListing.mockResolvedValue(listing([listed[0]], ["local"]));
    expect(await resolveActiveModel(prismaStub({ valueJson: "" }))).toBe(A);
    expect(await resolveActiveModel(prismaStub({ valueJson: "" }), { strict: true })).toBeNull();
  });

  it("a degraded CLOUD provider does not unconfirm the local list", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(listing(listed, ["anthropic"]));
    expect(await resolveActiveModel(prismaStub({ valueJson: B }), { strict: true })).toBe(B);
  });

  it("a confirmed-empty listing: non-strict → LLM_MODEL, strict → null", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(listing([]));
    expect(await resolveActiveModel(prismaStub({ valueJson: "" }))).toBe(A);
    expect(await resolveActiveModel(prismaStub({ valueJson: "" }), { strict: true })).toBeNull();
  });

  it("nothing stored, nothing listed, nothing configured → null (never a hardcoded tag)", async () => {
    getCachedModelListing.mockResolvedValue(null);
    expect(await resolveActiveModel(prismaStub(null))).toBeNull();
  });

  it("a settings-read failure degrades to the blank-row answer, never throws", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(listing(listed));
    const prisma = {
      workspaceSetting: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
    } as unknown as PrismaClient;
    expect(await resolveActiveModel(prisma)).toBe(A);
  });

  it("requireTools: an active model that explicitly cannot call tools falls back to LLM_MODEL", async () => {
    vi.stubEnv("LLM_MODEL", A);
    const visionOnly: ModelInfo[] = [
      { ...listed[0], capabilities: { vision: true, tools: false } },
      listed[1],
    ];
    getCachedModelListing.mockResolvedValue(listing(visionOnly));
    expect(await resolveActiveModel(prismaStub({ valueJson: B }), { requireTools: true })).toBe(A);
    // Without the requirement the owner's choice stands.
    expect(await resolveActiveModel(prismaStub({ valueJson: B }))).toBe(B);
  });

  it("requireTools: unknown tool capability keeps the active model (only an explicit false falls back)", async () => {
    vi.stubEnv("LLM_MODEL", A);
    const unknownCaps: ModelInfo[] = [{ ...listed[0], capabilities: undefined }, listed[1]];
    getCachedModelListing.mockResolvedValue(listing(unknownCaps));
    expect(await resolveActiveModel(prismaStub({ valueJson: B }), { requireTools: true })).toBe(B);
  });
});

describe("warmActiveModel (WARP-3047)", () => {
  it("warms the ACTIVE model, not LLM_MODEL", async () => {
    vi.stubEnv("LLM_MODEL", A);
    getCachedModelListing.mockResolvedValue(listing(listed));
    await warmActiveModel(prismaStub({ valueJson: B }));
    expect(warmDefaultModel).toHaveBeenCalledTimes(1);
    expect(warmDefaultModel).toHaveBeenCalledWith(B);
  });

  it("hands null through when nothing resolves (the warm itself skips)", async () => {
    getCachedModelListing.mockResolvedValue(null);
    await warmActiveModel(prismaStub(null));
    expect(warmDefaultModel).toHaveBeenCalledWith(null);
  });
});
