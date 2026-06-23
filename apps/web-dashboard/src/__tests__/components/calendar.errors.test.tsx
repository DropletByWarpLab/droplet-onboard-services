import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { toastMock, useRemindersMock, createReminderMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  useRemindersMock: vi.fn(() => ({ reminders: [], refresh: vi.fn(), isLoading: false })),
  createReminderMock: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/lib/hooks/useReminders", () => ({
  useReminders: useRemindersMock,
  createReminder: createReminderMock,
  patchReminder: vi.fn(),
  deleteReminder: vi.fn(),
}));

import { RemindersPanel } from "@/components/calendar/RemindersPanel";

describe("RemindersPanel — typed error → friendly toast (WARP-294)", () => {
  beforeEach(() => {
    toastMock.mockReset();
    createReminderMock.mockReset();
    useRemindersMock.mockReturnValue({
      reminders: [],
      refresh: vi.fn(),
      isLoading: false,
    });
  });

  it("translates create-reminder failures and never passes err.message to the toast", async () => {
    const SECRET = "Validator failed: dueAt before now (orchestrator-leak)";
    createReminderMock.mockRejectedValueOnce(new Error(SECRET));

    render(<RemindersPanel />);
    // Expand the new-reminder form.
    fireEvent.click(screen.getByTitle(/new reminder/i));
    fireEvent.change(screen.getByPlaceholderText(/reminder title/i), {
      target: { value: "Buy milk" },
    });
    // Date + 15-minute time dropdown — provide a future due date/time so the
    // Create button enables.
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: "2030-01-01" },
    });
    fireEvent.change(screen.getByLabelText(/due time/i), {
      target: { value: "10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
    const [text, tone] = toastMock.mock.calls[0];
    expect(tone).toBe("error");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Validator");
    expect(text).not.toContain("orchestrator-leak");
    // Friendly calendar-domain fallback or known-code copy.
    expect(text.length).toBeGreaterThan(0);
  });
});
