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
