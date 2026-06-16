/**
 * PR #381 — Team step (onboarding), the LAST onboarding step.
 *
 * Validates (per the spec + #371 handoff §4 + OnbWizard.jsx WizTeam):
 *   1. Renders the WizTeam surface — "Bring in your team" heading, the
 *      invite-by-email field + role select + Add control, the directory-sync
 *      (SSO) note, and the skip ("I'll invite people later") control.
 *   2. Team IS skippable — the skip control advances the wizard.
 *   3. Adding a valid email + role → POST /api/people/invite → the invitee
 *      shows in the pending list, and the input clears for the next invite.
 *   4. An invalid email → inline error on the email field, NO network call,
 *      invitee not added.
 *   5. A server-rejected invite (InviteError) → inline error, invitee not added.
 *   6. "Send invites & continue" advances to the next step (done).
 *
 * TeamStep is rendered standalone (it takes `onComplete` + `onSkip` callbacks,
 * same contract as the other skippable steps). The full-wizard weave (… → ai →
 * team → done) is covered by setup.flow.test.tsx. The whole `@/lib/api` surface
 * is mocked; the assert-on-DOM-strings style mirrors setup.org.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

const postTeamInviteMock = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    postTeamInvite: (input: unknown) => postTeamInviteMock(input),
  };
});

import { TeamStep } from "@/components/setup/steps/TeamStep";

const onComplete = vi.fn();
const onSkip = vi.fn();

function renderStep() {
  return render(<TeamStep onComplete={onComplete} onSkip={onSkip} />);
}

/** Type an email + (optionally) choose a role, then click Add. */
async function addInvite({
  email,
  role,
}: {
  email: string;
  role?: string;
}) {
  fireEvent.change(screen.getByLabelText(/invite by email/i), {
    target: { value: email },
  });
  if (role) {
    fireEvent.change(screen.getByLabelText(/^role$/i), {
      target: { value: role },
    });
  }
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  postTeamInviteMock.mockReset();
  onComplete.mockReset();
  onSkip.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("setup Team step (PR #381)", () => {
  it("renders the WizTeam surface — heading, email+role, SSO note, skip", () => {
    renderStep();
    expect(screen.getByText(/bring in your team/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/invite by email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^role$/i)).toBeInTheDocument();
    // Directory-sync (SSO) alternative.
    expect(screen.getByText(/sync your directory/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /connect sso/i }),
    ).toBeInTheDocument();
    // Skippable — solo owner is a valid end state.
    expect(
      screen.getByRole("button", { name: /invite (people |them )?later/i }),
    ).toBeInTheDocument();
  });

  it("is skippable — the skip control advances the wizard", () => {
    renderStep();
    fireEvent.click(
      screen.getByRole("button", { name: /invite (people |them )?later/i }),
    );
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("adds a valid invite via POST /api/people/invite and lists it", async () => {
    postTeamInviteMock.mockResolvedValue({
      ok: true,
      token: "tok-abc",
      email: "romain@acme.co",
      role: "family",
      expires_at: "2026-06-04T00:00:00.000Z",
    });
    renderStep();

    await addInvite({ email: "Romain@Acme.CO", role: "family" });

    expect(postTeamInviteMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: "Romain@Acme.CO", role: "family" }),
    );
    // The invitee shows in the pending list (server-normalized email).
    expect(screen.getByText("romain@acme.co")).toBeInTheDocument();
    // The email input clears for the next invite.
    expect(
      (screen.getByLabelText(/invite by email/i) as HTMLInputElement).value,
    ).toBe("");
  });

  it("blocks an invalid email client-side without calling the API", async () => {
    renderStep();
    await addInvite({ email: "not-an-email" });
    expect(postTeamInviteMock).not.toHaveBeenCalled();
    expect(screen.getByText(/valid email/i)).toBeInTheDocument();
  });

  it("surfaces a server-rejected invite inline and does not list it", async () => {
    const { InviteError } = await vi.importActual<typeof import("@/lib/api")>(
      "@/lib/api",
    );
    postTeamInviteMock.mockRejectedValue(
      new InviteError("That email isn't valid.", "INVITE_EMAIL_INVALID"),
    );
    renderStep();

    await addInvite({ email: "weird@thing.x", role: "guest" });

    expect(screen.getByText(/isn't valid|valid email/i)).toBeInTheDocument();
    // Not added to the list.
    expect(screen.queryByText("weird@thing.x")).not.toBeInTheDocument();
  });

  it("'Send invites & continue' advances to the next step", async () => {
    renderStep();
    fireEvent.click(
      screen.getByRole("button", { name: /send invites|continue/i }),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
