/**
 * Calendar UX clarity (Samantha QA #bugs) — "create button does not work".
 *
 * The Create button is disabled until BOTH a title and a due time exist, with
 * no visible hint, so testers read it as broken. This adds inline helper text
 * explaining the requirement, and swaps the opaque native datetime-local due
 * field for the date + 15-minute time dropdown — while still storing a correct
 * ISO `dueAt`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const useRemindersMock = vi.fn();
const createReminderMock = vi.fn();
const patchReminderMock = vi.fn();
const deleteReminderMock = vi.fn();

vi.mock("@/lib/hooks/useReminders", () => ({
  useReminders: (...a: any[]) => useRemindersMock(...a),
  createReminder: (...a: any[]) => createReminderMock(...a),
  patchReminder: (...a: any[]) => patchReminderMock(...a),
  deleteReminder: (...a: any[]) => deleteReminderMock(...a),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { RemindersPanel } from "@/components/calendar/RemindersPanel";

beforeEach(() => {
  useRemindersMock.mockReset();
  createReminderMock.mockReset();
  patchReminderMock.mockReset();
  deleteReminderMock.mockReset();
  useRemindersMock.mockReturnValue({
    reminders: [],
    isLoading: false,
    refresh: vi.fn(),
  });
});

function openForm() {
  fireEvent.click(screen.getByRole("button", { name: /new reminder/i }));
}

describe("RemindersPanel — create helper text (Samantha QA #bugs)", () => {
  it("shows helper text explaining the title + due time requirement", () => {
    render(<RemindersPanel />);
    openForm();
    expect(
      screen.getByText(/add a title and a due time to create a reminder/i),
    ).toBeInTheDocument();
  });

  it("the Create button stays disabled until both title and due time are set", () => {
    render(<RemindersPanel />);
    openForm();
    const create = screen.getByRole("button", { name: /^create$/i });
    expect(create).toBeDisabled();

    // Title only — still disabled.
    fireEvent.change(screen.getByPlaceholderText(/reminder title/i), {
      target: { value: "Call dentist" },
    });
    expect(create).toBeDisabled();

    // Add a due date + time → enabled.
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/due time/i), {
      target: { value: "09:00" },
    });
    expect(create).not.toBeDisabled();
  });

  it("uses a 15-minute time dropdown for the due time", () => {
    render(<RemindersPanel />);
    openForm();
    const time = screen.getByLabelText(/due time/i) as HTMLSelectElement;
    expect(time.tagName).toBe("SELECT");
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: "2026-06-01" },
    });
    const values = Array.from(time.options).map((o) => o.value);
    expect(values).toContain("09:15");
    expect(values).toContain("23:45");
  });

  it("stores a correct ISO dueAt from the picked date + time", async () => {
    createReminderMock.mockResolvedValueOnce({});
    render(<RemindersPanel />);
    openForm();

    fireEvent.change(screen.getByPlaceholderText(/reminder title/i), {
      target: { value: "Call dentist" },
    });
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/due time/i), {
      target: { value: "09:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(createReminderMock).toHaveBeenCalled());
    const arg = createReminderMock.mock.calls[0][0];
    expect(arg.title).toBe("Call dentist");
    // dueAt must be 2026-06-01 09:30 local converted to UTC ISO.
    const expected = new Date(2026, 5, 1, 9, 30).toISOString();
    expect(arg.dueAt).toBe(expected);
  });
});
