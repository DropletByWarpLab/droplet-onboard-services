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
const fetchIntegrationsMock = vi.fn();
const fetchArSummaryMock = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchAdminFilesUsage: (...a: unknown[]) => fetchAdminFilesUsageMock(...a),
}));

vi.mock("@/app/reports/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchActivityRange: (...a: unknown[]) => fetchActivityRangeMock(...a),
  fetchChainVerify: (...a: unknown[]) => fetchChainVerifyMock(...a),
  fetchIntegrations: (...a: unknown[]) => fetchIntegrationsMock(...a),
  fetchArSummary: (...a: unknown[]) => fetchArSummaryMock(...a),
}));

import {
  ActivityBody,
  ChainChip,
  FoldersBody,
  IntegrationsBody,
  MoneyBody,
  NumberBody,
} from "@/app/reports/tiles";
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

// ── Money ────────────────────────────────────────────────────────────────

describe("MoneyBody (WARP-1995)", () => {
  const NOW = new Date("2026-08-14T09:41:00.000Z");

  beforeEach(() => {
    fetchIntegrationsMock.mockResolvedValue([]);
  });

  it("renders the balance and the account count when connected", async () => {
    fetchArSummaryMock.mockResolvedValue({
      connected: true,
      totalBalance: 48213.55,
      accountCount: 132,
    });
    render(<MoneyBody canRead now={NOW} />);
    expect(await screen.findByText("$48,213.55")).toBeTruthy();
    expect(screen.getByText("132")).toBeTruthy();
  });

  it("renders a REAL zero as $0.00, not as an empty state", async () => {
    // Zero owed is a real answer and a good one. Swapping it for
    // "not connected" would hide a fact the practice cares about.
    fetchArSummaryMock.mockResolvedValue({
      connected: true,
      totalBalance: 0,
      accountCount: 0,
    });
    render(<MoneyBody canRead now={NOW} />);
    expect(await screen.findByText("$0.00")).toBeTruthy();
    expect(screen.queryByText("No practice system connected")).toBeNull();
  });

  it("renders not-connected when the summary says so — nulls are not zero", async () => {
    // The mirror of the above. `null` means we don't know; rendering it as
    // $0.00 would be a fabricated figure.
    fetchArSummaryMock.mockResolvedValue({
      connected: false,
      reason: "ERP_NOT_CONNECTED",
      totalBalance: null,
      accountCount: null,
    });
    render(<MoneyBody canRead now={NOW} />);
    expect(await screen.findByText("No practice system connected")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("distinguishes a capability gap from a missing connector (WARP-2135)", async () => {
    // The defect: `connected: true` + DATASET_NOT_SERVED fell through to the
    // not-connected copy, so a healthy connected practice system was reported
    // as absent and the owner was sent to browse connectors for a problem
    // they did not have.
    fetchArSummaryMock.mockResolvedValue({
      connected: true,
      reason: "DATASET_NOT_SERVED",
      totalBalance: null,
      accountCount: null,
    });
    render(<MoneyBody canRead now={NOW} />);
    expect(
      await screen.findByText(/doesn't provide money owed to you/i),
    ).toBeTruthy();
    expect(screen.queryByText("No practice system connected")).toBeNull();
    // Still no fabricated figure — a gap is not a zero.
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("drops the 'browse connectors' CTA from the half that IS connected", async () => {
    // The call to action has to match the diagnosis: there is nothing to
    // connect for receivables, so that link would send the owner somewhere
    // useless. Counted, not asserted-absent: the "Paid out" half ships
    // permanently not-connected (brief §9.1) and keeps its own CTA, so the
    // contract is "one link, from the other half" — not "no links".
    fetchArSummaryMock.mockResolvedValue({
      connected: true,
      reason: "DATASET_NOT_SERVED",
      totalBalance: null,
      accountCount: null,
    });
    render(<MoneyBody canRead now={NOW} />);
    await screen.findByText(/doesn't provide money owed to you/i);
    expect(screen.getAllByText(/Browse connectors/i)).toHaveLength(1);
  });

  it("keeps both CTAs when nothing is connected at all", async () => {
    // Guards the count above from passing for the wrong reason: with no
    // connector, BOTH halves legitimately invite the owner to add one.
    fetchArSummaryMock.mockResolvedValue({
      connected: false,
      reason: "ERP_NOT_CONNECTED",
      totalBalance: null,
      accountCount: null,
    });
    render(<MoneyBody canRead now={NOW} />);
    await screen.findByText("No practice system connected");
    expect(screen.getAllByText(/Browse connectors/i)).toHaveLength(2);
  });

  it("locks on a 403 — the connector-grant case", async () => {
    const { ForbiddenError } = await import("@/app/reports/api");
    fetchArSummaryMock.mockRejectedValue(new ForbiddenError());
    render(<MoneyBody canRead now={NOW} />);
    expect(await screen.findByText("Your role doesn't include this.")).toBeTruthy();
  });

  it("locks for a role below the PHI floor without calling the endpoint", () => {
    render(<MoneyBody canRead={false} now={NOW} />);
    expect(screen.getByText("Your role doesn't include this.")).toBeTruthy();
    expect(fetchArSummaryMock).not.toHaveBeenCalled();
  });

  it("greys a stale figure but never hides it", async () => {
    fetchArSummaryMock.mockResolvedValue({
      connected: true,
      totalBalance: 48213.55,
      accountCount: 132,
    });
    fetchIntegrationsMock.mockResolvedValue([
      { provider: "eaglesoft-api", status: "CONNECTED", configured: true, writeEnabled: false, lastSyncedAt: "2026-08-14T03:12:00.000Z" },
    ]);
    const { container } = render(<MoneyBody canRead now={NOW} />);
    const fig = await screen.findByText("$48,213.55");
    // Shown AND marked — a figure the user can see and distrust beats one
    // silently withheld.
    await waitFor(() => expect(container.querySelector(".rp-money-fig.is-stale")).toBeTruthy());
    expect(fig).toBeTruthy();
  });

  it("ALWAYS ships the paid-out half not-connected — there is no source", async () => {
    // Brief §9.1: no accounts-payable, expense, payroll or accounting
    // connector exists anywhere in the registry.
    fetchArSummaryMock.mockResolvedValue({
      connected: true,
      totalBalance: 48213.55,
      accountCount: 132,
    });
    render(<MoneyBody canRead now={NOW} />);
    await screen.findByText("$48,213.55");
    expect(screen.getByText("No accounting system connected")).toBeTruthy();
    expect(screen.getByText("Connect one to see money going out.")).toBeTruthy();
  });

  it("renders exactly one currency figure — the out half can never be populated", async () => {
    fetchArSummaryMock.mockResolvedValue({
      connected: true,
      totalBalance: 48213.55,
      accountCount: 132,
    });
    const { container } = render(<MoneyBody canRead now={NOW} />);
    await screen.findByText("$48,213.55");
    expect(container.querySelectorAll(".rp-money-fig")).toHaveLength(1);
  });

  it("spells the figure out for assistive tech", async () => {
    fetchArSummaryMock.mockResolvedValue({
      connected: true,
      totalBalance: 48213.55,
      accountCount: 132,
    });
    render(<MoneyBody canRead now={NOW} />);
    expect(await screen.findByLabelText(/owed to you/i)).toBeTruthy();
  });
});

// ── Integrations ─────────────────────────────────────────────────────────

describe("IntegrationsBody (WARP-1994)", () => {
  const NOW = new Date("2026-08-14T09:41:00.000Z");
  const conn = (over: Partial<Record<string, unknown>> = {}) => ({
    provider: "eaglesoft-api",
    status: "CONNECTED",
    configured: true,
    writeEnabled: false,
    lastSyncedAt: "2026-08-14T09:39:00.000Z",
    ...over,
  });

  it("sorts problems first — the broken one is never buried", async () => {
    fetchIntegrationsMock.mockResolvedValue([
      conn({ provider: "a-connected", status: "CONNECTED" }),
      conn({ provider: "b-disabled", status: "DISABLED" }),
      conn({ provider: "c-error", status: "ERROR" }),
      conn({ provider: "d-degraded", status: "DEGRADED" }),
    ]);
    const { container } = render(<IntegrationsBody now={NOW} />);
    await screen.findByText("Can't connect");
    const marks = Array.from(container.querySelectorAll(".rp-conn")).map((r) =>
      r.querySelector(".rp-pill")?.textContent,
    );
    expect(marks[0]).toBe("Can't connect");
    expect(marks[1]).toBe("Needs attention");
  });

  it("renders all seven statuses without collapsing any", async () => {
    const all = [
      "CONNECTED",
      "DEGRADED",
      "DRIFT_LOCKED",
      "ERROR",
      "PROVISIONING",
      "DISABLED",
      "NOT_CONFIGURED",
    ];
    fetchIntegrationsMock.mockResolvedValue(
      all.map((s, i) => conn({ provider: `p${i}`, status: s })),
    );
    const { container } = render(<IntegrationsBody now={NOW} />);
    await screen.findByText("Connected");
    const labels = Array.from(container.querySelectorAll(".rp-pill")).map((p) => p.textContent);
    expect(new Set(labels).size).toBe(7);
  });

  it("shows the writes chip ONLY when writes are enabled", async () => {
    fetchIntegrationsMock.mockResolvedValue([
      conn({ provider: "reader", writeEnabled: false }),
      conn({ provider: "writer", writeEnabled: true }),
    ]);
    render(<IntegrationsBody now={NOW} />);
    // Read-only is the norm and gets no chip — absence is the quiet default.
    expect(await screen.findAllByText("Writes on")).toHaveLength(1);
  });

  it("renders the three connector tracks distinguishably", async () => {
    fetchIntegrationsMock.mockResolvedValue([
      conn({ provider: "eaglesoft" }),
      conn({ provider: "eaglesoft-api" }),
      conn({ provider: "eaglesoft-export" }),
    ]);
    render(<IntegrationsBody now={NOW} />);
    expect(await screen.findByText("Eaglesoft (direct SQL)")).toBeTruthy();
    expect(screen.getByText("Eaglesoft API")).toBeTruthy();
    expect(screen.getByText("Eaglesoft (export)")).toBeTruthy();
  });

  it("never claims a sync for a connector that has none", async () => {
    fetchIntegrationsMock.mockResolvedValue([
      conn({ provider: "eaglesoft", status: "NOT_CONFIGURED", lastSyncedAt: null }),
    ]);
    const { container } = render(<IntegrationsBody now={NOW} />);
    await screen.findByText("Not connected");
    expect(container.textContent).toMatch(/Never connected/);
    expect(container.textContent).not.toMatch(/Synced/);
  });

  it("holds the sub-line blank until the client clock exists", async () => {
    // SSR has no clock; rendering a relative time there would hydrate
    // against a different value.
    fetchIntegrationsMock.mockResolvedValue([conn()]);
    const { container } = render(<IntegrationsBody now={null} />);
    await screen.findByText("Eaglesoft API");
    expect(container.querySelector(".rp-conn-sub")?.textContent?.trim()).toBe("");
  });

  it("offers an empty state with a way to act", async () => {
    fetchIntegrationsMock.mockResolvedValue([]);
    render(<IntegrationsBody now={NOW} />);
    expect(await screen.findByText("Nothing connected yet")).toBeTruthy();
    expect(screen.getByText(/Connect a system/)).toBeTruthy();
  });

  it("offers retry on failure and re-fetches when pressed", async () => {
    fetchIntegrationsMock.mockRejectedValueOnce(new Error("boom"));
    render(<IntegrationsBody now={NOW} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    fetchIntegrationsMock.mockResolvedValue([conn()]);
    fireEvent.click(retry);
    await waitFor(() => expect(fetchIntegrationsMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Eaglesoft API")).toBeTruthy();
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
