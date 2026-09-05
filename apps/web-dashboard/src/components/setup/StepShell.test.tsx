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
 * Mostly behavioural render tests. There is one source-level block at the
 * bottom, for the one contract a render cannot see — see its header.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { StepShell, RAIL_LABELS } from "./StepShell";
import { STEPS, type Step } from "@/components/setup/wizard-steps";
import { readPackageFile } from "@/__tests__/helpers/test-paths";

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

  it("accepts every wizard step id for `current` and shows the step counter", () => {
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
        current="wifi"
        title="Set up your Wi-Fi"
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

  it("wires a non-empty ariaDescribedBy onto the primary button", () => {
    render(
      <StepShell
        current="storage"
        title="Choose your storage"
        primary={{
          label: "Continue",
          onClick: () => {},
          disabled: true,
          ariaDescribedBy: "why-disabled",
        }}
      >
        body
      </StepShell>,
    );
    expect(screen.getByRole("button", { name: /continue/i })).toHaveAttribute(
      "aria-describedby",
      "why-disabled",
    );
  });

  it("omits aria-describedby for an empty/whitespace ariaDescribedBy (no invalid empty IDREF)", () => {
    render(
      <StepShell
        current="storage"
        title="Choose your storage"
        primary={{
          label: "Continue",
          onClick: () => {},
          ariaDescribedBy: "   ",
        }}
      >
        body
      </StepShell>,
    );
    expect(
      screen.getByRole("button", { name: /continue/i }),
    ).not.toHaveAttribute("aria-describedby");
  });
});

/**
 * WARP-2654 — the source-level check this file's header used to refuse.
 *
 * That header said source-level checks "break on Windows under
 * `new URL(import.meta.url).pathname`". The hazard is real for `new URL(…)
 * .pathname` — it yields `/C:/…`, which `path.resolve` doubles into `C:\C:\…`
 * — and irrelevant here, because nothing has to resolve a path that way. The
 * path below comes from `__tests__/helpers/test-paths`, anchored to the owning
 * file. A true fact about one spelling was generalised into "no source-level
 * checks", and it cost a contract.
 *
 * WHAT IT COSTS, precisely. Contract 2 in the header — "the rail order matches
 * the page's `STEPS` order exactly (DERIVED, not hardcoded), so a future STEPS
 * edit reflows the rail automatically" — is NOT what the render tests above
 * check. They render `StepShell`, which imports `STEPS`, and compare the
 * output against that same `STEPS`. A `StepShell` carrying its own hardcoded
 * copy of the same fifteen ids in the same order renders identically and
 * passes every one of them, including "renders the rail rows in the same order
 * as the page's STEPS array" — and would then silently stop reflowing the day
 * someone edits `wizard-steps.ts`. Derivation is a property of the source, and
 * only the source shows it.
 */
describe("WARP-2654 — the rail and the page derive from one STEPS array", () => {
  const SHELL_SRC = readPackageFile("src/components/setup/StepShell.tsx");
  const PAGE_SRC = readPackageFile("src/app/setup/page.tsx");
  const WIZARD_STEPS_SRC = readPackageFile("src/components/setup/wizard-steps.ts");

  const IMPORTS_STEPS =
    /import\s*\{[^}]*\bSTEPS\b[^}]*\}\s*from\s*"@\/components\/setup\/wizard-steps"/;

  /**
   * Array literals that spell out three or more step ids — i.e. somebody wrote
   * the order down a second time. Three, not two, so an incidental pair like
   * `["ai", "voice"]` in a conditional is not a false positive; a forked
   * ORDER is necessarily most of the list.
   */
  function forkedStepLists(src: string): string[] {
    const ids = new Set<string>(STEPS);
    return [...src.matchAll(/\[[^[\]]*\]/g)]
      .map((m) => m[0])
      .filter(
        (lit) =>
          [...lit.matchAll(/"([a-z]+)"/g)].filter((q) => ids.has(q[1])).length >= 3,
      );
  }

  it("the detector fires on the one place the order IS written down", () => {
    // NON-VACUITY. `toEqual([])` is satisfied for free by a regex that matches
    // nothing, so prove it finds the canonical array before trusting it to
    // find a duplicate. `wizard-steps.ts` declares `STEPS` and the `Step`
    // union; both spell the ids out, and both are meant to be there.
    expect(forkedStepLists(WIZARD_STEPS_SRC).length).toBeGreaterThan(0);
    expect(WIZARD_STEPS_SRC).toContain("export const STEPS: Step[] = [");
  });

  it("StepShell renders the rail by mapping the shared STEPS array", () => {
    // Mutation: replace `STEPS.map(` in StepShell.tsx with a local array of
    // the same fifteen ids → red here, green in every render test above.
    expect(SHELL_SRC).toMatch(IMPORTS_STEPS);
    expect(
      SHELL_SRC,
      "the rail must map the imported STEPS, not a list of its own",
    ).toContain("STEPS.map(");
    expect(forkedStepLists(SHELL_SRC)).toEqual([]);
  });

  it("the setup page drives its state machine off the same array", () => {
    // The header calls it "the page's STEPS order". That is only true while
    // the page reads the shared list — `app/setup/page.tsx` cannot EXPORT
    // `STEPS` (Next.js page-export allow-list, see wizard-steps.ts), which is
    // exactly the pressure that would otherwise push a private copy into it.
    expect(PAGE_SRC).toMatch(IMPORTS_STEPS);
    expect(forkedStepLists(PAGE_SRC)).toEqual([]);
  });

  it("every step in the shared array has a rail label, with no extras", () => {
    // The render tests prove each label appears; this proves the mapping is
    // exhaustive and has nothing left over from a removed step. `RAIL_LABELS`
    // is `Record<Step, …>`, so tsc already forces presence — this catches the
    // half tsc cannot: a key for an id no longer in `STEPS`.
    expect(Object.keys(RAIL_LABELS).sort()).toEqual([...STEPS].sort());
  });
});
