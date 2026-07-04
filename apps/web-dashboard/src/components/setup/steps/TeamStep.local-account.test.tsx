/**
 * WARP-1049 — the wizard TeamStep gains a "Create local account" path so the
 * setup person can mint a member NOW with an auto-generated temporary password
 * (show-once + copy) and a forced first-login password change. This closes the
 * gap Stefan reported: the invitee sets their OWN password at first sign-in
 * (the WARP-824 requirePasswordChangeGate forces it) instead of the wizard
 * having no password story at all.
 *
 * The invite-by-link flow (postTeamInvite) is unchanged and covered by the
 * sibling SSO/scrollregion suites — this suite only exercises the NEW dialog.
 *
 * Proven RED first: with the pre-WARP-1049 TeamStep there is no "Create local
 * account" affordance, so the dialog never opens and createUser is never
 * called.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { validatePassword } from "@droplet/auth-policy";

const getEnabledSsoProviders = vi.fn();
const postTeamInvite = vi.fn();
const createUser = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getEnabledSsoProviders: (...a: unknown[]) => getEnabledSsoProviders(...a),
    postTeamInvite: (...a: unknown[]) => postTeamInvite(...a),
    createUser: (...a: unknown[]) => createUser(...a),
  };
});

import { TeamStep } from "./TeamStep";

beforeEach(() => {
  vi.clearAllMocks();
  getEnabledSsoProviders.mockResolvedValue([]);
  postTeamInvite.mockImplementation(async (input: { email: string; role: string }) => ({
    email: input.email.toLowerCase(),
    role: input.role,
  }));
  createUser.mockResolvedValue(undefined);
});

/** Open the "Create local account" dialog. */
async function openDialog() {
  render(<TeamStep onComplete={() => {}} onSkip={() => {}} />);
  // Wait for SSO discovery to settle so the initial paint is stable.
  await screen.findByText(/Sync your directory/i);
  fireEvent.click(screen.getByRole("button", { name: /create (a )?local account/i }));
  return screen.getByRole("dialog");
}

describe("TeamStep — Create local account dialog (WARP-1049)", () => {
  it("opens a dialog with an auto-generated policy-compliant temporary password", async () => {
    const dialog = await openDialog();
    // The generated temp password is shown once. It must satisfy the SAME
    // policy the server enforces, or the create would 400 WEAK_PASSWORD.
    const pwField = within(dialog).getByRole("textbox", { name: "Temporary password" }) as HTMLInputElement;
    expect(pwField.value.length).toBeGreaterThan(0);
    expect(validatePassword(pwField.value).ok).toBe(true);
  });

  it("regenerates a different (still-valid) password on demand", async () => {
    const dialog = await openDialog();
    const pwField = within(dialog).getByRole("textbox", { name: "Temporary password" }) as HTMLInputElement;
    const first = pwField.value;
    fireEvent.click(within(dialog).getByRole("button", { name: /regenerate/i }));
    const second = (within(dialog).getByRole("textbox", { name: "Temporary password" }) as HTMLInputElement).value;
    expect(second).not.toBe(first);
    expect(validatePassword(second).ok).toBe(true);
  });

  it("blocks submit on an invalid email and does NOT call createUser", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/email/i), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(createUser).not.toHaveBeenCalled();
  });

  it("calls createUser once with the chosen role and mustChangePassword=true", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/email/i), {
      target: { value: "kid@warp.test" },
    });
    // Choose a non-default role to prove it's threaded through.
    fireEvent.change(within(dialog).getByLabelText(/^role/i), {
      target: { value: "admin" },
    });
    const generatedPw = (within(dialog).getByRole("textbox", { name: "Temporary password" }) as HTMLInputElement).value;

    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(createUser).toHaveBeenCalledTimes(1));
    const [email, password, displayName, mustChange, role] = createUser.mock.calls[0]!;
    expect(email).toBe("kid@warp.test");
    expect(password).toBe(generatedPw);
    expect(mustChange).toBe(true);
    expect(role).toBe("admin");
    // displayName is optional — either undefined or a string, never the password.
    expect(displayName).not.toBe(generatedPw);
  });

  it("guards against double-submit (createUser called once on a rapid double-click)", async () => {
    // Keep the request in flight so the guard is the only thing preventing a
    // second submission.
    createUser.mockImplementation(() => new Promise<void>(() => {}));
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/email/i), {
      target: { value: "kid@warp.test" },
    });
    const btn = within(dialog).getByRole("button", { name: /create account/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(createUser).toHaveBeenCalledTimes(1));
    expect(createUser).toHaveBeenCalledTimes(1);
  });

  it("shows a hand-off phase with the email + temp password after a successful create", async () => {
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/email/i), {
      target: { value: "kid@warp.test" },
    });
    const generatedPw = (within(dialog).getByRole("textbox", { name: "Temporary password" }) as HTMLInputElement).value;
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));

    // The handoff copy tells the operator to give the member the temp password;
    // they'll set their own at first sign-in.
    expect(await screen.findByText(/first sign-in|first login|choose their own/i)).toBeInTheDocument();
    // Both the email and the exact generated password remain visible to hand off
    // WITHIN the dialog (the pending list below also shows the email, so scope
    // the assertion to the dialog to avoid the expected duplicate).
    const handoffDialog = screen.getByRole("dialog");
    expect(within(handoffDialog).getByText("kid@warp.test")).toBeInTheDocument();
    expect(within(handoffDialog).getByText(generatedPw)).toBeInTheDocument();
  });

  it("surfaces a 409 EMAIL_TAKEN from the server as an inline error", async () => {
    const err = new Error("That email address is already in use") as Error & { code?: string };
    err.code = "EMAIL_TAKEN";
    createUser.mockRejectedValueOnce(err);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/email/i), {
      target: { value: "dup@warp.test" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /create account/i }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/already in use/i);
  });
});
