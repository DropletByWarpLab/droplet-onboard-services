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
  useAuth: () => ({ completeSetup: vi.fn(), setupState: { appliance: "unclaimed", setupStep: "welcome", userTourCompleted: false } }),
}));

const fetchModelsMock = vi.fn();
const sendChatMock = vi.fn();

vi.mock("@/lib/api", () => ({
  // WARP-867 — AccountStep probes setup status on mount to pick its mode;
  // "required" keeps these walks on the normal create form.
  checkSetupRequired: vi.fn(async () => "required"),
  // WARP-165 — AccountStep probes the claim gate on mount; false = un-gated.
  checkClaimGateEnabled: vi.fn(async () => false),
  setupAdmin: vi.fn(async () => undefined),
  patchSetupStep: vi.fn(async () => undefined),
  loginUser: vi.fn(async () => undefined),
  // PR #373 — claim slots before account; the Claim step calls these.
  fetchApplianceContract: vi.fn(async () => ({
    appliance_id: "droplet-appliance-test",
    compute: { label: "Compute", value: "Local AI compute", online: true },
    storage: { label: "Storage", value: "Encrypted at rest", online: true },
    network: { label: "Network", value: "Local network", online: true },
    display: { label: "Display", value: "Front-panel display", online: true },
    supply_chain: { taa_compliant: true, ndaa_889_clear: true, summary: "Verified" },
  })),
  postClaim: vi.fn(async () => ({ claimed: true, next_step: "account" })),
  // PR #380 — org slots after account; the Org step calls postOrg.
  postOrg: vi.fn(async () => ({
    ok: true,
    slug: "acme",
    reserved_host: "droplet.local/acme",
    next_step: "internet",
  })),
  fetchDuckDnsStatus: vi.fn(async () => ({ configured: false })),
  // WARP-979 — the reworked AddressStep imports these (this walk skips the step).
  checkBoxName: vi.fn(async () => ({
    available: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
    authoritative: false,
  })),
  setBoxName: vi.fn(async () => ({
    ok: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
  })),
  setDuckDnsConfig: vi.fn(async () => ({ configured: false })),
  fetchDrives: vi.fn(async () => ({ drives: [], count: 0 })),
  updateDriveLabel: vi.fn(),
  fetchDiscoveredCameras: vi.fn(async () => []),
  acceptDiscoveredCamera: vi.fn(),
  fetchCameras: vi.fn(async () => []),
  removeCamera: vi.fn(async () => undefined),
  fetchVpnStatus: vi.fn(async () => ({
    configured: false,
    endpointConfigured: false,
  })),
  createVpnPeer: vi.fn(),
  fetchModels: () => fetchModelsMock(),
  sendChat: (req: unknown) => sendChatMock(req),
  // WARP-1036 — voice slots after ai; VoiceStep probes status on mount.
  fetchVoiceStatus: vi.fn(async () => ({
    state: "listening",
    listening: true,
    wake_loaded: true,
    wake_model: "hey_droplet",
    threshold: 0.7,
    last_wake_at: null,
  })),
  sayVoiceTest: vi.fn(async () => ({ ok: true, duration_s: 1.0 })),
  isVoiceUnavailableError: (err: unknown) =>
    (err as { code?: string } | null)?.code === "voice_unavailable",
  // PR #381 — team slots after ai; TeamStep imports postTeamInvite.
  postTeamInvite: vi.fn(async () => ({
    ok: true, token: "tok", email: "x@acme.co", role: "family",
    expires_at: "2026-06-04T00:00:00.000Z",
  })),
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
import { passClaimStep } from "./helpers/claim-step";
import { passOrgStep } from "./helpers/org-step";

async function advanceToAi() {
  fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  await passClaimStep();
  fireEvent.change(screen.getByPlaceholderText(/you@company\.com/i), {
    target: { value: "owner@warp.test" },
  });
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByPlaceholderText(/create a password/i), {
    target: { value: "Abcdefghijk1" },
  });
  fireEvent.change(screen.getByPlaceholderText(/repeat password/i), {
    target: { value: "Abcdefghijk1" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // PR #380 — pass through the org step (account → org → …).
  await passOrgStep();
  // PR #375 — TwoFactor step → skip (org → twofactor → wifi).
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
  });
  // Onboarding-Flow redesign — Internet split into Wi-Fi then Address. Skip both.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    // WARP-979 — the address step (Secured / name your box) → skip.
    fireEvent.click(
      screen.getByRole("button", { name: /skip — i'll do this later/i }),
    );
  });
  // WARP-933 — Storage and Cameras now RENDER (no silent auto-skip). Skip each:
  // storage → discovery → cameras → VPN preCheck → AI.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
  }
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
    // Primary CTA flipped (the label is "Continue" — this is not the terminal
    // step, so it must not claim to finish setup / go to the dashboard).
    expect(
      screen.getByRole("button", { name: /^continue$/i }),
    ).toBeInTheDocument();
  });

  it("the post-response Continue CTA advances to the voice step, then team (WARP-1036)", async () => {
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
        screen.getByRole("button", { name: /^continue$/i }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // WARP-1036 — voice now slots after ai (… → ai → voice → team → done),
    // so the AI step advances onto the voice try-it step first.
    expect(screen.getByText(/hey droplet/i)).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    // PR #381 — team still follows (voice → team → done).
    expect(screen.getByText(/bring in your team/i)).toBeInTheDocument();
  });

  it("Skip for now advances to the voice step without calling sendChat (WARP-1036)", async () => {
    fetchModelsMock.mockResolvedValue({ models: [LOCAL_MODEL] });
    render(<SetupPage />);
    await advanceToAi();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendChatMock).not.toHaveBeenCalled();
    // WARP-1036 — the step after ai is now voice; team follows on skip.
    expect(screen.getByText(/hey droplet/i)).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    });
    expect(screen.getByText(/bring in your team/i)).toBeInTheDocument();
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
