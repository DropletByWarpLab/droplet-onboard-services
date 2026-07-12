import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mutable state the mocked hook reads, so each test can vary the model list.
const state = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
  isLoading: false,
}));
vi.mock("@/lib/hooks/useModels", () => ({
  useModels: () => ({ models: state.models, isLoading: state.isLoading }),
}));

import { ModelSelector } from "@/components/ModelSelector";

const VISION = {
  id: "gpt-4o",
  provider: "openai",
  name: "GPT-4o",
  context_window: 128000,
  capabilities: { vision: true, tools: true },
};
const LOCAL = {
  id: "mistral:7b-instruct",
  provider: "ollama",
  name: "Mistral 7B",
  context_window: null,
  capabilities: { vision: false, tools: false },
};

describe("ModelSelector — vision marker", () => {
  beforeEach(() => {
    state.models = [VISION, LOCAL];
    state.isLoading = false;
  });

  it("shows the Vision pill when the selected model is vision-capable", () => {
    render(<ModelSelector value="gpt-4o" onChange={() => {}} />);
    expect(screen.getByText("Vision")).toBeInTheDocument();
  });

  it("hides the Vision pill for a non-vision selected model", () => {
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    expect(screen.queryByText("Vision")).not.toBeInTheDocument();
  });

  it("marks vision-capable options inline in the dropdown", () => {
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    expect(
      screen.getByRole("option", { name: /GPT-4o · vision/ }),
    ).toBeInTheDocument();
    // The non-vision model carries no marker.
    expect(
      screen.getByRole("option", { name: "Mistral 7B" }),
    ).toBeInTheDocument();
  });
});

// ── WARP-904: cloud key-gating ──
//
// ModelSelector never queries the keys API itself — it renders whatever
// `useModels()` returns, and `/api/llm/models` (ai-gateway's provider
// router) already excludes a cloud provider's models until its API key
// is configured (services/ai-gateway/providers/{anthropic,openai}_cloud.py
// — `list_models()` returns `[]` when `self.api_key` is unset). This
// test locks in that ModelSelector doesn't second-guess or re-add
// anything the gated list already left out.
describe("ModelSelector — cloud key-gating (reuses /api/llm/models)", () => {
  const ANTHROPIC = {
    id: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    name: "Claude 3.5 Sonnet",
    context_window: 200000,
    capabilities: { vision: false, tools: true },
  };

  it("never offers a cloud provider whose key isn't configured (absent from the gated list)", () => {
    // OpenAI has no key configured device-wide: the gateway already
    // dropped it from the response, so it's simply not in `models`.
    state.models = [LOCAL, ANTHROPIC];
    state.isLoading = false;
    render(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    expect(screen.queryByRole("option", { name: "GPT-4o" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Claude 3.5 Sonnet" })).toBeInTheDocument();
  });

  it("once a key is added and the list refetches, the newly-gated model becomes selectable", () => {
    // Before: only local + anthropic (no OpenAI key yet).
    state.models = [LOCAL, ANTHROPIC];
    const { rerender } = render(
      <ModelSelector value="mistral:7b-instruct" onChange={() => {}} />,
    );
    expect(screen.queryByRole("option", { name: "GPT-4o" })).not.toBeInTheDocument();

    // After: the key was saved in Settings and useModels()'s SWR poll
    // picked up the refreshed /api/llm/models response.
    state.models = [LOCAL, ANTHROPIC, VISION];
    rerender(<ModelSelector value="mistral:7b-instruct" onChange={() => {}} />);
    expect(
      screen.getByRole("option", { name: /GPT-4o · vision/ }),
    ).toBeInTheDocument();
  });
});
