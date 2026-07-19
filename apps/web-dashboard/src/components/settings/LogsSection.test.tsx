/**
 * WARP-823 — Settings "Diagnostics" section.
 *
 * Lets an owner/admin download a secret-redacted bundle of the box's service
 * logs for support. Scope:
 *   - a primary "Download logs" action that calls the API and triggers a
 *     browser download of the returned .zip blob,
 *   - an optional time-range select that is passed to the API,
 *   - a loading state on the button while the bundle is being built,
 *   - a friendly error state when the collection fails (never a raw stack),
 *   - sentence-case copy, no emoji.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const downloadLogBundle = vi.fn();
vi.mock("@/lib/api", () => ({
  downloadLogBundle: (...a: unknown[]) => downloadLogBundle(...a),
}));

import { LogsSection } from "./LogsSection";

beforeEach(() => {
  vi.clearAllMocks();
  downloadLogBundle.mockResolvedValue(
    new Blob(["zip-bytes"], { type: "application/zip" }),
  );
  // jsdom has no object-URL / anchor-download plumbing — stub the bits the
  // component uses so the click path doesn't throw.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(
    () => "blob:mock",
  );
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});

describe("LogsSection", () => {
  it("renders the diagnostics section with a download action", () => {
    render(<LogsSection />);
    expect(
      screen.getByRole("button", { name: /download logs/i }),
    ).toBeInTheDocument();
  });

  it("renders the group header via the shell Sect pattern — sentence case, no uppercase eyebrow (WARP-1344)", () => {
    render(<LogsSection />);
    const heading = screen.getByRole("heading", { name: "Diagnostics" });
    expect(heading.className).not.toMatch(/uppercase/);
    expect(heading.closest(".sect")).not.toBeNull();
  });

  it("downloads the bundle when the button is clicked", async () => {
    render(<LogsSection />);
    fireEvent.click(screen.getByRole("button", { name: /download logs/i }));
    await waitFor(() => expect(downloadLogBundle).toHaveBeenCalledTimes(1));
  });

  it("passes the selected time range to the API", async () => {
    render(<LogsSection />);
    // Change the range select to 7 days, then download.
    const select = screen.getByLabelText(/time range/i);
    fireEvent.change(select, { target: { value: "168" } });
    fireEvent.click(screen.getByRole("button", { name: /download logs/i }));
    await waitFor(() => expect(downloadLogBundle).toHaveBeenCalledTimes(1));
    expect(downloadLogBundle).toHaveBeenCalledWith(
      expect.objectContaining({ windowHours: 168 }),
    );
  });

  it("shows a loading state while the bundle is being prepared", async () => {
    let resolve!: (b: Blob) => void;
    downloadLogBundle.mockReturnValue(
      new Promise<Blob>((r) => {
        resolve = r;
      }),
    );
    render(<LogsSection />);
    fireEvent.click(screen.getByRole("button", { name: /download logs/i }));
    // While pending, the button reflects progress + is disabled.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /preparing|download/i }),
      ).toBeDisabled(),
    );
    resolve(new Blob(["z"], { type: "application/zip" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /download logs/i }),
      ).not.toBeDisabled(),
    );
  });

  it("shows a friendly error and never echoes the raw failure", async () => {
    const RAW = "ECONNREFUSED device-bridge stack trace at line 42";
    downloadLogBundle.mockRejectedValueOnce(new Error(RAW));
    render(<LogsSection />);
    fireEvent.click(screen.getByRole("button", { name: /download logs/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/couldn't|could not|try again|unavailable/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(RAW)).not.toBeInTheDocument();
  });

  it("uses sentence case and no emoji in the visible copy", () => {
    const { container } = render(<LogsSection />);
    const text = container.textContent ?? "";
    // No emoji anywhere in the section.
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false);
  });
});
