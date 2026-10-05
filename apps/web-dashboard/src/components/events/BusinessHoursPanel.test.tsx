import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BusinessHoursPanel } from "./BusinessHoursPanel";
import type { CameraBusinessHours } from "@/lib/types";

let role = "owner";
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role } }) }));

const unset: CameraBusinessHours = {
  configured: false,
  timezone: "UTC",
  days: { monday: null, tuesday: null, wednesday: null, thursday: null, friday: null, saturday: null, sunday: null },
};
const configured: CameraBusinessHours = {
  ...unset,
  configured: true,
  timezone: "America/Los_Angeles",
  days: { ...unset.days, monday: { open: "09:00", close: "17:00" } },
};

const save = vi.fn();
function panel(schedule = unset, extra = {}) {
  return render(<BusinessHoursPanel schedule={schedule} isLoading={false} error={undefined} onRetry={vi.fn()} onSave={save} activityCount={7} outsideCount={2} activityLoading={false} activityError={undefined} hasMore={false} {...extra} />);
}

beforeEach(() => { role = "owner"; save.mockReset(); save.mockResolvedValue(undefined); });
afterEach(cleanup);

describe("camera business hours", () => {
  it("keeps draft hours inactive until explicit save and persists timezone, closed days and overnight hours", async () => {
    panel();
    expect(screen.getByText(/Business hours have not been set/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Set business hours" }));
    fireEvent.change(screen.getByLabelText("Business hours time zone"), { target: { value: "America/Chicago" } });
    fireEvent.change(screen.getByLabelText("Monday opens"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText("Monday closes"), { target: { value: "06:00" } });
    fireEvent.click(screen.getByLabelText("Tuesday open"));
    expect(screen.getByText("Ends next day")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({ configured: true, timezone: "America/Chicago", days: { monday: { open: "22:00", close: "06:00" }, tuesday: null, saturday: null, sunday: null } });
    expect(await screen.findByText("Business hours saved.")).toBeInTheDocument();
  });

  it("shows camera viewers the saved schedule and loaded activity count without edit controls", () => {
    role = "family";
    panel(configured, { hasMore: true });
    expect(screen.getByText(/America\/Los_Angeles/)).toBeInTheDocument();
    expect(screen.getByText("Mon: 09:00–17:00")).toBeInTheDocument();
    expect(screen.getByText(/2 outside business hours in 7 loaded results/)).toHaveTextContent("Load more to check older activity.");
    expect(screen.queryByRole("button", { name: "Edit hours" })).not.toBeInTheDocument();
  });

  it("preserves a saved all-closed week when editing and offers selectable timezone names", async () => {
    panel({ ...unset, configured: true, timezone: "America/Los_Angeles" });
    fireEvent.click(screen.getByRole("button", { name: "Edit hours" }));
    expect(screen.getByLabelText("Monday open")).not.toBeChecked();
    expect(screen.queryByLabelText("Monday opens")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Business hours time zone" })).toHaveValue("America/Los_Angeles");
    expect(screen.getByRole("option", { name: "America / Los Angeles" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].days).toEqual(unset.days);
  });

  it("preserves the editable draft on a failed save and rejects equal opening and closing", async () => {
    save.mockRejectedValueOnce(new Error("Time zone is invalid"));
    panel(configured);
    fireEvent.click(screen.getByRole("button", { name: "Edit hours" }));
    fireEvent.change(screen.getByLabelText("Monday closes"), { target: { value: "09:00" } });
    expect(screen.getByRole("button", { name: "Save hours" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Monday closes"), { target: { value: "18:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Time zone is invalid");
    expect(screen.getByLabelText("Monday closes")).toHaveValue("18:00");
  });

  it("does not report no after-hours activity while camera activity is unavailable", () => {
    panel(configured, { activityError: new Error("Frigate unavailable"), activityCount: 0, outsideCount: 0 });
    expect(screen.getByText(/After-hours activity is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/0 outside business hours/)).not.toBeInTheDocument();
  });
});
