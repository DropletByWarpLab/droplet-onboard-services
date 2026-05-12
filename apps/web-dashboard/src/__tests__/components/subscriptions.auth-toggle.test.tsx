/**
 * WARP-308 — SubscriptionsPanel form decouples protocol from auth.
 *
 * Behavior verified:
 *   - the auth dropdown is replaced by a "Requires a username and
 *     password" checkbox
 *   - credential fields appear ONLY when the checkbox is checked
 *   - submitting with auth off sends `authMode: "none"` (regardless of
 *     whether the URL looks like CalDAV or ICS — protocol is auto-detected)
 *   - submitting with auth on sends `authMode: "basic"` plus the credentials
 *   - the URL placeholder no longer claims ICS == no-auth or CalDAV == auth
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const {
  toastMock,
  useCalendarSourcesMock,
  createSourceMock,
  refreshMock,
} = vi.hoisted(() => ({
  toastMock: vi.fn(),
  useCalendarSourcesMock: vi.fn(() => ({
    sources: [],
    refresh: vi.fn(),
    isLoading: false,
  })),
  createSourceMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/lib/hooks/useCalendar", () => ({
  useCalendarSources: useCalendarSourcesMock,
  createSource: createSourceMock,
  syncSource: vi.fn(),
  deleteSource: vi.fn(),
  getPublishUrl: vi.fn(),
}));

import { SubscriptionsPanel } from "@/components/calendar/SubscriptionsPanel";

function openForm() {
  // The "+" Plus icon button has no accessible name; it's the only
  // <button> inside the header row containing "External calendars."
  const allButtons = screen.getAllByRole("button");
  const plus = allButtons.find((b) => b.querySelector("svg.lucide-plus"));
  if (plus) fireEvent.click(plus);
  else fireEvent.click(allButtons[0]);
}

function fillBasics() {
  fireEvent.change(screen.getByPlaceholderText(/Personal iCloud/i), {
    target: { value: "Family iCloud" },
  });
  fireEvent.change(screen.getByPlaceholderText("https://…"), {
    target: { value: "https://example.com/cal.ics" },
  });
}

describe("SubscriptionsPanel — auth toggle (WARP-308)", () => {
  beforeEach(() => {
    toastMock.mockReset();
    createSourceMock.mockReset();
    refreshMock.mockReset();
    useCalendarSourcesMock.mockReturnValue({
      sources: [],
      refresh: refreshMock,
      isLoading: false,
    });
  });

  it("does NOT show username / password fields until the auth checkbox is ticked", () => {
    render(<SubscriptionsPanel />);
    openForm();
    expect(screen.queryByPlaceholderText(/^Username/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/Password/i)).toBeNull();
  });

  it("reveals credential fields when 'Requires a username and password' is ticked", () => {
    render(<SubscriptionsPanel />);
    openForm();
    const checkbox = screen.getByLabelText(/Requires a username and password/i);
    fireEvent.click(checkbox);
    expect(screen.getByPlaceholderText(/^Username/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Password/i)).toBeInTheDocument();
  });

  it("submits authMode='none' without credentials when the box is unticked", async () => {
    createSourceMock.mockResolvedValueOnce({ source: { id: "s1" } });
    render(<SubscriptionsPanel />);
    openForm();
    fillBasics();
    fireEvent.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(createSourceMock).toHaveBeenCalled());
    const args = createSourceMock.mock.calls[0][0];
    expect(args).toMatchObject({
      name: "Family iCloud",
      url: "https://example.com/cal.ics",
      authMode: "none",
    });
    expect(args.username).toBeUndefined();
    expect(args.password).toBeUndefined();
  });

  it("submits authMode='basic' with credentials when the box is ticked", async () => {
    createSourceMock.mockResolvedValueOnce({ source: { id: "s2" } });
    render(<SubscriptionsPanel />);
    openForm();
    fillBasics();
    fireEvent.click(screen.getByLabelText(/Requires a username and password/i));
    fireEvent.change(screen.getByPlaceholderText(/^Username/i), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Password/i), {
      target: { value: "hunter2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add subscription/i }));
    await waitFor(() => expect(createSourceMock).toHaveBeenCalled());
    expect(createSourceMock.mock.calls[0][0]).toMatchObject({
      authMode: "basic",
      username: "alice",
      password: "hunter2",
    });
  });

  it("URL field no longer conflates protocol with auth in its placeholder", () => {
    render(<SubscriptionsPanel />);
    openForm();
    const url = screen.getByPlaceholderText("https://…") as HTMLInputElement;
    expect(url.placeholder).not.toMatch(/CalDAV/i);
    expect(url.placeholder).not.toMatch(/ICS/i);
    // The CalDAV / ICS guidance moved to help text below the field.
    expect(screen.getByText(/auto-detect/i)).toBeInTheDocument();
  });
});
