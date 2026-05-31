/**
 * WARP-174 — AI step.
 *
 * Validates:
 *   1. Renders the model picker (with a "loading" fallback) and the
 *      three sample-prompt radios.
 *   2. Default-selects the first local model (provider/ollama or a
 *      recognised local-family id prefix).
 *   3. "Ask the AI" calls sendChat with the chosen model + prompt,
 *      then renders the response in the AI response card.
 *   4. After a successful response the primary CTA flips to "Take me
 *      to the dashboard" and advances the wizard.
 *   5. "Skip for now" advances without calling sendChat.
 *   6. Privacy callout switches between "stays on this Droplet" and
 *      "uses internet" based on whether the selected model is local.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ completeSetup: vi.fn() }),
}));

const fetchModelsMock = vi.fn();
const sendChatMock = vi.fn();

vi.mock("@/lib/api", () => ({
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchVpnStatus: vi.fn(async () => ({
    configured: false,
    endpointConfigured: false,
  })),
  createVpnPeer: vi.fn(),
  fetchModels: () => fetchModelsMock(),
  sendChat: (req: unknown) => sendChatMock(req),
  fetchMatterDevices: vi.fn(async () => ({
    lights: [],
    switches: [],
    climate: [],
    sensors: [],
    media: [],
    covers: [],
    locks: [],
    other: [],
  })),
}));

import SetupPage from "@/app/setup/page";

async function advanceToAi() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  fireEvent.change(screen.getByPlaceholderText(/your-username/i), {
    target: { value: "owner" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/min\. 8 characters/i), {
    target: { value: "longenoughpw" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "longenoughpw" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // PR #375 — TwoFactor step → skip.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Internet → skip
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Storage auto-skip → Discovery → skip → Cameras auto-skip → VPN
  // preCheck → skip → AI.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Let AiStep's fetchModels effect resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const LOCAL_MODEL = {
  id: "llama3.1:8b-instruct-q8_0",
  provider: "ollama",
  name: "Llama 3.1 8B (instruct)",
  context_window: 8192,
};
const CLOUD_MODEL = {
  id: "gpt-4o-mini",
  provider: "openai",
  name: "GPT-4o mini",
  context_window: 128000,
};

describe("setup AI step (WARP-174)", () => {
  beforeEach(() => {
    fetchModelsMock.mockReset();
    sendChatMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the model picker, sample prompts, and a Skip link", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    render(<SetupPage />);
    await advanceToAi();

    expect(screen.getByText(/your private ai is ready/i)).toBeInTheDocument();
    expect(
      screen.getByText(/what can you help me with on this droplet\?/i),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/or type your own/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /ask the ai/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
  });

  it("default-selects the first local model and shows the private-AI callout", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL, CLOUD_MODEL] });
    render(<SetupPage />);
    await advanceToAi();

    const select = screen.getByLabelText(/model/i) as HTMLSelectElement;
    expect(select.value).toBe(LOCAL_MODEL.id);
    expect(
      screen.getByText(/your conversations stay on this droplet/i),
    ).toBeInTheDocument();
  });

  it("switches the privacy callout when the customer picks a cloud model", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL, CLOUD_MODEL] });
    render(<SetupPage />);
    await advanceToAi();

    const select = screen.getByLabelText(/model/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: CLOUD_MODEL.id } });
    expect(
      screen.getByText(/this model runs in the cloud/i),
    ).toBeInTheDocument();
  });

  it("Ask the AI sends the selected model + prompt, then renders the response", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    sendChatMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          role: "assistant",
          content: "Hi! I can help with files, cameras, and your network.",
        },
      }),
    });
    render(<SetupPage />);
    await advanceToAi();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Request shape — first sample prompt selected by default.
    expect(sendChatMock).toHaveBeenCalledTimes(1);
    const reqArg = sendChatMock.mock.calls[0][0];
    expect(reqArg.model).toBe(LOCAL_MODEL.id);
    expect(reqArg.stream).toBe(false);
    expect(reqArg.messages).toHaveLength(1);
    expect(reqArg.messages[0]).toEqual({
      role: "user",
      content: "What can you help me with on this Droplet?",
    });

    // Response surfaced.
    expect(screen.getByTestId("ai-response")).toBeInTheDocument();
    expect(
      screen.getByText(/i can help with files, cameras/i),
    ).toBeInTheDocument();
    // Primary CTA flipped.
    expect(
      screen.getByRole("button", { name: /take me to the dashboard/i }),
    ).toBeInTheDocument();
  });

  it("Take me to the dashboard advances to done", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    sendChatMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: "assistant", content: "OK" } }),
    });
    render(<SetupPage />);
    await advanceToAi();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /take me to the dashboard/i }),
      );
    });

    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
  });

  it("Skip for now advances to done without calling sendChat", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    render(<SetupPage />);
    await advanceToAi();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });

    expect(sendChatMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("welcome-flourish")).toBeInTheDocument();
  });

  it("surfaces an inline error when the chat request fails", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    sendChatMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "Model warming up" }),
    });
    render(<SetupPage />);
    await advanceToAi();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ask the ai/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/model warming up/i)).toBeInTheDocument();
    expect(screen.queryByTestId("ai-response")).not.toBeInTheDocument();
  });
});
