import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSetupNav } from "@/components/setup/setup-nav";
import { STEPS } from "@/components/setup/wizard-steps";

const auth = vi.hoisted(() => ({
  state: { appliance: "unclaimed", setupStep: "accounts", userTourCompleted: false },
  user: { id: "owner", role: "owner" } as { id: string; role: string } | null,
  loading: false,
}));
const patch = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ setupState: auth.state, user: auth.user, isLoading: auth.loading, setupProbeError: null, setupAutoRetrying: false }) }));
vi.mock("@/lib/api", () => ({ patchSetupStep: patch }));
vi.mock("@/components/setup/steps/AccountsStep", () => ({
  AccountsStep: ({ onComplete, onSkip, beforeConnect }: {
    onComplete: () => void; onSkip: () => void; beforeConnect: () => Promise<void>;
  }) => {
    const nav = useSetupNav();
    return <div>
      <h1>Accounts step</h1>
      <p>Highest reached: {nav?.maxReachedIdx}</p>
      <button onClick={onComplete}>Continue accounts</button>
      <button onClick={onSkip}>Skip accounts</button>
      <button onClick={() => void beforeConnect()}>Connect account</button>
    </div>;
  },
}));
vi.mock("@/components/setup/steps/WelcomeStep", () => ({ WelcomeStep: () => <h1>Welcome step</h1> }));
vi.mock("@/components/setup/steps/AccountStep", () => ({
  AccountStep: ({ signInOnly }: { signInOnly?: boolean }) => <h1>{signInOnly ? "Sign in to resume" : "Create account"}</h1>,
}));
vi.mock("@/components/setup/steps/TeamStep", () => ({ TeamStep: () => <h1>Team step</h1> }));
vi.mock("@/components/setup/steps/DoneStep", () => ({ DoneStep: () => <h1>Done step</h1> }));
vi.mock("@/components/setup/steps/VoiceStep", () => ({
  VoiceStep: ({ onComplete, onSkip, onAutoSkip }: {
    onComplete: () => void; onSkip: () => void; onAutoSkip: () => void;
  }) => <div>
    <button onClick={onComplete}>Continue voice</button>
    <button onClick={onSkip}>Skip voice</button>
    <button onClick={onAutoSkip}>Unavailable voice</button>
  </div>,
}));

import SetupPage from "@/app/setup/page";

describe("setup account connection handoff", () => {
  beforeEach(() => {
    patch.mockClear();
    auth.state = { appliance: "unclaimed", setupStep: "accounts", userTourCompleted: false };
    auth.user = { id: "owner", role: "owner" };
    auth.loading = false;
    window.history.replaceState({}, "", "/setup");
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("resumes the durable accounts step and requires a successful save before consent", async () => {
    render(<SetupPage />);
    expect(screen.getByRole("heading", { name: "Accounts step" })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByText("Connect account")));
    expect(patch).toHaveBeenCalledWith("accounts", { requireSuccess: true });
  });

  it.each(["Continue voice", "Skip voice", "Unavailable voice"])("%s leads to accounts before team", (button) => {
    auth.state.setupStep = "voice";
    render(<SetupPage />);
    fireEvent.click(screen.getByText(button));
    expect(screen.getByRole("heading", { name: "Accounts step" })).toBeInTheDocument();
    expect(patch).toHaveBeenCalledWith("accounts");
  });

  it.each(["Continue accounts", "Skip accounts"])("%s advances to team", (button) => {
    render(<SetupPage />);
    fireEvent.click(screen.getByText(button));
    expect(screen.getByRole("heading", { name: "Team step" })).toBeInTheDocument();
    expect(patch).toHaveBeenCalledWith("team");
  });

  it("reopens revisited accounts after OAuth without relocking the reached team step", () => {
    auth.state.setupStep = "team";
    window.history.replaceState({}, "", "/setup?step=accounts&google=connected");
    const first = render(<SetupPage />);
    expect(screen.getByRole("heading", { name: "Accounts step" })).toBeInTheDocument();
    expect(screen.getByText(`Highest reached: ${STEPS.indexOf("team")}`)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?google=connected");
    first.unmount();
    render(<SetupPage />);
    expect(screen.getByRole("heading", { name: "Team step" })).toBeInTheDocument();
  });

  it("cannot use a callback URL to bypass the first account setup", () => {
    auth.state.setupStep = "welcome";
    window.history.replaceState({}, "", "/setup?step=accounts");
    render(<SetupPage />);
    expect(screen.getByRole("heading", { name: "Welcome step" })).toBeInTheDocument();
  });

  it("keeps a completed wizard on Done", () => {
    auth.state = { appliance: "ready", setupStep: "done", userTourCompleted: false };
    window.history.replaceState({}, "", "/setup?step=accounts");
    render(<SetupPage />);
    expect(screen.getByRole("heading", { name: "Done step" })).toBeInTheDocument();
  });

  it("waits for the cold owner session probe before mounting authenticated steps", () => {
    auth.user = null;
    auth.loading = true;
    const view = render(<SetupPage />);
    expect(screen.getByText(/connecting to your droplet/i)).toBeInTheDocument();
    expect(screen.queryByText("Accounts step")).not.toBeInTheDocument();
    auth.user = { id: "owner", role: "owner" };
    auth.loading = false;
    view.rerender(<SetupPage />);
    expect(screen.getByRole("heading", { name: "Accounts step" })).toBeInTheDocument();
  });

  it("reauthenticates an expired session and preserves the provider handoff until restored", () => {
    auth.user = null;
    auth.state.setupStep = "team";
    window.history.replaceState({}, "", "/setup?step=accounts&m365=connected");
    const view = render(<SetupPage />);
    expect(screen.getByRole("heading", { name: "Sign in to resume" })).toBeInTheDocument();
    expect(window.location.search).toBe("?step=accounts&m365=connected");
    expect(patch).not.toHaveBeenCalled();
    auth.user = { id: "owner", role: "owner" };
    view.rerender(<SetupPage />);
    expect(screen.getByRole("heading", { name: "Accounts step" })).toBeInTheDocument();
    expect(screen.getByText(`Highest reached: ${STEPS.indexOf("team")}`)).toBeInTheDocument();
  });
});
