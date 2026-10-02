/**
 * WARP-3048 — the setup wizard's AI step opens on the box's active model.
 *
 * It used to pick the FIRST local model and ignore `defaultModel`, so on a
 * multi-model box the wizard's proof turn could run on a different model
 * from the one the box answers with.
 *
 * Renders <AiStep> in isolation — same choreography as
 * setup.ai.model-degraded.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import React from "react";

const fetchModelsMock = vi.fn();

vi.mock("@/lib/api", () => ({
  checkSetupRequired: vi.fn(async () => "required"),
  checkClaimGateEnabled: vi.fn(async () => false),
  fetchModels: () => fetchModelsMock(),
  sendChat: vi.fn(),
}));

import { AiStep } from "@/components/setup/steps/AiStep";

const FIRST_LOCAL = { id: "llama3.2:3b", provider: "local", name: "Llama 3.2 3B", context_window: null };
const ACTIVE = { id: "gpt-oss:20b", provider: "local", name: "GPT-OSS 20B", context_window: null };
const CLOUD = { id: "gpt-4o", provider: "openai", name: "GPT-4o", context_window: null };

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function modelSelect(): HTMLSelectElement {
  return document.getElementById("ai-step-model") as HTMLSelectElement;
}

describe("setup AI step — defaults to the box's active model (WARP-3048)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchModelsMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("selects defaultModel over the first local model", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [FIRST_LOCAL, ACTIVE],
      defaultModel: ACTIVE.id,
    });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    expect(modelSelect().value).toBe(ACTIVE.id);
  });

  it("ignores a defaultModel that is not a listed local model", async () => {
    fetchModelsMock.mockResolvedValue({
      models: [CLOUD, FIRST_LOCAL],
      defaultModel: CLOUD.id,
    });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    expect(modelSelect().value).toBe(FIRST_LOCAL.id);
  });
});
