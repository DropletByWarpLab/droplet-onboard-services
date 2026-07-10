/**
 * WARP-1119 — AI step: optional personality preset dropdown.
 *
 * The wizard's `ai` step may preselect a persona preset (architecture brief
 * §7.3): a single dropdown, no step-order change, no setup-state semantics
 * change. The control is strictly optional plumbing on top of the existing
 * persona API:
 *
 *   - Mount → fetchPersona(). Success renders the dropdown pre-selected to
 *     the live preset; ANY failure hides the control entirely — the wizard
 *     never blocks (and never errors) on personality.
 *   - Change → optimistic select + patchPersona({ preset }). A rejected
 *     PATCH reverts the selection and shows the step's soft-notice styling
 *     (never the red error box — personality is not a wizard failure).
 *
 * Renders <AiStep> in isolation, same as setup.ai.first-ask.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  act,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import React from "react";

import { PRESET_TILES } from "@/lib/persona-preview";

const fetchModelsMock = vi.fn();
const sendChatMock = vi.fn();
const fetchPersonaMock = vi.fn();
const patchPersonaMock = vi.fn();

vi.mock("@/lib/api", () => ({
  checkSetupRequired: vi.fn(async () => "required"),
  checkClaimGateEnabled: vi.fn(async () => false),
  fetchModels: () => fetchModelsMock(),
  sendChat: (req: unknown) => sendChatMock(req),
  fetchPersona: () => fetchPersonaMock(),
  patchPersona: (update: unknown) => patchPersonaMock(update),
}));

import { AiStep } from "@/components/setup/steps/AiStep";

const LOCAL_MODEL = {
  id: "gpt-oss:20b",
  provider: "ollama",
  name: "Gpt Oss 20B",
  context_window: null,
};

const PERSONA = {
  preset: "warm_friendly",
  verbosity: "balanced",
  useFirstNames: true,
  customInstructions: "",
};

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("setup AI step — persona preset dropdown (WARP-1119)", () => {
  beforeEach(() => {
    fetchModelsMock.mockReset();
    sendChatMock.mockReset();
    fetchPersonaMock.mockReset();
    patchPersonaMock.mockReset();
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    fetchPersonaMock.mockResolvedValue({ ...PERSONA });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders every preset and pre-selects the live one", async () => {
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    const select = screen.getByLabelText("Personality") as HTMLSelectElement;
    expect(select.value).toBe("warm_friendly");
    for (const tile of PRESET_TILES) {
      expect(
        within(select).getByRole("option", { name: tile.name }),
      ).toBeTruthy();
    }
  });

  it("PATCHes the preset on change and keeps the optimistic value", async () => {
    patchPersonaMock.mockResolvedValue({ ...PERSONA, preset: "founder" });
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    const select = screen.getByLabelText("Personality") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "founder" } });
    await flushMicrotasks();

    expect(patchPersonaMock).toHaveBeenCalledTimes(1);
    expect(patchPersonaMock).toHaveBeenCalledWith({ preset: "founder" });
    expect(select.value).toBe("founder");
  });

  it("reverts the selection and shows a soft note when the PATCH fails", async () => {
    patchPersonaMock.mockRejectedValue(new Error("boom"));
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    const select = screen.getByLabelText("Personality") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "direct_technical" } });
    await flushMicrotasks();

    expect(select.value).toBe("warm_friendly");
    // Soft-notice styling (role=status), never the red error box.
    expect(screen.getByTestId("persona-save-note")).toBeTruthy();
    expect(
      screen.queryByText(/Something went wrong asking the AI/),
    ).toBeNull();
  });

  it("hides the control entirely when the persona fetch fails", async () => {
    fetchPersonaMock.mockRejectedValue(new Error("403"));
    render(<AiStep onComplete={vi.fn()} onSkip={vi.fn()} />);
    await flushMicrotasks();

    expect(screen.queryByLabelText("Personality")).toBeNull();
    // The rest of the step is untouched — model picker still there.
    expect(screen.getByLabelText("Model")).toBeTruthy();
  });
});
