/**
 * WARP-3504 (ADR-068) — /settings/telemetry page tests: "What this Droplet
 * sends to Warp".
 *
 * Contract under test:
 *   1. owner and admin see the status, what is sent (with every field), what
 *      is never sent, retention and the reason, and the LAST payload of each
 *      kind exactly as it was sent;
 *   2. anyone else is gated, in the nav and on the page, and the page never
 *      asks the box for the payloads;
 *   3. each link state has its own plain-language state, and a failed load is
 *      a red error, never a blank that could read as "nothing is sent";
 *   4. there is no switch on the page;
 *   5. business language: never the `family` / `household` wire values.
 *
 * ShellPage is mocked to a passthrough and `authFetch` routes on the URL; a
 * fresh SWR cache per render keeps cases independent. No network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {children}
    </div>
  ),
}));

const authFetch = vi.fn();
const userRef: { current: { role: string } } = { current: { role: "owner" } };
const authState = { isLoading: false };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: userRef.current, isLoading: authState.isLoading }),
  authFetch: (...a: unknown[]) => authFetch(...a),
}));

import TelemetryPage from "./page";
import { settingsGroups } from "@/components/nav-config";

const HEARTBEAT = {
  schema: "heartbeat.v1",
  sentAt: "2026-10-03T12:00:00.000Z",
  release: { tag: "ota-stage-12-gabc1234", gitSha: "a".repeat(40), channel: "stage" },
  usage: { cpuPct: 12, memPct: 49, diskPct: 61 },
  activity: { windowSec: 300, chatTurns: 4, agentRuns: 1, activeUsers: 2 },
};
const EVENTS = { schema: "events.v1", events: [{ type: "boot", at: "2026-10-03T11:55:00.000Z" }] };

function last(overrides: Record<string, unknown> = {}) {
  return {
    state: "ok",
    portalHost: "portal.test",
    heartbeatIntervalSec: 300,
    lastAttemptAt: new Date(Date.now() - 120_000).toISOString(),
    lastSuccessAt: new Date(Date.now() - 120_000).toISOString(),
    lastErrorCode: null,
    queued: { heartbeat: 0, events: 0, logs: 0 },
    dropped: 0,
    last: {
      heartbeat: { sentAt: new Date(Date.now() - 120_000).toISOString(), payload: HEARTBEAT },
      events: { sentAt: new Date(Date.now() - 3_600_000).toISOString(), payload: EVENTS },
      logs: null,
    },
    schemas: [
      {
        schema: "heartbeat.v1",
        endpoint: "/api/v1/telemetry/heartbeat",
        summary: "A health snapshot, sent every 5 minutes.",
        fields: [{ path: "release.tag / gitSha / channel", meaning: "The software release this Droplet runs" }],
      },
      {
        schema: "events.v1",
        endpoint: "/api/v1/telemetry/events",
        summary: "Short notices, sent within a minute of happening.",
        fields: [{ path: "events[].type", meaning: "What happened, from a fixed list" }],
      },
      {
        schema: "logs.v1",
        endpoint: "/api/v1/telemetry/logs",
        summary: "Warnings and errors, cleaned on this Droplet before they leave.",
        fields: [{ path: "records[].code", meaning: "A stable error code or class" }],
      },
    ],
    neverSent: ["Anything people type to the assistant, or anything it answers", "File names, folder paths or file contents"],
    retention: { rawDays: 30, dailySummaryMonths: 13 },
    ...overrides,
  };
}

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function serve(body: unknown, status = 200) {
  authFetch.mockImplementation(async (url: string) =>
    url === "/api/telemetry/last" ? res(body, status) : res({ error: "not_found" }, 404),
  );
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TelemetryPage />
    </SWRConfig>,
  );
}

beforeEach(() => {
  authFetch.mockReset();
  userRef.current = { role: "owner" };
  authState.isLoading = false;
});

describe("owner and admin", () => {
  it.each(["owner", "admin"])("%s sees what is sent, what never is, retention, and the last payloads", async (role) => {
    userRef.current = { role };
    serve(last());
    renderPage();

    expect(await screen.findByRole("heading", { name: "What this Droplet sends to Warp" })).toBeInTheDocument();
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    expect(screen.getByText(/Reports go to portal\.test/)).toBeInTheDocument();
    expect(screen.getByText(/Last report accepted 2 minutes ago/)).toBeInTheDocument();

    // What is sent: the three kinds, with their descriptions and every field.
    for (const name of ["Health snapshot", "Events", "Warnings and errors"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("A health snapshot, sent every 5 minutes.")).toBeInTheDocument();
    expect(screen.getByText("release.tag / gitSha / channel")).toBeInTheDocument();
    expect(screen.getByText("The software release this Droplet runs")).toBeInTheDocument();

    // What is never sent, and how long Warp keeps it.
    expect(screen.getByRole("heading", { name: "What is never sent" })).toBeInTheDocument();
    expect(screen.getByText("File names, folder paths or file contents")).toBeInTheDocument();
    expect(screen.getByText(/keeps the reports themselves for 30 days/)).toBeInTheDocument();
    expect(screen.getByText(/daily summary per Droplet for 13 months/)).toBeInTheDocument();
    expect(screen.getByText(/to know that your Droplet is up/i)).toBeInTheDocument();
  });

  it("shows the last payload exactly as it was sent, pretty-printed", async () => {
    serve(last());
    renderPage();
    const block = await screen.findByLabelText("Health snapshot, as sent");
    expect(block.textContent).toContain('"schema": "heartbeat.v1"');
    expect(block.textContent).toBe(JSON.stringify(HEARTBEAT, null, 2));
    expect(JSON.parse(block.textContent ?? "")).toEqual(HEARTBEAT);
    expect(JSON.parse(screen.getByLabelText("Events, as sent").textContent ?? "")).toEqual(EVENTS);
  });

  it("says plainly when a kind has not been accepted yet, instead of showing nothing", async () => {
    serve(last());
    renderPage();
    await screen.findByLabelText("Health snapshot, as sent");
    expect(screen.queryByLabelText("Warnings and errors, as sent")).toBeNull();
    expect(screen.getByText("Nothing of this kind has been accepted by Warp yet.")).toBeInTheDocument();
  });

  it("has no switch: sending is part of the lease", async () => {
    serve(last());
    renderPage();
    await screen.findByText("Sending");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/no switch for it here/i)).toBeInTheDocument();
  });

  it("uses business language: never the family or household wire values", async () => {
    serve(last());
    const { container } = renderPage();
    await screen.findByText("Sending");
    expect(container.textContent ?? "").not.toMatch(/household|family/i);
  });
});

describe("everyone else is gated", () => {
  it.each(["family", "guest"])("%s gets the access-required state, and the page never asks the box", (role) => {
    userRef.current = { role };
    renderPage();
    expect(screen.getByText("Owner or admin access required")).toBeInTheDocument();
    expect(screen.queryByText("Sending")).toBeNull();
    expect(screen.queryByLabelText(/as sent/)).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("an unknown viewer is gated too", () => {
    userRef.current = { role: "" };
    renderPage();
    expect(screen.getByText("Owner or admin access required")).toBeInTheDocument();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("while the session is still loading it shows neutral chrome and asks nothing", () => {
    authState.isLoading = true;
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("Owner or admin access required")).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("is offered in the Settings nav to owner and admin only", () => {
    const rows = (role: "owner" | "admin" | "family" | "guest") =>
      settingsGroups(role, { claudeActivity: true, ragEval: true, medicalConnector: true }, () => true).flatMap((g) =>
        g.items.map((i) => [g.label, i.href]),
      );
    expect(rows("owner")).toContainEqual(["System", "/settings/telemetry"]);
    expect(rows("admin")).toContainEqual(["System", "/settings/telemetry"]);
    expect(rows("family").map(([, href]) => href)).not.toContain("/settings/telemetry");
    expect(rows("guest").map(([, href]) => href)).not.toContain("/settings/telemetry");
  });
});

describe("each state is its own", () => {
  it("not enrolled", async () => {
    serve(last({ state: "not_enrolled", lastSuccessAt: null, last: { heartbeat: null, events: null, logs: null } }));
    renderPage();
    expect(await screen.findByText("Not connected to Warp")).toBeInTheDocument();
    expect(screen.getByText(/isn.t registered with Warp yet, so nothing is sent/)).toBeInTheDocument();
    expect(screen.queryByText("Sending")).toBeNull();
    expect(screen.getAllByText("Nothing of this kind has been accepted by Warp yet.")).toHaveLength(3);
  });

  it("revoked", async () => {
    serve(last({ state: "revoked" }));
    renderPage();
    expect(await screen.findByText("Warp access ended")).toBeInTheDocument();
  });

  it("unreachable: what is waiting, what was dropped, and the short reason", async () => {
    serve(
      last({
        state: "retrying",
        lastErrorCode: "portal_503",
        queued: { heartbeat: 2, events: 1, logs: 0 },
        dropped: 3,
      }),
    );
    renderPage();
    expect(await screen.findByText("Can't reach Warp right now")).toBeInTheDocument();
    expect(screen.getByText(/3 reports are waiting to be sent/)).toBeInTheDocument();
    expect(screen.getByText(/3 older reports were dropped/)).toBeInTheDocument();
    expect(screen.getByText("Reason: portal_503")).toBeInTheDocument();
  });

  it("off or not configured: nothing is said about where reports go", async () => {
    serve(last({ state: "disabled", portalHost: null, lastSuccessAt: null }));
    renderPage();
    expect(await screen.findByText("Off on this Droplet")).toBeInTheDocument();
    expect(screen.queryByText(/Reports go to/)).toBeNull();
  });
});

describe("a failed load", () => {
  it("is an explicit red error with a retry, never a blank", async () => {
    authFetch.mockResolvedValue(res({ error: "boom" }, 500));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/couldn.t load this page/i)).toBeInTheDocument();
    expect(alert).toHaveTextContent(/not a report that nothing is being sent/i);
    expect(screen.queryByText("Sending")).toBeNull();

    authFetch.mockImplementation(async () => res(last()));
    fireEvent.click(within(alert).getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(authFetch.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("a 403 from the box (the role changed meanwhile) is shown the same way", async () => {
    authFetch.mockResolvedValue(res({ error: "Forbidden: role not permitted" }, 403));
    renderPage();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
