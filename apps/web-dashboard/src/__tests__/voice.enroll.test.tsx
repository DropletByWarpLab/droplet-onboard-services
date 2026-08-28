/**
 * WARP-1056 — Flow B enrollment wizard contract (§5 / §7.5).
 *
 * EnrollmentWizard under test with the api + auth layers mocked. Pins:
 *   1. step 1: picker lists local-directory people minus
 *      already-enrolled, preselects the signed-in user, and shows the
 *      §9 privacy panel VERBATIM; Continue opens the on-box session;
 *   2. step 2: the four §5 scripted lines capture with auto-advance;
 *      the too-quiet guard re-prompts ONCE ("That one was hard to
 *      hear — once more.") then waits; the §7.5 crosstalk guard shows
 *      its copy verbatim and never auto-retries; Redo re-captures a
 *      line via replaceIndex;
 *   3. step 3: success says "Got it — Droplet recognized [Name]." with
 *      a PLAIN WORD confidence (never a percentage); first mismatch
 *      appends the two sharpen lines; the second falls back honestly;
 *   4. confirm: "Save [Name]'s voice" is the only write; cancel fires
 *      the immediate discard ("Cancel deletes these recordings now.").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  fetchUsers: vi.fn(),
  startVoiceEnrollment: vi.fn(),
  captureVoiceEnrollmentLine: vi.fn(),
  verifyVoiceEnrollment: vi.fn(),
  commitVoiceEnrollment: vi.fn(),
  cancelVoiceEnrollment: vi.fn(async () => {}),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u-nadia", username: "nadia", displayName: "Nadia" },
  }),
}));

import { EnrollmentWizard } from "@/components/voice/EnrollmentWizard";
import {
  cancelVoiceEnrollment,
  captureVoiceEnrollmentLine,
  commitVoiceEnrollment,
  fetchUsers,
  startVoiceEnrollment,
  verifyVoiceEnrollment,
} from "@/lib/api";
import type { VoiceProfileInfo } from "@/lib/types";

const fetchUsersMock = vi.mocked(fetchUsers);
const startMock = vi.mocked(startVoiceEnrollment);
const captureMock = vi.mocked(captureVoiceEnrollmentLine);
const verifyMock = vi.mocked(verifyVoiceEnrollment);
const commitMock = vi.mocked(commitVoiceEnrollment);
const cancelMock = vi.mocked(cancelVoiceEnrollment);

const SESSION = "a".repeat(32);

const ROSTER = {
  users: [
    { id: "nadia", username: "nadia", displayName: "Nadia", userId: "u-nadia" },
    { id: "sam", username: "sam", displayName: "Sam", userId: "u-sam" },
    // Not mirrored locally — a voiceprint has nothing to attach to.
    { id: "legacy", username: "legacy", displayName: "Legacy", userId: null },
  ],
};

const SAM_PROFILE: VoiceProfileInfo = {
  user_id: "u-sam",
  display_name: "Sam",
  enrolled_at: 1,
  updated_at: 1,
  last_recognized_at: null,
  learning: false,
  lines: 4,
  voice_model: "campplus-voxceleb-en",
};

function good(captured: number) {
  return { quality: "good" as const, captured, required: 4 };
}

function renderWizard(
  props: Partial<React.ComponentProps<typeof EnrollmentWizard>> = {},
) {
  const onClose = vi.fn();
  render(
    <EnrollmentWizard
      open
      profiles={[SAM_PROFILE]}
      presetUserId={null}
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchUsersMock.mockResolvedValue(ROSTER);
  startMock.mockResolvedValue({ session_id: SESSION, lines_required: 4 });
  // Base behavior once a test's mockResolvedValueOnce queue drains: the
  // capture stays "in flight" (the wizard records continuously) instead
  // of resolving undefined.
  captureMock.mockImplementation(
    () =>
      new Promise(() => {}) as ReturnType<typeof captureVoiceEnrollmentLine>,
  );
  verifyMock.mockImplementation(
    () => new Promise(() => {}) as ReturnType<typeof verifyVoiceEnrollment>,
  );
});

async function continueFromWho() {
  // Preselection lands after the roster fetch resolves.
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "Nadia" })).toHaveAttribute(
      "aria-checked",
      "true",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(startMock).toHaveBeenCalledWith("u-nadia"));
}

describe("step 1 · who is this (§5)", () => {
  it("lists people minus already-enrolled, preselects yourself, shows the privacy panel", async () => {
    renderWizard();
    expect(screen.getByText("Whose voice is this?")).toBeInTheDocument();
    // §9 privacy panel — verbatim, always visible.
    expect(
      screen.getByText(
        "Your voiceprint is a mathematical summary of how you sound — not a recording. It's created and stored on this box, never uploaded, and deleted the moment you remove it.",
      ),
    ).toBeInTheDocument();
    // Yourself preselected (§5: when the logged-in user has no voiceprint).
    // Wait on the preselection itself, not merely on the row existing: the
    // radio mounts as soon as the people list resolves, and the preselect
    // effect commits after that. Asserting aria-checked in the gap between
    // the two is a race that only loses under CI load (WARP-1421).
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Nadia" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    // Sam is enrolled, Legacy has no local row — neither is pickable.
    expect(screen.queryByRole("radio", { name: /Sam/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Legacy/ })).toBeNull();
    // The chip is the §10 write tier.
    expect(screen.getByText("Write · confirm to apply")).toBeInTheDocument();
  });

  it("re-record keeps the enrolled person pickable and preselected", async () => {
    renderWizard({ presetUserId: "u-sam" });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Sam/ })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(screen.getByText("re-record")).toBeInTheDocument();
  });
});

describe("step 2 · read the lines (§5/§7.5)", () => {
  it("captures the four scripted lines with auto-advance, then verifies", async () => {
    captureMock
      .mockResolvedValueOnce(good(1))
      .mockResolvedValueOnce(good(2))
      .mockResolvedValueOnce(good(3))
      .mockResolvedValueOnce(good(4));
    verifyMock.mockResolvedValue({
      quality: "good",
      matched: true,
      confidence: "high",
    });
    renderWizard();
    await continueFromWho();

    // The mocked captures resolve in microtasks, so the lines step may
    // already be behind us — the guard tests below pin its rendering.
    await waitFor(() => expect(captureMock).toHaveBeenCalledTimes(4));
    // Session-scoped captures, no replaceIndex on the happy path.
    expect(captureMock).toHaveBeenCalledWith(SESSION, undefined);
    // Auto-advance ends in the no-script verify (§5 step 3).
    await waitFor(() => expect(verifyMock).toHaveBeenCalledWith(SESSION));
    // The copy renders in the heading AND the aria-live announcement.
    expect(
      (await screen.findAllByText(/Got it — Droplet recognized Nadia\./))
        .length,
    ).toBeGreaterThan(0);
    // Plain word — never a percentage.
    expect(screen.getByText("Confidence: High")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("re-prompts once on a quiet take, then waits for an explicit retry", async () => {
    captureMock
      .mockResolvedValueOnce({ quality: "too_quiet", captured: 0, required: 4 })
      .mockResolvedValueOnce({ quality: "too_quiet", captured: 0, required: 4 });
    renderWizard();
    await continueFromWho();

    // Auto re-prompt consumed the second call; after the second quiet
    // take the wizard stops and shows the §5 copy + a manual retry.
    await waitFor(() => expect(captureMock).toHaveBeenCalledTimes(2));
    expect(
      (await screen.findAllByText("That one was hard to hear — once more."))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it("shows the §7.5 crosstalk copy verbatim and never auto-retries", async () => {
    captureMock.mockResolvedValueOnce({
      quality: "crosstalk",
      captured: 0,
      required: 4,
    });
    renderWizard();
    await continueFromWho();

    expect(
      (
        await screen.findAllByText(
          "It sounds like more than one person is talking. Enrollment works best solo — find a quiet moment and try again.",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it("Redo re-captures a specific line via replaceIndex", async () => {
    captureMock
      .mockResolvedValueOnce(good(1))
      .mockResolvedValueOnce({ quality: "crosstalk", captured: 1, required: 4 })
      .mockResolvedValueOnce(good(1));
    renderWizard();
    await continueFromWho();

    // Line 2 failed (crosstalk) — the captured line 1 offers Redo. The Redo
    // button is rendered as soon as line 1 lands but stays DISABLED while
    // line 2 is still recording (the box records one thing at a time), and
    // findByRole matches disabled buttons too. Wait for it to become enabled
    // — i.e. for the crosstalk result to land — before clicking; React 19
    // commits the "line 1 captured" render far enough ahead of the crosstalk
    // result that grabbing the first match clicked a disabled button.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Redo line 1" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Redo line 1" }));
    await waitFor(() =>
      expect(captureMock).toHaveBeenCalledWith(SESSION, 0),
    );
  });
});

describe("step 3 · prove it works (§5)", () => {
  async function reachVerifyMismatch(times: 1 | 2) {
    captureMock.mockImplementation(async (_sid, replaceIndex) => {
      // Count only appends — the server counts unique lines.
      const appended = captureMock.mock.calls.filter(
        (c) => c[1] === undefined,
      ).length;
      return good(replaceIndex === undefined ? appended : appended);
    });
    verifyMock.mockResolvedValue({ quality: "good", matched: false });
    renderWizard();
    await continueFromWho();
    await waitFor(() => expect(verifyMock).toHaveBeenCalledTimes(1));
    expect(
      (
        await screen.findAllByText(
          "Droplet heard you but wasn't sure it was you. Two more lines will sharpen it.",
        )
      ).length,
    ).toBeGreaterThan(0);
    if (times === 1) return;
    fireEvent.click(
      screen.getByRole("button", { name: "Read two more lines" }),
    );
    // Two sharpen lines capture, then the re-test also misses.
    await waitFor(() => expect(verifyMock).toHaveBeenCalledTimes(2));
  }

  it("first mismatch appends the two sharpen lines and re-tests", async () => {
    await reachVerifyMismatch(2);
    // 4 scripted + 2 sharpen lines captured in total.
    const appends = captureMock.mock.calls.filter((c) => c[1] === undefined);
    expect(appends).toHaveLength(6);
    // Second failure → honest fallback, verbatim.
    expect(
      (
        await screen.findAllByText(
          "Recognition isn't reliable in this room yet. Your voice is saved and will improve as you use it, or you can re-record later from the Voice page.",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("the fallback still saves — flagged as Learning on the confirm step", async () => {
    await reachVerifyMismatch(2);
    commitMock.mockResolvedValue({
      saved: true,
      profile: { ...SAM_PROFILE, user_id: "u-nadia", learning: true },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText(/Saved as “Learning”/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Save Nadia's voice" }),
    );
    await waitFor(() => expect(commitMock).toHaveBeenCalledWith(SESSION));
  });
});

describe("confirm + cancel safety (§5)", () => {
  async function reachConfirm() {
    captureMock
      .mockResolvedValueOnce(good(1))
      .mockResolvedValueOnce(good(2))
      .mockResolvedValueOnce(good(3))
      .mockResolvedValueOnce(good(4));
    verifyMock.mockResolvedValue({
      quality: "good",
      matched: true,
      confidence: "good",
    });
    const handles = renderWizard();
    await continueFromWho();
    await waitFor(() => expect(verifyMock).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    return handles;
  }

  it("Save [Name]'s voice commits the ONE write and closes saved", async () => {
    commitMock.mockResolvedValue({
      saved: true,
      profile: { ...SAM_PROFILE, user_id: "u-nadia" },
    });
    const { onClose } = await reachConfirm();
    expect(
      screen.getByText("Cancel deletes these recordings now."),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Save Nadia's voice" }),
    );
    await waitFor(() => expect(commitMock).toHaveBeenCalledWith(SESSION));
    await waitFor(() =>
      expect(onClose).toHaveBeenCalledWith({ saved: true, name: "Nadia" }),
    );
    // A successful save never fires the discard.
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("closing mid-flow discards the on-box session immediately", async () => {
    captureMock.mockResolvedValueOnce(good(1)).mockReturnValue(
      new Promise(() => {}) as ReturnType<typeof captureVoiceEnrollmentLine>,
    );
    const { onClose } = renderWizard();
    await continueFromWho();
    await waitFor(() => expect(captureMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith(SESSION));
    expect(onClose).toHaveBeenCalledWith({ saved: false });
    expect(commitMock).not.toHaveBeenCalled();
  });
});
