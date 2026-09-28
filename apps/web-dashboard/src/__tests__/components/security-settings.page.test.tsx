/**
 * WARP-2977 P2b (spec §8 "/security/settings") — the Opening hours page.
 * WARP-2978 (ADR-059 P3 §8, D33) — now "Security settings": the opening
 * hours keep their section, and "Who's told about alerts" joins below.
 *
 * The page wires the hours hook, the caller's Security level and the toasts
 * to the editors. What it must hold: the title and the sub that says what the
 * hours are NOT (a calendar, a lock, an alert); edits only at manage (the
 * level fails closed); every write through the hook with the version it read;
 * and every failure as `translateError(err, "security")`, never the server's
 * own message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SecurityHoursDay, SecurityHoursView } from "@/lib/types";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: { title?: string; sub?: string; children: ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p data-testid="page-sub">{sub}</p> : null}
      {children}
    </div>
  ),
}));

const h = vi.hoisted(() => ({
  level: "manage" as "none" | "view" | "act" | "manage",
  toast: vi.fn(),
  hours: null as unknown,
  error: undefined as Error | undefined,
  save: vi.fn(),
  saveException: vi.fn(),
  deleteException: vi.fn(),
  mutate: vi.fn(async () => undefined),
}));

// Answers only for the Security module: a page that asked about any other
// module's level would read "none" and lose every control.
vi.mock("@/lib/hooks/useModuleGate", async (orig) => ({
  ...(await orig<typeof import("@/lib/hooks/useModuleGate")>()),
  useModuleLevel: (moduleId: string) => (moduleId === "security" ? h.level : "none"),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/lib/hooks/useSecurity", () => ({
  // WARP-2978 — the routing panel's own read; its behaviour is AlertRoutingPanel.test.tsx's.
  useAlertRouting: () => ({ routing: null, error: undefined, isLoading: true, refresh: vi.fn(), set: vi.fn() }),
  useSecurityHours: () => ({
    hours: h.hours,
    error: h.error,
    isLoading: h.hours === null && !h.error,
    mutate: h.mutate,
    save: h.save,
    saveException: h.saveException,
    deleteException: h.deleteException,
  }),
}));

import SecuritySettingsPage from "@/app/security/settings/page";
import { moduleForPath } from "@/components/nav-config";
import { COPY } from "@/components/security/HoursEditor";
import { COPY as SPECIAL } from "@/components/security/ExceptionsEditor";

const WEEK: SecurityHoursDay[] = [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
  weekday <= 5
    ? { weekday, kind: "hours", opens: "09:00", closes: "17:00" }
    : { weekday, kind: "closed", opens: null, closes: null },
);

function view(over: Partial<SecurityHoursView> = {}): SecurityHoursView {
  return {
    state: "set",
    timezone: "Europe/London",
    version: 12,
    days: WEEK,
    exceptions: [{ date: "2099-12-25", kind: "closed", opens: null, closes: null, note: "Christmas" }],
    preview: [{ startsAt: "2099-01-05T09:00:00.000Z", endsAt: "2099-01-05T17:00:00.000Z" }],
    hint: { workspaceTimezone: "Europe/London", typicalDay: "Open 9 to 5 on weekdays." },
    ...over,
  };
}

/** A typed apiFetch failure: `.code` is the server's error.code, `.message` its raw text. */
function apiError(code: string, status: number): Error {
  return Object.assign(new Error(`raw server text for ${code}`), { code, status });
}

beforeEach(() => {
  h.level = "manage";
  h.hours = view();
  h.error = undefined;
  h.toast.mockReset();
  h.save.mockReset().mockResolvedValue({ hours: view({ version: 13 }), mode: {} });
  h.saveException.mockReset().mockResolvedValue({ hours: view({ version: 13 }), mode: {} });
  h.deleteException.mockReset().mockResolvedValue(undefined);
  h.mutate.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/security/settings", () => {
  it("is titled Security settings; the hours keep their section and say what they are not (WARP-2978)", () => {
    render(<SecuritySettingsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Security settings" })).toBeInTheDocument();
    expect(screen.getByTestId("page-sub")).toHaveTextContent("When the site is normally open, and who's told about alerts.");
    expect(screen.getByRole("heading", { level: 2, name: "Opening hours" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "When the site is normally open. Droplet uses this to tell ordinary activity from after-hours activity. " +
          "It is set here, not read from your calendar. Nothing here locks doors.",
      ),
    ).toBeInTheDocument();
  });

  it("who's told about alerts is its own section, after the hours", () => {
    render(<SecuritySettingsPage />);
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent);
    expect(h2.indexOf("Who's told about alerts")).toBeGreaterThan(h2.indexOf("Opening hours"));
  });

  it("at manage: saves the week through the hook with exactly seven days and the read version", async () => {
    render(<SecuritySettingsPage />);
    fireEvent.change(screen.getByLabelText("Closes on Monday"), { target: { value: "18:00" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const body = h.save.mock.calls[0]![0];
    expect(body.state).toBe("set");
    expect(body.expectedVersion).toBe(12);
    expect(body.days).toHaveLength(7);
    expect(body.days.map((d: { weekday: number }) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(COPY.savedToast, "success"));
  });

  it("shows a failed save as the friendly security copy, never the server's message", async () => {
    h.save.mockRejectedValue(apiError("SAME_OPEN_CLOSE", 400));
    render(<SecuritySettingsPage />);
    fireEvent.change(screen.getByLabelText("Closes on Monday"), { target: { value: "18:00" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    const [message, type] = h.toast.mock.calls[0]!;
    expect(type).toBe("error");
    expect(message).toBe(
      "Opening and closing times can't be the same. For a day that never closes, choose Open all day.",
    );
    expect(message).not.toContain("raw server text");
    expect(screen.queryByText(COPY.conflict)).toBeNull();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("turns a VERSION_CONFLICT into the keep-your-draft notice, and re-reads in the background", async () => {
    h.save.mockRejectedValue(apiError("VERSION_CONFLICT", 409));
    render(<SecuritySettingsPage />);
    fireEvent.change(screen.getByLabelText("Closes on Monday"), { target: { value: "18:00" } });
    fireEvent.click(screen.getByRole("button", { name: COPY.save }));
    expect(await screen.findByText(COPY.conflict)).toBeInTheDocument();
    // The editor's banner explains it; a "refresh the page" toast beside it would cost the draft.
    expect(h.toast).not.toHaveBeenCalled();
    // The re-read that lets a special-day-only conflict resolve without losing the draft.
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Closes on Monday") as HTMLInputElement).value).toBe("18:00");
    fireEvent.click(screen.getByRole("button", { name: COPY.showTheirs }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(2));
  });

  // The server committed and audited the write but couldn't read it back: a SAVE, never "try again".
  it("a save answered with null views is saved: the saved-but-refresh toast, no conflict, the draft settles", async () => {
    h.save.mockResolvedValue({ hours: null, mode: null });
    render(<SecuritySettingsPage />);
    fireEvent.change(screen.getByLabelText("Closes on Monday"), { target: { value: "18:00" } });
    expect(screen.getByText(COPY.unsaved)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: COPY.save }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(COPY.savedUnreadToast, "success"));
    expect(screen.queryByText(COPY.unsaved)).toBeNull();
    expect(screen.queryByText(COPY.conflict)).toBeNull();
    expect(h.toast).toHaveBeenCalledTimes(1);
  });

  it("a special day answered with null views is saved too", async () => {
    h.saveException.mockResolvedValue({ hours: null, mode: null });
    render(<SecuritySettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: SPECIAL.add }));
    const form = screen.getByRole("form", { name: SPECIAL.add });
    const date = within(form).getByLabelText(SPECIAL.date) as HTMLInputElement;
    fireEvent.change(date, { target: { value: date.min } });
    fireEvent.click(within(form).getByRole("button", { name: SPECIAL.save }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(SPECIAL.savedUnreadToast, "success"));
    await waitFor(() => expect(screen.queryByRole("form", { name: SPECIAL.add })).toBeNull());
  });

  it("lives under the Security route guard, not the always-on /settings", () => {
    expect(moduleForPath("/security/settings")?.moduleId).toBe("security");
  });

  it("adds a special day with the hours version it read", async () => {
    render(<SecuritySettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: SPECIAL.add }));
    const form = screen.getByRole("form", { name: SPECIAL.add });
    const date = within(form).getByLabelText(SPECIAL.date) as HTMLInputElement;
    fireEvent.change(date, { target: { value: date.min } });
    fireEvent.click(within(form).getByRole("button", { name: SPECIAL.save }));
    await waitFor(() =>
      expect(h.saveException).toHaveBeenCalledWith(date.min, { kind: "closed", expectedVersion: 12 }),
    );
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(SPECIAL.savedToast, "success"));
  });

  it("removes a special day with the hours version it read, and re-reads on a conflict", async () => {
    h.deleteException.mockRejectedValue(apiError("VERSION_CONFLICT", 409));
    render(<SecuritySettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Remove / }));
    await waitFor(() => expect(h.deleteException).toHaveBeenCalledWith("2099-12-25", 12));
    await waitFor(() => expect(h.mutate).toHaveBeenCalled());
    // The page has re-read: the special-day copy says the latest is showing, never "refresh".
    expect(h.toast).toHaveBeenCalledWith(SPECIAL.conflictToast, "error");
    expect(SPECIAL.conflictToast).not.toMatch(/refresh/i);
  });

  it("shows the server's preview and the business profile's words", () => {
    render(<SecuritySettingsPage />);
    expect(within(screen.getByTestId("hours-preview")).getAllByRole("listitem")).toHaveLength(1);
    const hint = screen.getByTestId("profile-hint");
    expect(within(hint).getByText("What your business profile says")).toBeInTheDocument();
    expect(within(hint).getByText("Open 9 to 5 on weekdays.")).toBeInTheDocument();
    expect(within(hint).queryAllByRole("button")).toEqual([]);
  });

  // The hint helps whoever edits the hours; the server also blanks it below owner/admin (the §15 ladder).
  it.each(["view", "act"] as const)("below manage (%s) the business profile's words are never shown, even if sent", (level) => {
    h.level = level;
    render(<SecuritySettingsPage />);
    expect(screen.queryByTestId("profile-hint")).toBeNull();
    expect(screen.queryByText("Open 9 to 5 on weekdays.")).toBeNull();
  });

  it("with no hours set: presets, no preview, no special-day form", () => {
    h.hours = view({
      state: "not_set",
      timezone: null,
      version: 0,
      exceptions: [],
      preview: [],
      hint: { workspaceTimezone: null, typicalDay: "" },
      days: WEEK.map((d) => ({ ...d, kind: "closed", opens: null, closes: null })),
    });
    render(<SecuritySettingsPage />);
    expect(screen.getByRole("button", { name: "Weekdays 9–5" })).toBeInTheDocument();
    expect(screen.queryByTestId("hours-preview")).toBeNull();
    expect(screen.queryByTestId("profile-hint")).toBeNull();
    expect(screen.queryByRole("button", { name: SPECIAL.add })).toBeNull();
    expect(screen.getByText(SPECIAL.needsHours)).toBeInTheDocument();
  });

  it.each(["view", "act"] as const)("below manage (%s): everything read-only, and who can change it", (level) => {
    h.level = level;
    const { container } = render(<SecuritySettingsPage />);
    expect(screen.getByText("Only people who manage Security can change opening hours.")).toBeInTheDocument();
    expect(screen.queryByText(/admins?/i)).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
    // The information is all still there.
    expect(screen.getByText("Times are in Europe/London")).toBeInTheDocument();
    expect(screen.getByTestId("special-days")).toHaveTextContent("Christmas");
    expect(screen.getByTestId("hours-preview")).toBeInTheDocument();
  });

  it("while loading: a busy card, no editor", () => {
    h.hours = null;
    render(<SecuritySettingsPage />);
    expect(screen.getByTestId("hours-loading")).toHaveAttribute("aria-busy", "true");
    // A spinner alone announces nothing.
    expect(screen.getByTestId("hours-loading")).toHaveTextContent(COPY.loading);
    expect(screen.queryByRole("button", { name: COPY.save })).toBeNull();
  });

  it("a failed load says so in the security copy and can retry", () => {
    h.hours = null;
    h.error = apiError("HOURS_UNAVAILABLE", 503);
    render(<SecuritySettingsPage />);
    const card = screen.getByTestId("hours-error");
    expect(card).toHaveTextContent("Droplet couldn't load the opening hours right now. Try again in a moment.");
    expect(card).not.toHaveTextContent("raw server text");
    fireEvent.click(within(card).getByRole("button", { name: COPY.retry }));
    expect(h.mutate).toHaveBeenCalled();
  });
});
