/**
 * WARP-3904 — "what's connected" as a card. It reads only: its two actions send
 * an ordinary user turn ("Reconnect Stripe", "Connect Stripe") and it never
 * holds a credential, opens a form or calls the box.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  CONNECTION_STATUSES,
  CONNECTION_STATUS_LABEL,
  parseConnectionsOverview,
  type ConnectionsOverview,
} from "@droplet/shared-types";

const authFetch = vi.fn();
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  authFetch: (...a: unknown[]) => authFetch(...a),
}));

import { ConnectionsOverviewCard, MAX_AVAILABLE_PILLS } from "./ConnectionsOverviewCard";

afterEach(() => {
  cleanup();
  authFetch.mockReset();
});

type RawRow = Record<string, unknown>;

function row(over: RawRow = {}): RawRow {
  return {
    id: "integration:stripe",
    family: "integration",
    provider: "stripe",
    displayName: "Stripe",
    detail: "acct_1A2B",
    scope: "box",
    status: "connected",
    capabilities: ["payouts", "charges"],
    manageHref: "/integrations",
    canDisconnect: true,
    canReconnect: false,
    ...over,
  };
}

function available(i: number, over: RawRow = {}): RawRow {
  return { provider: `provider-${i}`, family: "integration", displayName: `Provider ${i}`, scope: "box", canConnect: true, ...over };
}

/** Built through the real parser, so a fixture can not drift from the contract. */
function overview(connected: RawRow[], avail: RawRow[] = []): ConnectionsOverview {
  const parsed = parseConnectionsOverview({ kind: "connections_overview", connected, available: avail, boxWideVisible: true });
  if (!parsed) throw new Error("fixture is not a valid overview");
  return parsed;
}

function setup(o: ConnectionsOverview) {
  const onOutcome = vi.fn();
  const utils = render(<ConnectionsOverviewCard overview={o} onOutcome={onOutcome} />);
  return { onOutcome, ...utils };
}

describe("ConnectionsOverviewCard — counts and rows", () => {
  it("summarises connected, needs-attention and available in one line", () => {
    setup(
      overview(
        [
          row({ id: "integration:stripe" }),
          row({ id: "google:google", family: "google", provider: "google", displayName: "Google", scope: "personal" }),
          row({ id: "mailbox:1", family: "mailbox", provider: "mailbox", displayName: "Front desk", status: "needs_attention" }),
          row({ id: "calendar:1", family: "calendar", provider: "calendar", displayName: "Holidays", status: "pending" }),
        ],
        [available(1), available(2), available(3)],
      ),
    );
    expect(screen.getByTestId("connections-counts")).toHaveTextContent("2 connected · 1 needs attention · 3 available");
  });

  it.each(CONNECTION_STATUSES)("labels a %s row with its own status word", (status) => {
    setup(overview([row({ status })]));
    const item = screen.getByTestId("connection-row");
    expect(item).toHaveAttribute("data-status", status);
    expect(within(item).getByText(CONNECTION_STATUS_LABEL[status])).toBeInTheDocument();
  });

  it("names the row, links it to where it is managed, and shows what it reads", () => {
    setup(overview([row({ manageHref: "/integrations", statusDetail: undefined })]));
    const item = screen.getByTestId("connection-row");
    expect(within(item).getByRole("link", { name: "Stripe" })).toHaveAttribute("href", "/integrations");
    expect(item).toHaveTextContent("acct_1A2B · payouts, charges · box-wide");
  });

  it("marks a personal row as the person's own and shows the status detail line", () => {
    setup(
      overview([
        row({
          id: "google:google",
          family: "google",
          provider: "google",
          displayName: "Google",
          detail: undefined,
          capabilities: ["mail", "calendar"],
          scope: "personal",
          status: "needs_attention",
          statusDetail: "Sign in again to keep reading mail.",
          canReconnect: true,
        }),
      ]),
    );
    const item = screen.getByTestId("connection-row");
    expect(item).toHaveTextContent("mail, calendar · your account");
    expect(item).toHaveTextContent("Sign in again to keep reading mail.");
  });

  it("says so when nothing is connected, and omits the Available section when nothing is", () => {
    setup(overview([], []));
    expect(screen.getByText("Nothing is connected yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Connected" })).toBeNull();
    expect(screen.queryByText("Available to connect")).toBeNull();
    expect(screen.getByTestId("connections-counts")).toHaveTextContent("0 connected · 0 needs attention · 0 available");
  });

  it("always offers the way into the Integrations hub", () => {
    setup(overview([row()]));
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute("href", "/integrations");
  });
});

describe("ConnectionsOverviewCard — Reconnect", () => {
  const rows = [
    row({ id: "google:google", family: "google", provider: "google", displayName: "Google", scope: "personal", status: "needs_attention", canReconnect: true }),
    row({ id: "integration:xero", provider: "xero", displayName: "Xero", status: "needs_attention", canReconnect: false }),
    row({ id: "integration:stripe", provider: "stripe", displayName: "Stripe", status: "connected", canReconnect: false }),
  ];

  it("shows a Reconnect button only where canReconnect is true", () => {
    setup(overview(rows));
    const buttons = screen.getAllByRole("button", { name: "Reconnect" });
    expect(buttons).toHaveLength(1);
    const owner = buttons[0].closest("[data-testid='connection-row']") as HTMLElement;
    expect(owner).toHaveAttribute("data-provider", "google");
  });

  it("sends the ordinary turn 'Reconnect <Name>' once per click, and nothing else", () => {
    const { onOutcome } = setup(overview(rows));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith("Reconnect Google");
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe("ConnectionsOverviewCard — Available to connect", () => {
  it("sends 'Connect <Name>' when a pill is clicked", () => {
    const { onOutcome } = setup(overview([], [available(1, { displayName: "Stripe", provider: "stripe" })]));
    fireEvent.click(screen.getByRole("button", { name: "Stripe" }));
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith("Connect Stripe");
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("renders a pill disabled, with the reason, when the person's role cannot connect it", () => {
    const { onOutcome } = setup(overview([], [available(1, { displayName: "Eaglesoft", provider: "eaglesoft", canConnect: false })]));
    const pill = screen.getByRole("button", { name: "Eaglesoft" });
    expect(pill).toBeDisabled();
    expect(pill).toHaveAttribute("title", "Ask an owner or admin to connect this.");
    fireEvent.click(pill);
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("keeps an enabled pill free of the tooltip", () => {
    setup(overview([], [available(1)]));
    const pill = screen.getByRole("button", { name: "Provider 1" });
    expect(pill).toBeEnabled();
    expect(pill).not.toHaveAttribute("title");
  });

  it(`shows ${MAX_AVAILABLE_PILLS} pills and an "n more" link to the hub when there are more`, () => {
    const many = Array.from({ length: 12 }, (_, i) => available(i + 1));
    setup(overview([], many));
    expect(screen.getAllByRole("button", { name: /^Provider \d+$/ })).toHaveLength(MAX_AVAILABLE_PILLS);
    expect(screen.getByRole("link", { name: "3 more" })).toHaveAttribute("href", "/integrations");
    expect(screen.queryByRole("button", { name: "Provider 10" })).toBeNull();
  });

  it("has no 'more' link when everything fits", () => {
    const exact = Array.from({ length: MAX_AVAILABLE_PILLS }, (_, i) => available(i + 1));
    setup(overview([], exact));
    expect(screen.getAllByRole("button", { name: /^Provider \d+$/ })).toHaveLength(MAX_AVAILABLE_PILLS);
    expect(screen.queryByRole("link", { name: /more$/ })).toBeNull();
  });
});

describe("ConnectionsOverviewCard — it only reads", () => {
  it("renders no inputs and never touches the network", () => {
    const { container } = setup(overview([row(), row({ id: "google:google", family: "google", provider: "google", displayName: "Google", canReconnect: true })], [available(1)]));
    expect(container.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("uses sentence case with no exclamation marks and no emoji", () => {
    const { container } = setup(overview([row({ status: "needs_attention", canReconnect: true })], [available(1)]));
    const text = container.textContent ?? "";
    expect(text).not.toContain("!");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("names the card for assistive technology", () => {
    setup(overview([row()]));
    expect(screen.getByRole("region", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Connected" })).toBeInTheDocument();
  });
});
