/**
 * WARP-1121 — component states for the interview chrome + review card
 * (design brief §3/§5/§7): intro card copy/actions/warming gate, dot
 * advancement off parsed markers (hold-never-guess is exercised via the
 * topic prop contract), review card apply/error/saved/unchecked-all states.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  InterviewIntroCard,
  InterviewProgress,
  InterviewResumeBanner,
} from "./InterviewSurfaces";
import { ReviewCard } from "./ReviewCard";
import { INTERVIEW_COPY, type Proposal } from "@/lib/interview";

afterEach(() => cleanup());

describe("InterviewIntroCard (§3)", () => {
  it("ships the §9 copy verbatim and fires the actions", () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    render(<InterviewIntroCard onStart={onStart} onSkip={onSkip} modelReady />);
    expect(screen.getByText(INTERVIEW_COPY.introSpokenLine)).toBeTruthy();
    expect(screen.getByText(INTERVIEW_COPY.introMeta)).toBeTruthy();
    expect(screen.getByText(INTERVIEW_COPY.introSubHint)).toBeTruthy();
    fireEvent.click(screen.getByText(INTERVIEW_COPY.introStart));
    expect(onStart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(INTERVIEW_COPY.introSkip));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("disables Start with the warming footnote when the model is not ready (§7.11)", () => {
    render(
      <InterviewIntroCard onStart={vi.fn()} onSkip={vi.fn()} modelReady={false} />,
    );
    expect(
      (screen.getByText(INTERVIEW_COPY.introStart) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(INTERVIEW_COPY.warmingFootnote)).toBeTruthy();
  });
});

describe("InterviewProgress (§4)", () => {
  it("fills dots up to the parsed topic and announces politely", () => {
    render(
      <InterviewProgress topic={3} onSkipTheRest={vi.fn()} onPause={vi.fn()} />,
    );
    for (let i = 1; i <= 7; i++) {
      expect(
        screen.getByTestId(`topic-dot-${i}`).getAttribute("data-done"),
      ).toBe(String(i <= 3));
    }
    expect(screen.getByText("Topic 3 of 7")).toBeTruthy();
  });

  it("holds at zero before any marker parses (never guesses)", () => {
    render(
      <InterviewProgress topic={null} onSkipTheRest={vi.fn()} onPause={vi.fn()} />,
    );
    for (let i = 1; i <= 7; i++) {
      expect(
        screen.getByTestId(`topic-dot-${i}`).getAttribute("data-done"),
      ).toBe("false");
    }
  });

  it("Skip the rest wires through", () => {
    const onSkip = vi.fn();
    render(<InterviewProgress topic={2} onSkipTheRest={onSkip} onPause={vi.fn()} />);
    fireEvent.click(screen.getByTestId("skip-the-rest"));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe("InterviewResumeBanner (§4)", () => {
  it("carries the copy and both actions", () => {
    const onResume = vi.fn();
    const onSkip = vi.fn();
    render(<InterviewResumeBanner onResume={onResume} onSkipTheRest={onSkip} />);
    expect(screen.getByText(INTERVIEW_COPY.resumeBanner)).toBeTruthy();
    fireEvent.click(screen.getByText(INTERVIEW_COPY.resume));
    fireEvent.click(screen.getByText(INTERVIEW_COPY.skipTheRest));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

const PROPOSAL: Proposal = {
  profile: { whatWeDo: "Dental practice", customers: "Families" },
  summary: "A dental practice in Boise.",
  facts: [
    { category: "Business", fact: "Open Tue-Sat", audience: "family" },
    { category: "Tone", fact: "Short replies", audience: "admin" },
  ],
};

describe("ReviewCard (§5/§7)", () => {
  it("applies the checked payload and collapses to the saved state", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <ReviewCard
        proposal={PROPOSAL}
        onApply={onApply}
        onNotYet={vi.fn()}
        onViewSaved={vi.fn()}
      />,
    );
    // Uncheck the second fact — unchecked facts are simply not saved.
    fireEvent.click(screen.getByLabelText("Short replies"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-apply"));
    });
    expect(onApply).toHaveBeenCalledWith({
      profile: { whatWeDo: "Dental practice", customers: "Families" },
      summary: "A dental practice in Boise.",
      facts: [{ category: "Business", fact: "Open Tue-Sat", audience: "family" }],
    });
    expect(screen.getByTestId("review-card-saved")).toBeTruthy();
    expect(screen.getByText(INTERVIEW_COPY.savedLine)).toBeTruthy();
  });

  it("keeps edits and shows the §7.9 error line on a failed apply", async () => {
    const onApply = vi.fn().mockRejectedValue(new Error("500"));
    render(
      <ReviewCard
        proposal={PROPOSAL}
        onApply={onApply}
        onNotYet={vi.fn()}
        onViewSaved={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-apply"));
    });
    expect(screen.getByTestId("review-apply-error").textContent).toBe(
      INTERVIEW_COPY.applyError,
    );
    // Edits survive: the fact text is still in the inputs, and the button
    // now reads Try again.
    expect(screen.getByDisplayValue("Open Tue-Sat")).toBeTruthy();
    expect(screen.getByTestId("review-apply").textContent).toBe(
      INTERVIEW_COPY.tryAgain,
    );
  });

  it("disables Apply with the footnote when nothing is selected (§7.8)", async () => {
    render(
      <ReviewCard
        proposal={{ profile: {}, summary: "", facts: PROPOSAL.facts }}
        onApply={vi.fn()}
        onNotYet={vi.fn()}
        onViewSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Open Tue-Sat"));
    fireEvent.click(screen.getByLabelText("Short replies"));
    expect(
      (screen.getByTestId("review-apply") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(INTERVIEW_COPY.nothingToSave)).toBeTruthy();
  });
});
