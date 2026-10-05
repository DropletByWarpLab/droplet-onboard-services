// The running-timer chip in the Projects header (WARP-3526): nothing while no
// timer runs; while one does, what it is on, how long, and a Stop button.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";
import { TimerChip } from "./TimerChip";
import { createFakeTimeApi, ITEM_1 } from "@/__tests__/helpers/fake-time-api";

const api = vi.hoisted(() => ({
  handler: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock("@/lib/auth", () => ({
  authFetch: (url: string, init?: RequestInit) => api.handler!(url, init),
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

let fake: ReturnType<typeof createFakeTimeApi>;

function renderChip() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TimerChip />
    </SWRConfig>,
  );
}

const running = (startedAt = new Date(Date.now() - 12 * 60_000 - 34_000).toISOString()) => ({
  userId: "u-me",
  workItemId: "w1",
  startedAt,
  workItem: ITEM_1,
});

beforeEach(() => {
  toast.mockReset();
  fake = createFakeTimeApi();
  api.handler = fake.handler;
});

describe("TimerChip", () => {
  it("renders nothing while no timer is running, so a box that never tracks time sees no new control", async () => {
    const { container } = renderChip();
    await waitFor(() => expect(fake.state.calls.some((c) => c.url === "/api/pm/timer")).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows what the timer is on, how long it has run, and a Stop button", async () => {
    fake.state.timer = running();
    renderChip();
    const chip = await screen.findByRole("group", { name: "Timer running on INBOX-1" });
    expect(chip).toHaveTextContent("INBOX-1");
    expect(chip).toHaveTextContent("First task");
    // 12 minutes and a bit have passed since startedAt.
    expect(screen.getByRole("timer")).toHaveTextContent(/^00:12:\d\d$/);
    expect(screen.getByRole("button", { name: "Stop the timer on INBOX-1" })).toBeInTheDocument();
  });

  it("is a status the page owns: the chip brings its own pm scope, since the shell header sits outside the page's", async () => {
    fake.state.timer = running();
    const { container } = renderChip();
    await screen.findByRole("group");
    expect(container.firstElementChild).toHaveClass("pm-scope");
  });

  it("stops the timer, logs the time in a toast and goes away", async () => {
    fake.state.timer = running();
    fake.state.stopMinutes = 13;
    const { container } = renderChip();
    fireEvent.click(await screen.findByRole("button", { name: "Stop the timer on INBOX-1" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Logged 13m on INBOX-1.", "success"));
    expect(fake.state.calls.filter((c) => c.method === "POST" && c.url === "/api/pm/timer/stop")).toHaveLength(1);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("says when a forgotten timer was capped at a day", async () => {
    fake.state.timer = running("2026-09-30T09:00:00.000Z");
    fake.state.stopMinutes = 1440;
    fake.state.stopCapped = true;
    renderChip();
    fireEvent.click(await screen.findByRole("button", { name: /Stop the timer/ }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "The timer ran for more than 24 hours, so 24h was logged on INBOX-1. Edit the entry to correct it.",
        "info",
      ),
    );
  });

  it("keeps the chip, and says why, when the stop fails", async () => {
    fake.state.timer = running();
    fake.state.failures = [{ match: /\/timer\/stop$/, method: "POST", status: 404, error: "timer_not_found" }];
    renderChip();
    fireEvent.click(await screen.findByRole("button", { name: /Stop the timer/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("No timer is running.", "error"));
    expect(screen.getByRole("group")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop the timer/ })).not.toBeDisabled();
  });
});
