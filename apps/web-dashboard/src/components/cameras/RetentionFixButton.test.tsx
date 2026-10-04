/**
 * WARP-3511 — the "Fix" for a camera that is not saving footage.
 *
 * The repair behind it is box-wide and restarts the camera service, so the
 * contract is: check first, say exactly which cameras it will touch, and never
 * run it for a camera it cannot help (one switched off on purpose).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({
  plan: vi.fn(),
  run: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchRetentionBackfillPlan: (...a: unknown[]) => h.plan(...a),
  runRetentionBackfill: (...a: unknown[]) => h.run(...a),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: h.toast, dismissAll: vi.fn() }),
}));

import { RetentionFixButton } from "./RetentionFixButton";
import { CamerasUnavailableError } from "@/lib/files-unavailable";

const cameras = [
  { name: "front_door", displayName: "Front door" },
  { name: "garage", displayName: "Garage" },
];

// Deliberately unlike any shipped default: any figure in the dialog that is not
// one of these was written into the copy.
const DEFAULTS = { continuousDays: 13, motionDays: 17, alertsRetainDays: 23, detectionsRetainDays: 29 };

const entry = (camera: string, willWrite: boolean) => ({
  camera,
  willWrite,
  reason: willWrite ? ("no_retention_authored" as const) : ("already_authored" as const),
});

function renderFix(onDone = vi.fn()) {
  render(<RetentionFixButton cameraName="front_door" cameras={cameras} onDone={onDone} />);
  return { onDone };
}

const clickFix = () => fireEvent.click(screen.getByRole("button", { name: /^Fix: start saving footage for Front door$/ }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("when the repair can help this camera", () => {
  it("asks first, naming every camera it will touch, and says it restarts the service", async () => {
    h.plan.mockResolvedValue({ plan: [entry("front_door", true), entry("garage", true)], defaults: DEFAULTS });
    renderFix();

    clickFix();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Front door, Garage");
    expect(dialog.textContent).toMatch(/restarts the camera service/);
    expect(dialog.textContent).toContain("Write · confirm to apply");
    // Nothing has been written yet.
    expect(h.run).not.toHaveBeenCalled();
  });

  it("states what it will keep using the BOX's figures, so the person knows what they are agreeing to", async () => {
    h.plan.mockResolvedValue({ plan: [entry("front_door", true)], defaults: DEFAULTS });
    renderFix();
    clickFix();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "24/7 footage: 13 days · Motion footage: 17 days · Alert clips: 23 days · Other detections: 29 days",
    );
  });

  it("never writes a retention figure into the copy itself: every day count is the box's", async () => {
    h.plan.mockResolvedValue({ plan: [entry("front_door", true)], defaults: DEFAULTS });
    renderFix();
    clickFix();
    const dialog = await screen.findByRole("dialog");
    const counts = [...(dialog.textContent ?? "").matchAll(/(\d+(?:\.\d+)?)\s+days?/g)].map((m) => Number(m[1]));
    expect(counts.length).toBeGreaterThan(0);
    for (const n of counts) expect([13, 17, 23, 29]).toContain(n);
  });

  it("says no figure at all when the box reported none — it does not guess", async () => {
    h.plan.mockResolvedValue({ plan: [entry("front_door", true)], defaults: undefined });
    renderFix();
    clickFix();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toMatch(/\d+\s*days?/i);
    expect(dialog.textContent).toMatch(/starts saving footage/);
  });

  it("applies it on confirm, tells the household, and lets the page refresh", async () => {
    h.plan.mockResolvedValue({ plan: [entry("front_door", true)], defaults: DEFAULTS });
    h.run.mockResolvedValue({ planned: [], written: ["front_door"], noop: false });
    const { onDone } = renderFix();

    clickFix();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));

    await waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(h.toast).toHaveBeenCalledWith("Recording settings updated for 1 camera. The camera service is restarting.", "success");
  });

  it("cancelling changes nothing", async () => {
    h.plan.mockResolvedValue({ plan: [entry("front_door", true)], defaults: DEFAULTS });
    renderFix();
    clickFix();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.run).not.toHaveBeenCalled();
  });

  it("a failed repair is said, and the dialog stays so it can be tried again", async () => {
    h.plan.mockResolvedValue({ plan: [entry("front_door", true)], defaults: DEFAULTS });
    h.run.mockRejectedValue(new Error("The camera service refused the change (400)"));
    const { onDone } = renderFix();

    clickFix();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));

    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith("The camera service refused the change (400)", "error"),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("when the repair cannot help this camera", () => {
  it("a camera switched off on purpose is pointed at Settings — the box is NOT restarted for nothing", async () => {
    h.plan.mockResolvedValue({ plan: [entry("front_door", false), entry("garage", true)], defaults: DEFAULTS });
    renderFix();

    clickFix();

    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    expect(h.toast.mock.calls[0][0]).toMatch(/on purpose/);
    expect(h.toast.mock.calls[0][0]).toMatch(/Settings/);
    expect(h.toast.mock.calls[0][1]).toBe("info");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.run).not.toHaveBeenCalled();
  });

  it("a camera missing from the plan is treated the same", async () => {
    h.plan.mockResolvedValue({ plan: [entry("garage", true)], defaults: DEFAULTS });
    renderFix();
    clickFix();
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.run).not.toHaveBeenCalled();
  });
});

describe("when the check itself fails", () => {
  it("says why and opens nothing", async () => {
    h.plan.mockRejectedValue(new Error("Forbidden"));
    renderFix();
    clickFix();
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Forbidden", "error"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an unreachable camera service gets plain words, not a status code", async () => {
    h.plan.mockRejectedValue(new CamerasUnavailableError());
    renderFix();
    clickFix();
    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith("The camera service isn't responding. Try again in a moment.", "error"),
    );
  });
});

describe("the button", () => {
  it("is disabled while it checks, so a second click cannot start a second check", async () => {
    let release: (v: unknown) => void = () => {};
    h.plan.mockReturnValue(new Promise((r) => (release = r)));
    renderFix();
    clickFix();
    expect((screen.getByRole("button", { name: /^Fix:/ }) as HTMLButtonElement).disabled).toBe(true);
    release({ plan: [entry("front_door", false)], defaults: DEFAULTS });
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    expect(h.plan).toHaveBeenCalledTimes(1);
  });
});
