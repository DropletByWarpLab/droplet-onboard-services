/**
 * WARP-2838 — the `/brief` on switch.
 *
 * The defect was not a wrong pixel: the page told every owner to "turn the
 * brain on to start reading your business" and nothing in the product could.
 * So these cases are about AFFORDANCE — is there something to press, does it
 * call the box, and does the screen tell the truth when the answer is no.
 *
 * The consent copy is asserted, not just the button. ADR-051 §9.9 puts this
 * behind an informed decision, and the one line that must never soften is the
 * model one: the corpus pass calls `DEFAULT_MODEL ?? LLM_MODEL` through the AI
 * gateway, which routes cloud model names to cloud providers. A screen that
 * said "stays on the box" would be the most consequential false claim in the
 * product.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { setBrainEnabledMock } = vi.hoisted(() => ({
  setBrainEnabledMock:
    vi.fn<(enabled: boolean) => Promise<{ ok: boolean; error?: string }>>(async () => ({
      ok: true,
    })),
}));
vi.mock("@/app/brief/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/brief/api")>()),
  setBrainEnabled: setBrainEnabledMock,
}));

import { BrainSwitchPanel } from "@/app/brief/BrainSwitchPanel";
import { COVERAGE_UNREACHABLE, type Coverage, type CoverageResult } from "@/app/brief/api";

/** A box that ANSWERED. WARP-2838 review: the panel takes a `CoverageResult`
 *  so "did not answer" cannot be spelled the same way as "answered off". */
function answered(over: Partial<Coverage> = {}): CoverageResult {
  return {
    reached: true,
    coverage: {
      passes: [],
      corpus: { documentsReady: 4000, documentsDigested: 0 },
      ...over,
    },
  };
}

beforeEach(() => {
  setBrainEnabledMock.mockClear();
  setBrainEnabledMock.mockResolvedValue({ ok: true });
});

describe("BrainSwitchPanel — off (WARP-2838)", () => {
  it("offers a control, not a sentence describing one", async () => {
    render(
      <BrainSwitchPanel result={answered({ enabled: false, canToggle: true })} onChanged={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /turn the brain on/i })).toBeInTheDocument();
  });

  it("states what the owner is agreeing to before they agree to it", async () => {
    render(
      <BrainSwitchPanel result={answered({ enabled: false, canToggle: true })} onChanged={vi.fn()} />,
    );
    // 🔴 The cloud line. If a refactor ever turns this into "stays on this
    // box", this assertion is what should stop it.
    expect(screen.getByText(/sent to that provider/i)).toBeInTheDocument();
    // Slow on purpose — an owner who expects an overnight read stops trusting
    // the feature by morning.
    expect(screen.getByText(/slow on purpose/i)).toBeInTheDocument();
    // Turning it off stops the passes; it does not delete what was written.
    expect(screen.getByText(/stays until you delete it/i)).toBeInTheDocument();
  });

  it("calls the box and refreshes the page's state", async () => {
    const onChanged = vi.fn();
    render(
      <BrainSwitchPanel result={answered({ enabled: false, canToggle: true })} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /turn the brain on/i }));
    await waitFor(() => expect(setBrainEnabledMock).toHaveBeenCalledWith(true));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("explains a pinned box instead of rendering a control that 409s", async () => {
    render(
      <BrainSwitchPanel result={answered({ enabled: false, canToggle: false })} onChanged={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/pinned off by its operator/i)).toBeInTheDocument();
    // Names the variable, so whoever administers the box knows what to change.
    expect(screen.getByText("BRAIN_ENABLED")).toBeInTheDocument();
  });

  it("renders no control against an orchestrator too old to have the route", async () => {
    // `canToggle` absent means the field is not on the wire. A button here
    // would 404 and read as a broken switch rather than an old box.
    render(<BrainSwitchPanel result={answered({ enabled: false })} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not call an old orchestrator a pin — that is an update, not a policy", async () => {
    // Same three-valued point as the unreachable case below: `canToggle`
    // undefined means the field is not on the wire, and naming BRAIN_ENABLED
    // here sends somebody to change a variable that is not the reason.
    render(<BrainSwitchPanel result={answered({ enabled: false })} onChanged={vi.fn()} />);
    expect(screen.queryByText(/pinned off by its operator/i)).not.toBeInTheDocument();
    expect(screen.queryByText("BRAIN_ENABLED")).not.toBeInTheDocument();
    expect(screen.getByText(/does not offer the switch yet/i)).toBeInTheDocument();
  });

  it("surfaces a refused write rather than painting the switch optimistically", async () => {
    setBrainEnabledMock.mockResolvedValue({ ok: false, error: "brain_switch_pinned" });
    const onChanged = vi.fn();
    render(
      <BrainSwitchPanel result={answered({ enabled: false, canToggle: true })} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /turn the brain on/i }));
    expect(await screen.findByText(/pinned by its operator and cannot be changed here/i)).toBeInTheDocument();
    // The page is NOT reloaded on a refusal: nothing changed, and a refetch
    // would repaint the same state as if something had.
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("BrainSwitchPanel — on (WARP-2838)", () => {
  it("offers the way back out, since the AC is on AND off", async () => {
    const onChanged = vi.fn();
    render(
      <BrainSwitchPanel result={answered({ enabled: true, canToggle: true })} onChanged={onChanged} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /turn the brain off/i }));
    await waitFor(() => expect(setBrainEnabledMock).toHaveBeenCalledWith(false));
  });

  it("does not repeat the consent copy once the decision is made", async () => {
    render(
      <BrainSwitchPanel result={answered({ enabled: true, canToggle: true })} onChanged={vi.fn()} />,
    );
    expect(screen.queryByText(/sent to that provider/i)).not.toBeInTheDocument();
  });

  it("says who switched it on when the box is pinned on", async () => {
    render(
      <BrainSwitchPanel result={answered({ enabled: true, canToggle: false })} onChanged={vi.fn()} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/operator, in its configuration/i)).toBeInTheDocument();
  });
});

/**
 * WARP-2838 review — the third state.
 *
 * `fetchCoverage` collapsed every non-ok response to `null`, and `null` was
 * indistinguishable from "off and not togglable" — the one pair this panel
 * renders as a named env var and an instruction to go and find a sysadmin. A
 * transient 500 was enough. These cases exist so the panel can never again
 * state a cause the box did not give it.
 */
describe("BrainSwitchPanel — the box did not answer (WARP-2838 review)", () => {
  it("does not diagnose a pin it was never told about", async () => {
    render(<BrainSwitchPanel result={COVERAGE_UNREACHABLE} onChanged={vi.fn()} />);
    expect(screen.queryByText(/pinned off by its operator/i)).not.toBeInTheDocument();
    expect(screen.queryByText("BRAIN_ENABLED")).not.toBeInTheDocument();
  });

  it("does not offer the consent screen to an owner whose brain may be running", async () => {
    render(<BrainSwitchPanel result={COVERAGE_UNREACHABLE} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /turn the brain on/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/sent to that provider/i)).not.toBeInTheDocument();
  });

  it("says what it actually knows, and offers the retry", async () => {
    const onChanged = vi.fn();
    render(<BrainSwitchPanel result={COVERAGE_UNREACHABLE} onChanged={onChanged} />);
    expect(screen.getByText(/could not check whether the brain is on/i)).toBeInTheDocument();
    // "Nothing has changed either way" — the reassurance that matters when this
    // renders right after a toggle whose refetch failed.
    expect(screen.getByText(/nothing has changed either way/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("does not write to the box on a retry — it re-reads", async () => {
    render(<BrainSwitchPanel result={COVERAGE_UNREACHABLE} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(setBrainEnabledMock).not.toHaveBeenCalled();
  });
});
