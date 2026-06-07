/**
 * PR #384 — StepShell aurora left-rail frame.
 *
 * The re-skin replaces the centered card + ProgressDots with a persistent
 * aurora left-rail (lg+) whose step list is DERIVED from the wizard's live
 * `STEPS` source (`components/setup/wizard-steps`), so the rail and the state machine
 * can never drift. Below `lg` a compact progress header stands in for the
 * rail.
 *
 * These tests pin the contract that matters for the re-skin:
 *   1. The rail renders one labelled row per wizard step — including the
 *      live-but-newer claim / org / twofactor steps — using plain-language
 *      labels (not raw step ids).
 *   2. The rail order matches the page's `STEPS` order exactly (derived, not
 *      hardcoded), so a future STEPS edit reflows the rail automatically.
 *   3. `current` is accepted for every one of the 12 step ids and drives the
 *      compact-header "Step N of total" counter.
 *
 * Source-level (regex) checks are avoided here — they break on Windows under
 * `new URL(import.meta.url).pathname` (see the pre-existing a11y suites). This
 * is a behavioural render test instead.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { StepShell, RAIL_LABELS } from "./StepShell";
import { STEPS, type Step } from "@/components/setup/wizard-steps";

describe("StepShell aurora rail (PR #384)", () => {
  it("renders a rail row for every wizard step in the page's STEPS source", () => {
    render(
      <StepShell current="welcome" title="Welcome">
        body
      </StepShell>,
    );
    const rail = screen.getByRole("navigation", { name: /setup progress/i });
    // Every step id has a plain-language label and it appears in the rail.
    for (const id of STEPS) {
      expect(within(rail).getByText(RAIL_LABELS[id].label)).toBeInTheDocument();
    }
    // The rail row count equals the number of wizard steps — derived, no drift.
    const rows = within(rail).getAllByTestId("rail-row");
    expect(rows).toHaveLength(STEPS.length);
  });

  it("gives plain-language labels + a rail row to the newer claim / org / twofactor steps", () => {
    render(
      <StepShell current="claim" title="We found your Droplet">
        body
      </StepShell>,
    );
    const rail = screen.getByRole("navigation", { name: /setup progress/i });
    expect(within(rail).getByText("Claim")).toBeInTheDocument();
    expect(within(rail).getByText("Workspace")).toBeInTheDocument();
    expect(within(rail).getByText("2-step")).toBeInTheDocument();
  });

  it("renders the rail rows in the same order as the page's STEPS array", () => {
    render(
      <StepShell current="welcome" title="Welcome">
        body
      </StepShell>,
    );
    const rail = screen.getByRole("navigation", { name: /setup progress/i });
    const railText = within(rail)
      .getAllByTestId("rail-row")
      .map((row) => row.textContent);
    const expected = STEPS.map((id) => RAIL_LABELS[id].label);
    // Each rail row's label, in DOM order, matches STEPS order.
    expected.forEach((label, i) => {
      expect(railText[i]).toContain(label);
    });
  });

  it("accepts every one of the 12 step ids for `current` and shows the step counter", () => {
    for (let i = 0; i < STEPS.length; i++) {
      const current: Step = STEPS[i];
      const { unmount } = render(
        <StepShell current={current} title={`Step ${current}`}>
          body
        </StepShell>,
      );
      // Compact header counter — "Step N of TOTAL".
      expect(
        screen.getByText(
          new RegExp(`step\\s+${i + 1}\\s+of\\s+${STEPS.length}`, "i"),
        ),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("renders the primary action with its label and the skip control when given", () => {
    let primaryClicks = 0;
    let skipClicks = 0;
    render(
      <StepShell
        current="internet"
        title="Connect to the internet"
        primary={{ label: "Save and continue", onClick: () => primaryClicks++ }}
        skip={{ label: "Skip for now", onClick: () => skipClicks++ }}
      >
        body
      </StepShell>,
    );
    expect(
      screen.getByRole("button", { name: /save and continue/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skip for now/i }),
    ).toBeInTheDocument();
    expect(primaryClicks).toBe(0);
    expect(skipClicks).toBe(0);
  });
});

/**
 * Viewport-locked wizard shell (WARP-820 + desktop-scroll fix).
 *
 * The shell root is `h-dvh overflow-hidden` (WARP-666) so the DOCUMENT never
 * scrolls. The rail is sized to fit and never scrolls. The content panel is
 * scroll-WHEN-NEEDED: steps are sized to fit, so a normal viewport shows no
 * scrollbar; only a viewport too short for a step scrolls the panel — instead of
 * clipping the step's lower content (the failure WARP-820 had band-aided with a
 * 44dvh-capped ScrollRegion on the form steps). The title and CTA are always
 * mounted (the CTA pins in the footer, outside the panel). jsdom can't measure
 * layout, so these are STRUCTURE assertions — the visual "fits on every device"
 * proof is the UI/UX + on-box pass.
 */
describe("StepShell viewport-lock (WARP-820)", () => {
  it("scopes the fluid type layer with the .setup-shell class on the shell root", () => {
    const { container } = render(
      <StepShell current="storage" title="Storage">
        body
      </StepShell>,
    );
    // The wizard-scoped fluid type overrides hang off this hook; the rest of
    // the dashboard's type stays byte-for-byte fixed.
    expect(container.querySelector(".setup-shell")).not.toBeNull();
  });

  it("does not let the rail scroll (overflow-hidden, not overflow-y-auto)", () => {
    render(
      <StepShell current="storage" title="Storage">
        body
      </StepShell>,
    );
    const rail = screen.getByTestId("setup-rail");
    expect(rail.className).toContain("overflow-hidden");
    expect(rail.className).not.toContain("overflow-y-auto");
  });

  it("makes the content panel scroll only when a step overflows (never the document)", () => {
    render(
      <StepShell current="storage" title="Storage">
        body
      </StepShell>,
    );
    // The panel absorbs its own overflow (a too-short viewport scrolls the panel
    // rather than clipping); on a normal viewport the content fits, so no
    // scrollbar shows. overscroll-contain keeps a flick from chaining out.
    const main = screen.getByTestId("setup-main");
    expect(main.className).toContain("overflow-y-auto");
    expect(main.className).toContain("overscroll-contain");

    // …while the DOCUMENT itself stays locked by the shell root.
    const shell = main.closest(".setup-shell");
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain("overflow-hidden");
    expect(shell?.className).toContain("h-dvh");
  });

  it("always mounts the step title regardless of the body content", () => {
    // Even with a tall body, the title pins and stays in the document.
    render(
      <StepShell current="storage" title="Choose your storage">
        <div style={{ height: 5000 }}>very tall body</div>
      </StepShell>,
    );
    expect(
      screen.getByRole("heading", { name: /choose your storage/i }),
    ).toBeInTheDocument();
  });

  it("always mounts the CTA when given, regardless of the body content", () => {
    render(
      <StepShell
        current="storage"
        title="Choose your storage"
        primary={{ label: "Continue", onClick: () => {} }}
      >
        <div style={{ height: 5000 }}>very tall body</div>
      </StepShell>,
    );
    expect(
      screen.getByRole("button", { name: /continue/i }),
    ).toBeInTheDocument();
  });
});
