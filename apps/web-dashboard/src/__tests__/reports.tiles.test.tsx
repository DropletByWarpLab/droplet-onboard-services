/**
 * WARP-1993 — behaviour pins for the number strip, Folders and Activity.
 *
 * The theme running through these: an unread value and a zero are different
 * facts, and every tile that blurs them tells the user something false in a
 * place they have no way to check. Most of what's here holds that line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import React from "react";

const fetchAdminFilesUsageMock = vi.fn();
const fetchActivityRangeMock = vi.fn();
const fetchChainVerifyMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchAdminFilesUsage: (...a: unknown[]) => fetchAdminFilesUsageMock(...a),
}));

vi.mock("@/app/reports/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchActivityRange: (...a: unknown[]) => fetchActivityRangeMock(...a),
  fetchChainVerify: (...a: unknown[]) => fetchChainVerifyMock(...a),
}));

import { ActivityBody, ChainChip, FoldersBody, NumberBody } from "@/app/reports/tiles";
import type { HomeTile } from "@/app/reports/api";

const RANGE = { from: "2026-08-14T00:00:00.000Z", to: "2026-08-15T00:00:00.000Z" };

const dept = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "d1",
  name: "Operations",
  kind: "department",
  sizeBytes: "1073741824",
  quotaBytes: "10737418240",
  ...over,
});

const evt = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "1",
  at: "2026-08-14T09:12:00.000Z",
  severity: "ok",
  sourceIcon: "FolderOpen",
  what: "9 files added to Operations",
  sub: "by Samantha",
  kind: "files.write",
  refs: null,
  signature: "s",
  prevSignatureHash: "p",
  actorType: null,
  actorId: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

// ── number strip ─────────────────────────────────────────────────────────

describe("NumberBody (WARP-1993)", () => {
  const tile = (over: Partial<HomeTile> = {}): HomeTile => ({
    count: 1284,
    sub: "1284 files indexed",
    status: "ok",
    ...over,
  });

  it("renders the count and the server's sub-line when the read succeeded", () => {
    render(<NumberBody which="files" tile={tile()} loading={false} failed={false} />);
    expect(screen.getByText("1,284")).toBeTruthy();
    expect(screen.getByText("1284 files indexed")).toBeTruthy();
  });

  it("shows an em-dash, NOT zero, when the subsystem is offline", () => {
    // The lie this prevents: "0 cameras" when the truth is "we couldn't ask".
    render(
      <NumberBody
        which="cameras"
        tile={tile({ status: "offline", count: 0 })}
        loading={false}
        failed={false}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("shows an em-dash for unknown too", () => {
    render(
      <NumberBody which="devices" tile={tile({ status: "unknown" })} loading={false} failed={false} />,
    );
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders a real zero when the read succeeded and the answer IS zero", () => {
    // The mirror of the above: an honest zero must survive.
    render(
      <NumberBody
        which="files"
        tile={tile({ status: "ok", count: 0, sub: "0 files indexed" })}
        loading={false}
        failed={false}
      />,
    );
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("falls back to not-reporting when the whole endpoint failed", () => {
    render(<NumberBody which="network" tile={null} loading={false} failed />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("Not reporting")).toBeTruthy();
  });

  it("carries the status for assistive tech — the dot is never the only signal", () => {
    const { container } = render(
      <NumberBody which="network" tile={tile({ status: "warn" })} loading={false} failed={false} />,
    );
    expect(container.querySelector(".rp-dot.is-warn")).toBeTruthy();
    expect(screen.getByText("status warn")).toBeTruthy();
  });
});

// ── Folders ──────────────────────────────────────────────────────────────

describe("FoldersBody (WARP-1993)", () => {
  it("locks for a non-admin without hinting at the contents", () => {
    render(<FoldersBody canRead={false} />);
    expect(screen.getByText("Your role doesn't include this.")).toBeTruthy();
    expect(fetchAdminFilesUsageMock).not.toHaveBeenCalled();
  });

  it("renders an unlimited quota as a dash with NO bar", async () => {
    // A bar with no ceiling is a meter measuring nothing.
    fetchAdminFilesUsageMock.mockResolvedValue({
      users: [],
      departments: [dept({ quotaBytes: null })],
    });
    const { container } = render(<FoldersBody canRead />);
    await screen.findByText("Operations");
    const row = container.querySelector(".rp-folder")!;
    expect(within(row as HTMLElement).getAllByText("—").length).toBeGreaterThan(0);
    expect(row.querySelector(".rp-bar")).toBeNull();
  });

  it("renders an unreadable size as a dash, never 0 B", async () => {
    fetchAdminFilesUsageMock.mockResolvedValue({
      users: [],
      departments: [dept({ sizeBytes: "—" })],
    });
    const { container } = render(<FoldersBody canRead />);
    await screen.findByText("Operations");
    const row = container.querySelector(".rp-folder") as HTMLElement;
    expect(within(row).queryByText("0 B")).toBeNull();
  });

  it("sorts fullest first — the folder about to hit its quota leads", async () => {
    fetchAdminFilesUsageMock.mockResolvedValue({
      users: [],
      departments: [
        dept({ id: "a", name: "Low", sizeBytes: "1", quotaBytes: "100" }),
        dept({ id: "b", name: "High", sizeBytes: "97", quotaBytes: "100" }),
        dept({ id: "c", name: "Mid", sizeBytes: "50", quotaBytes: "100" }),
      ],
    });
    const { container } = render(<FoldersBody canRead />);
    await screen.findByText("High");
    const names = Array.from(container.querySelectorAll(".rp-folder-title")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["High", "Mid", "Low"]);
  });

  it("sorts ratio-less rows last — they cannot be near a limit they don't have", async () => {
    fetchAdminFilesUsageMock.mockResolvedValue({
      users: [],
      departments: [
        dept({ id: "a", name: "Unlimited", quotaBytes: null }),
        dept({ id: "b", name: "Bounded", sizeBytes: "50", quotaBytes: "100" }),
      ],
    });
    const { container } = render(<FoldersBody canRead />);
    await screen.findByText("Bounded");
    const names = Array.from(container.querySelectorAll(".rp-folder-title")).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(["Bounded", "Unlimited"]);
  });

  it("tones the bar red above 95% and orange in the warn band", async () => {
    fetchAdminFilesUsageMock.mockResolvedValue({
      users: [],
      departments: [
        dept({ id: "a", name: "Over", sizeBytes: "97", quotaBytes: "100" }),
        dept({ id: "b", name: "Warn", sizeBytes: "80", quotaBytes: "100" }),
        dept({ id: "c", name: "Fine", sizeBytes: "10", quotaBytes: "100" }),
      ],
    });
    const { container } = render(<FoldersBody canRead />);
    await screen.findByText("Over");
    expect(container.querySelector(".rp-bar-fill.is-over")).toBeTruthy();
    expect(container.querySelector(".rp-bar-fill.is-warn")).toBeTruthy();
    expect(container.querySelector(".rp-bar-fill.is-ok")).toBeTruthy();
  });

  it("totals the box without letting an unreadable row poison the sum", async () => {
    fetchAdminFilesUsageMock.mockResolvedValue({
      users: [],
      departments: [
        dept({ id: "a", sizeBytes: "1073741824" }),
        dept({ id: "b", name: "Broken", sizeBytes: "—" }),
      ],
    });
    const { container } = render(<FoldersBody canRead />);
    await screen.findByText("Broken");
    // Scoped to the footer: "1.0 GB" also appears in the readable row, and
    // the claim here is specifically about the TOTAL.
    const foot = container.querySelector(".rp-foot")!;
    // 1 GiB from the readable row; the dash contributes nothing, not NaN.
    expect(foot.textContent).toMatch(/2 folders · 1\.0 GB used across the box/);
    expect(container.textContent).not.toMatch(/NaN/);
  });

  it("offers an empty state with a way to act", async () => {
    fetchAdminFilesUsageMock.mockResolvedValue({ users: [], departments: [] });
    render(<FoldersBody canRead />);
    expect(await screen.findByText("No shared folders yet")).toBeTruthy();
    expect(screen.getByText(/Set one up/)).toBeTruthy();
  });

  it("offers retry on failure and re-fetches when pressed", async () => {
    fetchAdminFilesUsageMock.mockRejectedValueOnce(new Error("boom"));
    render(<FoldersBody canRead />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(fetchAdminFilesUsageMock).toHaveBeenCalledTimes(1);

    fetchAdminFilesUsageMock.mockResolvedValue({ users: [], departments: [dept()] });
    fireEvent.click(retry);
    await waitFor(() => expect(fetchAdminFilesUsageMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Operations")).toBeTruthy();
  });
});

// ── Activity ─────────────────────────────────────────────────────────────

describe("ActivityBody (WARP-1993)", () => {
  it("locks for a non-admin and does not call the endpoint", () => {
    render(<ActivityBody range={RANGE} canRead={false} />);
    expect(screen.getByText("Your role doesn't include this.")).toBeTruthy();
    expect(fetchActivityRangeMock).not.toHaveBeenCalled();
  });

  it("renders events with their sub-line", async () => {
    fetchActivityRangeMock.mockResolvedValue({ items: [evt()], nextCursor: null });
    render(<ActivityBody range={RANGE} canRead />);
    expect(await screen.findByText("9 files added to Operations")).toBeTruthy();
    expect(screen.getByText("by Samantha")).toBeTruthy();
  });

  it("passes the half-open range straight through to the endpoint", async () => {
    fetchActivityRangeMock.mockResolvedValue({ items: [], nextCursor: null });
    render(<ActivityBody range={RANGE} canRead />);
    await waitFor(() => expect(fetchActivityRangeMock).toHaveBeenCalled());
    expect(fetchActivityRangeMock.mock.calls[0][0]).toEqual(RANGE);
  });

  it("treats a quiet range as quiet — no icon, no CTA, no alarm", async () => {
    fetchActivityRangeMock.mockResolvedValue({ items: [], nextCursor: null });
    const { container } = render(<ActivityBody range={RANGE} canRead />);
    expect(await screen.findByText("Nothing recorded in this range")).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("says so when there is no range, rather than showing today under another label", async () => {
    render(<ActivityBody range={null} canRead />);
    expect(screen.getByText("Pick a date range to see activity")).toBeTruthy();
    expect(fetchActivityRangeMock).not.toHaveBeenCalled();
  });

  it("caps the rows and links out when there are more", async () => {
    const many = Array.from({ length: 12 }, (_, i) => evt({ id: String(i), what: `Event ${i}` }));
    fetchActivityRangeMock.mockResolvedValue({ items: many, nextCursor: null });
    const { container } = render(<ActivityBody range={RANGE} canRead />);
    await screen.findByText("Event 0");
    expect(container.querySelectorAll(".rp-evt")).toHaveLength(8);
    expect(screen.getByText(/View all 12 events/)).toBeTruthy();
  });

  it("renders an unattributed event rather than the word null", async () => {
    fetchActivityRangeMock.mockResolvedValue({
      items: [evt({ sub: null, actorType: null, actorId: null })],
      nextCursor: null,
    });
    const { container } = render(<ActivityBody range={RANGE} canRead />);
    await screen.findByText("9 files added to Operations");
    expect(container.textContent).not.toMatch(/null/);
  });

  it("falls back to a default icon for an unrecognised sourceIcon", async () => {
    // The server picks icon names; an unknown one must not crash the tile.
    fetchActivityRangeMock.mockResolvedValue({
      items: [evt({ sourceIcon: "SomethingNewFromTheServer" })],
      nextCursor: null,
    });
    render(<ActivityBody range={RANGE} canRead />);
    expect(await screen.findByText("9 files added to Operations")).toBeTruthy();
  });
});

// ── chain chip ───────────────────────────────────────────────────────────

describe("ChainChip (WARP-1993)", () => {
  it("renders verified when the server says the chain is intact", async () => {
    fetchChainVerifyMock.mockResolvedValue({ ok: true, rowsChecked: 412, verifiedAt: "x" });
    render(<ChainChip canRead />);
    expect(await screen.findByText("Chain verified")).toBeTruthy();
  });

  it("renders BROKEN when it is not — the state that actually matters", async () => {
    fetchChainVerifyMock.mockResolvedValue({
      ok: false,
      rowsChecked: 12,
      brokenAtId: "88",
      verifiedAt: "x",
    });
    const { container } = render(<ChainChip canRead />);
    expect(await screen.findByText("Chain broken")).toBeTruthy();
    expect(container.querySelector(".rp-chip.is-broken")).toBeTruthy();
  });

  it("is a fact, not a control — no button, no link", async () => {
    fetchChainVerifyMock.mockResolvedValue({ ok: true, rowsChecked: 1, verifiedAt: "x" });
    const { container } = render(<ChainChip canRead />);
    await screen.findByText("Chain verified");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("shows nothing rather than a false reassurance when verify fails", async () => {
    // A silent chip is honest; a green one that never checked is not.
    fetchChainVerifyMock.mockRejectedValue(new Error("nope"));
    const { container } = render(<ChainChip canRead />);
    await waitFor(() => expect(fetchChainVerifyMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
