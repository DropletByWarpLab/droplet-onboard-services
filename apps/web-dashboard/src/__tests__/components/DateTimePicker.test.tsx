/**
 * Calendar UX clarity (Samantha QA #bugs) — <DateTimePicker>.
 *
 * A discrete date input plus a 15-minute-increment time <select>, replacing the
 * opaque native datetime-local control. Contract: it reads / writes the same
 * `YYYY-MM-DDTHH:mm` local-input string the form already round-trips through
 * isoToLocalInput / localInputToIso, so picking a time fires onChange with a
 * fully-formed value and the stored ISO stays correct.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateTimePicker } from "@/components/calendar/DateTimePicker";

describe("DateTimePicker", () => {
  it("renders a date input and a time select reflecting the value", () => {
    render(
      <DateTimePicker
        value="2026-05-12T09:30"
        onChange={vi.fn()}
        label="Starts"
      />,
    );
    const date = screen.getByLabelText(/Starts date/i) as HTMLInputElement;
    const time = screen.getByLabelText(/Starts time/i) as HTMLSelectElement;
    expect(date.value).toBe("2026-05-12");
    expect(time.value).toBe("09:30");
  });

  it("offers 15-minute increments in the time dropdown", () => {
    render(
      <DateTimePicker
        value="2026-05-12T09:30"
        onChange={vi.fn()}
        label="Starts"
      />,
    );
    const time = screen.getByLabelText(/Starts time/i) as HTMLSelectElement;
    const values = Array.from(time.options).map((o) => o.value);
    expect(values).toContain("00:00");
    expect(values).toContain("09:15");
    expect(values).toContain("09:45");
    expect(values).toContain("23:45");
    expect(values).toHaveLength(96);
  });

  it("emits a fully-formed local-input string when the time changes", () => {
    const onChange = vi.fn();
    render(
      <DateTimePicker
        value="2026-05-12T09:30"
        onChange={onChange}
        label="Starts"
      />,
    );
    fireEvent.change(screen.getByLabelText(/Starts time/i), {
      target: { value: "14:15" },
    });
    expect(onChange).toHaveBeenCalledWith("2026-05-12T14:15");
  });

  it("emits a fully-formed local-input string when the date changes", () => {
    const onChange = vi.fn();
    render(
      <DateTimePicker
        value="2026-05-12T09:30"
        onChange={onChange}
        label="Starts"
      />,
    );
    fireEvent.change(screen.getByLabelText(/Starts date/i), {
      target: { value: "2026-06-01" },
    });
    expect(onChange).toHaveBeenCalledWith("2026-06-01T09:30");
  });

  it("snaps an off-grid carried-over time so the dropdown still selects it", () => {
    render(
      <DateTimePicker
        value="2026-05-12T09:37"
        onChange={vi.fn()}
        label="Due"
      />,
    );
    const time = screen.getByLabelText(/Due time/i) as HTMLSelectElement;
    // 09:37 snaps to the nearest quarter (09:30) so the <select> has a real
    // matching option instead of rendering blank.
    expect(time.value).toBe("09:30");
  });

  it("disables both controls when disabled", () => {
    render(
      <DateTimePicker
        value="2026-05-12T09:30"
        onChange={vi.fn()}
        label="Starts"
        disabled
      />,
    );
    expect(screen.getByLabelText(/Starts date/i)).toBeDisabled();
    expect(screen.getByLabelText(/Starts time/i)).toBeDisabled();
  });

  it("does not emit until both date and time are present", () => {
    const onChange = vi.fn();
    render(<DateTimePicker value="" onChange={onChange} label="Due" />);
    // Only a date so far — no time picked yet — must not emit a malformed value.
    fireEvent.change(screen.getByLabelText(/Due date/i), {
      target: { value: "2026-06-01" },
    });
    expect(onChange).not.toHaveBeenCalledWith(expect.stringContaining("undefined"));
    // Now pick a time → a complete value flows out.
    fireEvent.change(screen.getByLabelText(/Due time/i), {
      target: { value: "08:00" },
    });
    expect(onChange).toHaveBeenLastCalledWith("2026-06-01T08:00");
  });

  it("gives the date field a width floor so the full date (incl. year) is not clipped", () => {
    render(
      <DateTimePicker
        value="2026-05-12T09:30"
        onChange={vi.fn()}
        label="Starts"
      />,
    );
    const date = screen.getByLabelText(/Starts date/i) as HTMLInputElement;
    // The collapse-enabling class must be gone…
    expect(date.className).not.toMatch(/\bmin-w-0\b/);
    // …and a minimum-width floor sized for a full date must be present so the
    // year always has room to render.
    expect(date.className).toMatch(/min-w-\[/);
  });
});
