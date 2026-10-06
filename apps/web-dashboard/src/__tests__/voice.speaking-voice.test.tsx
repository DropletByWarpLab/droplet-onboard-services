import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/api", () => ({
  fetchSpeakingVoice: vi.fn(),
  sayVoiceTest: vi.fn(),
  setSpeakingVoice: vi.fn(),
}));

import { SpeakingVoiceSection } from "@/components/voice/SpeakingVoiceSection";
import { fetchSpeakingVoice, sayVoiceTest, setSpeakingVoice } from "@/lib/api";

const catalog = {
  available: true, selectable: true, voice: "af_heart", fault: null,
  voices: [{ id: "af_heart", label: "Heart (American)" }, { id: "bm_george", label: "George (British)" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchSpeakingVoice).mockResolvedValue(catalog);
  vi.mocked(sayVoiceTest).mockResolvedValue({ ok: true });
  vi.mocked(setSpeakingVoice).mockResolvedValue({ voice: "bm_george", fault: null });
});

function renderSection(previewAllowed = true) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    <SpeakingVoiceSection previewAllowed={previewAllowed} />
  </SWRConfig>);
}

describe("Droplet's speaking voice", () => {
  it("previews the candidate without saving, then explicitly saves the selection", async () => {
    renderSection();
    const choice = await screen.findByLabelText("Speaking voice");
    expect(choice).toHaveValue("af_heart");
    fireEvent.change(choice, { target: { value: "bm_george" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview voice" }));
    await waitFor(() => expect(sayVoiceTest).toHaveBeenCalledWith(expect.any(String), "bm_george"));
    await screen.findByText("Preview finished. Your saved speaking voice is unchanged.");
    expect(setSpeakingVoice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save speaking voice" }));
    await waitFor(() => expect(setSpeakingVoice).toHaveBeenCalledWith("bm_george"));
    await screen.findByText("Speaking voice saved. Droplet will use it for spoken replies.");
    expect(screen.getByRole("button", { name: "Save speaking voice" })).toBeDisabled();
  });

  it("shows unavailable state with no fabricated options", async () => {
    vi.mocked(fetchSpeakingVoice).mockResolvedValue({ available: false, selectable: false, voice: null, voices: [], fault: "Unavailable" });
    renderSection();
    await screen.findByText("Speaking voices are unavailable. Try again in a moment.");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview voice" })).not.toBeInTheDocument();
  });

  it("can save while voice is off but disables the preview", async () => {
    renderSection(false);
    const choice = await screen.findByLabelText("Speaking voice");
    fireEvent.change(choice, { target: { value: "bm_george" } });
    expect(screen.getByRole("button", { name: "Preview voice" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save speaking voice" })).toBeEnabled();
  });

  it("shows failed persistence without announcing success or changing the saved voice", async () => {
    vi.mocked(setSpeakingVoice).mockRejectedValue(new Error("Disk is full"));
    renderSection();
    fireEvent.change(await screen.findByLabelText("Speaking voice"), { target: { value: "bm_george" } });
    fireEvent.click(screen.getByRole("button", { name: "Save speaking voice" }));
    await screen.findByText("Disk is full");
    expect(screen.queryByText(/Speaking voice saved/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save speaking voice" })).toBeEnabled();
  });
});
