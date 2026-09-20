/**
 * WARP-2519 — the practice surface's lifecycle handlers, which used to swallow
 * every failure.
 *
 * The shipped code was:
 *
 *   async function toggleWrites(next: boolean) {
 *     try { await setProviderWrites(connection.provider, next); }
 *     catch { /* backend not wired yet — surfaced elsewhere *\/ }
 *     refresh();
 *   }
 *
 * It was not surfaced elsewhere. `refresh()` re-read the unchanged connection,
 * the toggle sprang back, and nothing said why — no banner, no alert, not even
 * a console line, because a bare `catch {}` hides the failure from the console
 * too. For a WRITE KILL-SWITCH that is the worst available behaviour: the
 * owner is left believing writes are off while the box still has them on.
 *
 * The disconnect half of the same defect is fixed structurally rather than
 * here — `DisconnectControl` (WARP-2518) owns that call and its failure, and
 * the page no longer has a `disconnect()` handler to swallow anything with.
 * Its own tests live with the two surfaces that render it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { IntegrationConnection } from "@/lib/erp-types";

const { setProviderWritesMock } = vi.hoisted(() => ({ setProviderWritesMock: vi.fn() }));
vi.mock("@/lib/api.erp", () => ({
  setProviderWrites: setProviderWritesMock,
  disconnectProvider: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "owner" } }) }));

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
const CONNECTION: IntegrationConnection = {
  provider: "eaglesoft",
  status: "CONNECTED",
  writeEnabled: false,
};
vi.mock("@/lib/hooks/useEaglesoft", () => ({
  useEaglesoft: () => ({
    connection: CONNECTION,
    kpis: undefined,
    schedule: [],
    refresh: refreshMock,
  }),
  useEaglesoftSchedule: () => ({ entries: [] }),
  useErpAccess: () => ({ canViewPhi: true, canEnableWrites: true, canConfirmWrites: true }),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children }: { children?: ReactNode }) => (
    <div className="droplet-shell">{children}</div>
  ),
}));

import PracticePage from "@/app/practice/page";

beforeEach(() => {
  vi.clearAllMocks();
  setProviderWritesMock.mockResolvedValue(CONNECTION);
});

/** Open Manage and flip the write switch. */
function toggleWrites() {
  fireEvent.click(screen.getByRole("button", { name: /Manage/ }));
  fireEvent.click(screen.getByRole("switch", { name: "Toggle writes" }));
}

describe("the write kill-switch reports a refusal", () => {
  /**
   * The headline. Against `origin/stage` this is red: the `catch {}` produces
   * no DOM change at all.
   *
   * Mutation: put the bare `catch {}` back → red, because nothing is rendered
   * and the owner cannot tell a refused toggle from a slow one.
   */
  it("says so when the box refuses the toggle", async () => {
    setProviderWritesMock.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { code: "DRIFT_LOCKED", status: 409 }),
    );
    render(<PracticePage />);
    toggleWrites();

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Couldn't turn writes on (DRIFT_LOCKED). Try again.",
      ),
    );
  });

  /**
   * Rule 19: the message is built from the typed `code`, never the response
   * body or the thrown `Error.message`, either of which can carry whatever the
   * server or the runtime put there.
   *
   * Mutation: fall back to `(err as Error).message` in
   * `lifecycleErrorMessage` → red.
   */
  it("names no response body and no thrown message", async () => {
    setProviderWritesMock.mockRejectedValueOnce(
      Object.assign(new Error("secret-bearing detail"), {
        code: "FORBIDDEN",
        body: { apiKey: "rk_live_should_never_render" },
      }),
    );
    render(<PracticePage />);
    toggleWrites();

    await waitFor(() => expect(screen.getByText(/Couldn't turn writes on/)).toBeTruthy());
    expect(document.body.textContent).not.toContain("rk_live_should_never_render");
    expect(document.body.textContent).not.toContain("secret-bearing detail");
  });

  /**
   * A typed error with no `code` still produces a sentence rather than a
   * dangling "( )".
   *
   * Mutation: drop the `detail ? … : …` branch → red with "(undefined)".
   */
  it("still says something when the failure carries no code", async () => {
    setProviderWritesMock.mockRejectedValueOnce(new Error("plain"));
    render(<PracticePage />);
    toggleWrites();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't turn writes on. Try again."),
    );
  });

  /**
   * A SUCCESSFUL toggle says nothing — the banner is a failure report, not a
   * receipt, and a stale one must not outlive the state it described.
   *
   * Mutation: set the error unconditionally rather than inside `catch` → red.
   */
  it("stays silent when the toggle lands", async () => {
    render(<PracticePage />);
    toggleWrites();

    await waitFor(() => expect(setProviderWritesMock).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain("Couldn't turn writes");
  });

  /**
   * …and the refresh still runs after a failure, so what the owner is looking
   * at is what the box actually holds. The old handler got this right and it
   * must not be lost while fixing the swallow.
   *
   * Mutation: move `refresh()` into the `try` → red.
   */
  it("re-reads even after a refusal", async () => {
    setProviderWritesMock.mockRejectedValueOnce(new Error("plain"));
    render(<PracticePage />);
    toggleWrites();

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });
});
