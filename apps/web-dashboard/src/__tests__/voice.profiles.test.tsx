/**
 * WARP-1056 — §3.3 "Who Droplet recognizes": profile rows contract.
 *
 * VoiceProfilesSection under test. Pins:
 *   1. row anatomy: name · human-sentence meta ("Enrolled May 12 ·
 *      last recognized today"), the §5 "Learning" flag, the
 *      "On this box only" mini-chip;
 *   2. §7.6 — BOTH rows of a confusable pair surface the orange
 *      "Sometimes confused with [Name]" note verbatim;
 *   3. remove = destructive Write behind the §10 red confirm with the
 *      exact copy; confirming calls the immediate delete + revalidates;
 *   4. re-record hands the person to Flow B;
 *   5. "Add a voice" disables when the box can't enroll (§7.2).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  removeVoiceProfile: vi.fn(async () => {}),
}));

import { VoiceProfilesSection, lastRecognizedLabel } from "@/components/voice/VoiceProfilesSection";
import { removeVoiceProfile } from "@/lib/api";
import { ToastProvider } from "@/components/Toast";
import type { VoiceProfileInfo } from "@/lib/types";

const removeMock = vi.mocked(removeVoiceProfile);

const NOW = 1_751_000_000;

function profile(overrides: Partial<VoiceProfileInfo> = {}): VoiceProfileInfo {
  return {
    user_id: "u-nadia",
    display_name: "Nadia",
    enrolled_at: NOW - 30 * 24 * 3600,
    updated_at: NOW - 30 * 24 * 3600,
    last_recognized_at: NOW - 60,
    learning: false,
    confused_with: null,
    confused_with_name: null,
    lines: 4,
    voice_model: "campplus-voxceleb-en",
    ...overrides,
  };
}

function renderSection(
  props: Partial<React.ComponentProps<typeof VoiceProfilesSection>> = {},
) {
  const defaults: React.ComponentProps<typeof VoiceProfilesSection> = {
    profiles: [profile()],
    enrollmentAllowed: true,
    nowS: NOW,
    onAddVoice: vi.fn(),
    onReRecord: vi.fn(),
    onProfilesChanged: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  render(
    <ToastProvider>
      <VoiceProfilesSection {...merged} />
    </ToastProvider>,
  );
  return merged;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("profile rows (§3.3)", () => {
  it("renders name, human-sentence meta and the on-box chip", () => {
    renderSection();
    expect(screen.getByText("Nadia")).toBeInTheDocument();
    // Human sentences, not mono: "Enrolled <Month day> · last recognized today".
    expect(
      screen.getByText(/Enrolled .+ · last recognized today/),
    ).toBeInTheDocument();
    expect(screen.getByText("On this box only")).toBeInTheDocument();
    // Guest line + privacy caption stay (§9 verbatim).
    expect(
      screen.getByText(
        "Unrecognized voices are treated as guests — read-only answers, no personal data.",
      ),
    ).toBeInTheDocument();
  });

  it("flags a Learning profile in the meta (§5 honest fallback)", () => {
    renderSection({
      profiles: [profile({ learning: true, last_recognized_at: null })],
    });
    expect(screen.getByText(/· Learning$/)).toBeInTheDocument();
  });

  it("surfaces the §7.6 confusable note verbatim on both rows", () => {
    renderSection({
      profiles: [
        profile({
          confused_with: "u-sam",
          confused_with_name: "Sam",
        }),
        profile({
          user_id: "u-sam",
          display_name: "Sam",
          confused_with: "u-nadia",
          confused_with_name: "Nadia",
        }),
      ],
    });
    expect(
      screen.getByText(
        /Sometimes confused with Sam — re-recording either voice helps/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Sometimes confused with Nadia — re-recording either voice helps/,
      ),
    ).toBeInTheDocument();
  });

  it("renders the §9 empty state when nothing is enrolled", () => {
    renderSection({ profiles: [] });
    expect(
      screen.getByText(
        "No voices enrolled. Droplet answers everyone as a guest until it knows who's who.",
      ),
    ).toBeInTheDocument();
  });
});

describe("row actions", () => {
  it("Remove voice: red confirm with the §10 copy, then immediate delete", async () => {
    const { onProfilesChanged } = renderSection();
    fireEvent.click(
      screen.getByRole("button", { name: "Voice options for Nadia" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove voice/ }));

    // §10 verbatim confirm copy.
    expect(screen.getByText("Remove Nadia's voice?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This deletes their voiceprint from this box immediately.",
      ),
    ).toBeInTheDocument();
    // Nothing deleted until the confirm.
    expect(removeMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove voice" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("u-nadia"));
    await waitFor(() => expect(onProfilesChanged).toHaveBeenCalled());
  });

  it("Re-record hands the person to Flow B", () => {
    const { onReRecord } = renderSection();
    fireEvent.click(
      screen.getByRole("button", { name: "Voice options for Nadia" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Re-record voice/ }));
    expect(onReRecord).toHaveBeenCalledWith("u-nadia");
  });

  it("Add a voice fires when allowed, disables when the box can't enroll (§7.2)", () => {
    const { onAddVoice } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Add a voice" }));
    expect(onAddVoice).toHaveBeenCalled();
  });

  it("Add a voice + Re-record disable when enrollment can't run here", () => {
    renderSection({ enrollmentAllowed: false });
    expect(screen.getByRole("button", { name: "Add a voice" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Voice options for Nadia" }),
    );
    expect(
      screen.getByRole("menuitem", { name: /Re-record voice/ }),
    ).toBeDisabled();
    // Remove stays available — deleting data must never require a
    // working microphone.
    expect(
      screen.getByRole("menuitem", { name: /Remove voice/ }),
    ).toBeEnabled();
  });
});

describe("lastRecognizedLabel", () => {
  it("says today / yesterday / N days ago", () => {
    expect(lastRecognizedLabel(NOW - 60, NOW)).toBe("today");
    expect(lastRecognizedLabel(NOW - 26 * 3600, NOW)).toMatch(
      /yesterday|2 days ago/,
    );
    expect(lastRecognizedLabel(NOW - 5 * 86400, NOW)).toMatch(/days ago$/);
  });
});
