/**
 * Setup-wizard navigation — clickable rail + Back button.
 *
 * The customer asked for two things the viewport-locked wizard still lacked:
 * a Back affordance, and a side rail whose completed steps are clickable to
 * jump back to them. Both are driven by the `SetupNavProvider` context the
 * wizard page supplies; `StepShell` reads it. The behaviour is additive — with
 * no provider (a step mounted in isolation) the rail stays static and no Back
 * button shows, which is what the existing StepShell + per-step suites assert.
 *
 * Behavioural render tests (jsdom can't measure layout) covering the contract:
 *   - reached, non-current steps are buttons that navigate on click
 *   - the current step and not-yet-reached steps are NOT clickable
 *   - the Back button navigates to the previous step, and is hidden on welcome
 *   - without the provider the rail is static and there is no Back button
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepShell } from "./StepShell";
import { SetupNavProvider } from "./setup-nav";

function renderWithNav(
  current: Parameters<typeof StepShell>[0]["current"],
  maxReachedIdx: number,
  navigate: (step: string) => void,
) {
  return render(
    <SetupNavProvider value={{ navigate: navigate as never, maxReachedIdx }}>
      <StepShell
        current={current}
        title="Title"
        primary={{ label: "Continue", onClick: () => {} }}
      >
        body
      </StepShell>
    </SetupNavProvider>,
  );
}

describe("setup wizard navigation (clickable rail + Back)", () => {
  it("renders reached, non-current steps as buttons that navigate on click", () => {
    const navigate = vi.fn();
    // current = wifi (idx 5); the customer has reached vpn (idx 10 after the
    // Onboarding-Flow internet→wifi+address split shifted later steps by one).
    renderWithNav("wifi", 10, navigate);

    // An earlier completed step is clickable…
    const welcome = screen.getByRole("button", { name: "Go to Welcome" });
    welcome.click();
    expect(navigate).toHaveBeenCalledWith("welcome");

    // …and a reached step AHEAD of the current one (jumped back from) is too.
    const remote = screen.getByRole("button", { name: "Go to Remote access" });
    remote.click();
    expect(navigate).toHaveBeenCalledWith("vpn");
  });

  it("does not make the current step or not-yet-reached steps clickable", () => {
    const navigate = vi.fn();
    // current = wifi (idx 5), nothing beyond it reached.
    renderWithNav("wifi", 5, navigate);

    // Current step is not a navigation button.
    expect(
      screen.queryByRole("button", { name: "Go to Home Wi-Fi" }),
    ).toBeNull();
    // Internet address (idx 6) is past the furthest-reached index → locked.
    expect(
      screen.queryByRole("button", { name: "Go to Internet address" }),
    ).toBeNull();
    // But an earlier step is reachable.
    expect(
      screen.getByRole("button", { name: "Go to 2-step" }),
    ).toBeInTheDocument();
  });

  it("shows a Back button that navigates to the previous step", () => {
    const navigate = vi.fn();
    renderWithNav("wifi", 5, navigate); // idx 5 → previous is twofactor (idx 4)
    const back = screen.getByRole("button", { name: /back/i });
    back.click();
    expect(navigate).toHaveBeenCalledWith("twofactor");
  });

  it("hides the Back button on the welcome step", () => {
    const navigate = vi.fn();
    renderWithNav("welcome", 0, navigate);
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
  });

  it("stays static with no Back button when no nav provider is present", () => {
    render(
      <StepShell
        current="wifi"
        title="Title"
        primary={{ label: "Continue", onClick: () => {} }}
      >
        body
      </StepShell>,
    );
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
    // Rail rows are static divs, not navigation buttons.
    expect(screen.queryByRole("button", { name: "Go to Welcome" })).toBeNull();
  });
});

/**
 * WARP-929 — navigation floor (no unclaim) + per-render hideBack (2FA codes).
 * The page sets `firstNavigableIdx` to the Workspace (org, idx 3) step, so
 * welcome/claim/account are a one-way floor: no Back, no rail jump back into
 * them. `hideBack` suppresses backward nav entirely for the render.
 */
describe("setup wizard navigation — floor + hideBack (WARP-929)", () => {
  const ORG_IDX = 3; // welcome=0, claim=1, account=2, org=3, twofactor=4

  function renderWithFloor(
    current: Parameters<typeof StepShell>[0]["current"],
    opts: { maxReachedIdx: number; hideBack?: boolean },
    navigate: (step: string) => void,
  ) {
    return render(
      <SetupNavProvider
        value={{
          navigate: navigate as never,
          maxReachedIdx: opts.maxReachedIdx,
          firstNavigableIdx: ORG_IDX,
        }}
      >
        <StepShell
          current={current}
          title="Title"
          primary={{ label: "Continue", onClick: () => {} }}
          hideBack={opts.hideBack}
        >
          body
        </StepShell>
      </SetupNavProvider>,
    );
  }

  it("hides Back on the account step (at/under the floor) — can't go back to unclaim", () => {
    renderWithFloor("account", { maxReachedIdx: 5 }, vi.fn());
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
  });

  it("hides Back ON the Workspace floor itself (its only backward target is account)", () => {
    renderWithFloor("org", { maxReachedIdx: 5 }, vi.fn());
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
  });

  it("shows Back from the step after the floor, targeting the floor (not account)", () => {
    const navigate = vi.fn();
    renderWithFloor("twofactor", { maxReachedIdx: 5 }, navigate); // idx 4 → org (3)
    screen.getByRole("button", { name: /^back$/i }).click();
    expect(navigate).toHaveBeenCalledWith("org");
  });

  it("makes welcome/claim/account rail rows static even when reached (floor)", () => {
    renderWithFloor("twofactor", { maxReachedIdx: 5 }, vi.fn());
    expect(screen.queryByRole("button", { name: "Go to Welcome" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go to Account" })).toBeNull();
  });

  it("hideBack suppresses Back AND rail jumps even past the floor (2FA codes screen)", () => {
    renderWithFloor("twofactor", { maxReachedIdx: 5, hideBack: true }, vi.fn());
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
    // No reached step is clickable while the one-time codes are on screen.
    expect(screen.queryByRole("button", { name: /^Go to / })).toBeNull();
  });
});
