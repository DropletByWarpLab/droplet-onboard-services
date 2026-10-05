/**
 * WARP-3532 — Settings → Integrations → Work notifications.
 *
 * Claims worth the most:
 *  1. The admin gate precedes the fetch effects: a member gets nothing AND the
 *     page issues no admin-only request on their behalf.
 *  2. The signing secret is on screen only in the "shown once" box, and is gone
 *     when that box is dismissed; the address's path is never shown.
 *  3. Every state teaches: loading, empty, failed, blocked-by-egress, turned off.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";

const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

const api = vi.hoisted(() => ({
  fetchWorkWebhooks: vi.fn(),
  createWorkWebhook: vi.fn(),
  updateWorkWebhook: vi.fn(),
  deleteWorkWebhook: vi.fn(),
  rotateWorkWebhookSecret: vi.fn(),
  testWorkWebhook: vi.fn(),
  fetchWorkWebhookDeliveries: vi.fn(),
  redeliverWorkWebhook: vi.fn(),
  fetchWebhookScopeProjects: vi.fn(),
}));
vi.mock("@/lib/api.work-webhooks", () => api);

const channel = vi.hoisted(() => ({ fetchWorkIntegrationsChannel: vi.fn(), setWorkIntegrationsChannel: vi.fn() }));
vi.mock("@/lib/api", () => channel);

import { WorkNotificationsSection } from "../WorkNotificationsSection";
import { EGRESS_BLOCKED_ERROR, EMPTY_STATE } from "../work-notifications-copy";
import type { WorkWebhook, WorkWebhookDelivery } from "@/lib/api.work-webhooks";

const T0 = "2026-10-04T12:00:00.000Z";

const EVENTS = [
  { name: "work_item.created", label: "Created", description: "A work item is created." },
  { name: "work_item.state_changed", label: "Moved to another state", description: "A work item moves." },
  { name: "work_item.updated", label: "Changed", description: "Anything else changes." },
];

function hook(over: Partial<WorkWebhook> = {}): WorkWebhook {
  return {
    id: "hook-1",
    workspaceId: "ws-1",
    projectId: null,
    name: "Team chat",
    destination: "https://hooks.chat.test",
    format: "SLACK",
    events: ["work_item.created", "work_item.state_changed"],
    enabled: true,
    status: "ACTIVE",
    consecutiveFailures: 0,
    createdAt: T0,
    updatedAt: T0,
    lastDelivery: null,
    ...over,
  };
}

function delivery(over: Partial<WorkWebhookDelivery> = {}): WorkWebhookDelivery {
  return {
    id: "d-1", event: "work_item.created", status: "DELIVERED", attempts: 1, nextAttemptAt: T0,
    lastStatusCode: 200, lastError: null, createdAt: T0, deliveredAt: T0, subject: "ENG-1 · Fix login",
    ...over,
  };
}

const asRole = (role: string) => useAuthMock.mockReturnValue({ user: { id: "u1", role } });

beforeEach(() => {
  vi.clearAllMocks();
  asRole("owner");
  api.fetchWorkWebhooks.mockResolvedValue({ webhooks: [hook()], events: EVENTS });
  api.fetchWebhookScopeProjects.mockResolvedValue([]);
  api.fetchWorkWebhookDeliveries.mockResolvedValue({ deliveries: [], nextCursor: null });
  channel.fetchWorkIntegrationsChannel.mockResolvedValue({ enabled: false });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe("the owner/admin gate", () => {
  it.each(["family", "guest", "member", undefined])("%s: renders nothing and issues no admin-only request", async (role) => {
    useAuthMock.mockReturnValue({ user: role ? { id: "u1", role } : null });
    const { container } = render(<WorkNotificationsSection />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    expect(api.fetchWorkWebhooks).not.toHaveBeenCalled();
    expect(api.fetchWebhookScopeProjects).not.toHaveBeenCalled();
    expect(channel.fetchWorkIntegrationsChannel).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("%s: sees the page", async (role) => {
    asRole(role);
    render(<WorkNotificationsSection />);
    expect(await screen.findByText("Team chat")).toBeTruthy();
  });
});

// ── states ───────────────────────────────────────────────────────────────────

describe("states", () => {
  it("says it is loading", () => {
    api.fetchWorkWebhooks.mockReturnValue(new Promise(() => undefined));
    render(<WorkNotificationsSection />);
    expect(screen.getByText("Loading webhooks…")).toBeTruthy();
  });

  it("teaches the model when there are none, and offers the way in", async () => {
    api.fetchWorkWebhooks.mockResolvedValue({ webhooks: [], events: EVENTS });
    render(<WorkNotificationsSection />);
    expect(await screen.findByText(EMPTY_STATE)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add a webhook/ })).toBeTruthy();
  });

  it("says it could not load — not 'no webhooks' — and can try again", async () => {
    api.fetchWorkWebhooks.mockRejectedValueOnce(new Error("down"));
    render(<WorkNotificationsSection />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Team chat")).toBeTruthy();
  });

  it("shows the destination and the events in words, never the address's path", async () => {
    render(<WorkNotificationsSection />);
    await screen.findByText("Team chat");
    expect(screen.getByText(/Slack · https:\/\/hooks\.chat\.test · Every project/)).toBeTruthy();
    expect(screen.getByText("Created, Moved to another state")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/whsec_|\/services\//);
  });

  it("names a webhook the box turned off, says why, and offers to resume it", async () => {
    api.fetchWorkWebhooks.mockResolvedValue({
      webhooks: [hook({ status: "DISABLED_FAILING", enabled: false, consecutiveFailures: 20 })],
      events: EVENTS,
    });
    render(<WorkNotificationsSection />);
    expect(await screen.findByText("Turned off after repeated failures")).toBeTruthy();
    expect(screen.getByText(/couldn’t reach this address 20 times in a row/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resume/ })).toBeTruthy();
  });

  it("names the project a scoped webhook is limited to", async () => {
    api.fetchWebhookScopeProjects.mockResolvedValue([{ id: "p-1", name: "Engineering", identifier: "ENG" }]);
    api.fetchWorkWebhooks.mockResolvedValue({ webhooks: [hook({ projectId: "p-1" })], events: EVENTS });
    render(<WorkNotificationsSection />);
    expect(await screen.findByText(/· Engineering$/)).toBeTruthy();
  });
});

// ── adding ───────────────────────────────────────────────────────────────────

async function openCreate() {
  render(<WorkNotificationsSection />);
  await screen.findByText("Team chat");
  fireEvent.click(screen.getByRole("button", { name: /Add a webhook/ }));
  return screen.getByRole("form", { name: "Add a webhook" });
}

describe("adding a webhook", () => {
  it("uses the preset: the name follows the format until the person edits it, and the help line follows too", async () => {
    const form = await openCreate();
    const name = within(form).getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Slack");
    fireEvent.click(within(form).getByLabelText("Microsoft Teams"));
    expect(name.value).toBe("Teams");
    expect(within(form).getByText(/Workflows webhook/)).toBeTruthy();
    fireEvent.change(name, { target: { value: "Ops room" } });
    fireEvent.click(within(form).getByLabelText("Discord"));
    expect(name.value).toBe("Ops room");
  });

  it("creates it, then shows the secret once, with the reason, and drops it when dismissed", async () => {
    api.createWorkWebhook.mockResolvedValue({
      webhook: hook({ id: "hook-2", name: "Ops room", format: "DISCORD" }),
      secret: "whsec_shown-exactly-once",
    });
    const form = await openCreate();
    fireEvent.click(within(form).getByLabelText("Discord"));
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Ops room" } });
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "https://chat.test/api/hook/abc" } });
    fireEvent.click(within(form).getByLabelText(/^Changed/)); // deselect one event
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));

    await waitFor(() => expect(api.createWorkWebhook).toHaveBeenCalledTimes(1));
    expect(api.createWorkWebhook).toHaveBeenCalledWith({
      name: "Ops room",
      url: "https://chat.test/api/hook/abc",
      format: "DISCORD",
      events: ["work_item.created", "work_item.state_changed"],
      projectId: null,
    });

    const reveal = await screen.findByTestId("secret-reveal");
    expect((within(reveal).getByLabelText("Signing secret") as HTMLInputElement).value).toBe("whsec_shown-exactly-once");
    expect(within(reveal).getByText(/only time Droplet shows this secret/)).toBeTruthy();
    // The form is gone and the new webhook is in the list.
    expect(screen.queryByRole("form", { name: "Add a webhook" })).toBeNull();
    expect(screen.getByText("Ops room")).toBeTruthy();

    fireEvent.click(within(reveal).getByRole("button", { name: "I’ve saved it" }));
    expect(screen.queryByTestId("secret-reveal")).toBeNull();
    expect(document.body.textContent).not.toContain("whsec_shown-exactly-once");
  });

  it("copies the secret", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    api.createWorkWebhook.mockResolvedValue({ webhook: hook({ id: "hook-2" }), secret: "whsec_copy-me" });
    const form = await openCreate();
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "https://chat.test/x" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    const reveal = await screen.findByTestId("secret-reveal");
    fireEvent.click(within(reveal).getByRole("button", { name: /Copy secret/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("whsec_copy-me"));
    expect(await within(reveal).findByText("Copied")).toBeTruthy();
  });

  it("narrows to one project when there are projects to pick from", async () => {
    api.fetchWebhookScopeProjects.mockResolvedValue([{ id: "p-1", name: "Engineering", identifier: "ENG" }]);
    api.createWorkWebhook.mockResolvedValue({ webhook: hook({ id: "hook-2" }), secret: "whsec_x" });
    render(<WorkNotificationsSection />);
    await screen.findByText("Team chat");
    await waitFor(() => expect(api.fetchWebhookScopeProjects).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Add a webhook/ }));
    const form = await screen.findByRole("form", { name: "Add a webhook" });
    fireEvent.change(await within(form).findByLabelText("Which work"), { target: { value: "p-1" } });
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "https://chat.test/x" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    await waitFor(() => expect(api.createWorkWebhook).toHaveBeenCalled());
    expect(api.createWorkWebhook.mock.calls[0]![0]).toMatchObject({ projectId: "p-1" });
  });

  it.each([
    ["no name", (f: HTMLElement) => fireEvent.change(within(f).getByLabelText("Name"), { target: { value: " " } }), "Give this webhook a name."],
    ["no address", () => undefined, "Paste the address to send to."],
  ])("refuses %s before asking the box", async (_label, act, message) => {
    const form = await openCreate();
    act(form);
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(message);
    expect(api.createWorkWebhook).not.toHaveBeenCalled();
  });

  it("refuses a webhook with no events", async () => {
    const form = await openCreate();
    for (const label of [/^Created/, /^Moved to another state/, /^Changed/]) fireEvent.click(within(form).getByLabelText(label));
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "https://chat.test/x" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("Pick at least one event.");
  });

  it("shows the box's own sentence when it refuses the address, and keeps the form open", async () => {
    api.createWorkWebhook.mockRejectedValue(new Error("That address can't be used. A webhook can reach other devices on your network or the internet, but not this Droplet itself."));
    const form = await openCreate();
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "http://127.0.0.1/x" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add webhook" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/can't be used/);
    expect(screen.getByRole("form", { name: "Add a webhook" })).toBeTruthy();
    expect((within(form).getByLabelText("Address") as HTMLInputElement).value).toBe("http://127.0.0.1/x");
    expect(screen.queryByTestId("secret-reveal")).toBeNull();
  });

  it("cancels without sending anything", async () => {
    const form = await openCreate();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Add a webhook" })).toBeNull();
    expect(api.createWorkWebhook).not.toHaveBeenCalled();
  });
});

// ── the card ─────────────────────────────────────────────────────────────────

async function card() {
  render(<WorkNotificationsSection />);
  return within(await screen.findByTestId("webhook-hook-1"));
}

describe("send test", () => {
  it("says it arrived", async () => {
    api.testWorkWebhook.mockResolvedValue({ delivery: delivery({ event: "webhook.test", lastStatusCode: 204 }) });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /Send test/ }));
    expect(await c.findByText("Delivered. The receiver answered 204.")).toBeTruthy();
  });

  it("says why it did not, and points at the egress switch when that is why", async () => {
    api.testWorkWebhook.mockResolvedValue({
      delivery: delivery({ event: "webhook.test", status: "GIVEN_UP", lastStatusCode: null, lastError: EGRESS_BLOCKED_ERROR }),
    });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /Send test/ }));
    expect(await c.findByText("Didn’t arrive: Blocked by egress setting.")).toBeTruthy();
    expect(c.getByText(/Turn on “Send work updates outside your network”/)).toBeTruthy();
  });

  it("reports a receiver that refused it, with its answer", async () => {
    api.testWorkWebhook.mockResolvedValue({
      delivery: delivery({ event: "webhook.test", status: "GIVEN_UP", lastStatusCode: 404, lastError: "HTTP 404" }),
    });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /Send test/ }));
    expect(await c.findByText("Didn’t arrive: HTTP 404.")).toBeTruthy();
  });

  it("says so when the request itself fails", async () => {
    api.testWorkWebhook.mockRejectedValue(new Error("That didn’t work (500). Try again in a moment."));
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /Send test/ }));
    expect((await c.findByRole("alert")).textContent).toMatch(/didn’t work/);
  });
});

describe("pause, resume, edit", () => {
  it("pauses, then resumes, through the box", async () => {
    api.updateWorkWebhook.mockResolvedValueOnce({ webhook: hook({ enabled: false, status: "PAUSED" }) });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /Pause/ }));
    expect(await c.findByText("Paused")).toBeTruthy();
    expect(api.updateWorkWebhook).toHaveBeenCalledWith("hook-1", { enabled: false });

    api.updateWorkWebhook.mockResolvedValueOnce({ webhook: hook() });
    fireEvent.click(c.getByRole("button", { name: /Resume/ }));
    expect(await c.findByText("Active")).toBeTruthy();
    expect(api.updateWorkWebhook).toHaveBeenLastCalledWith("hook-1", { enabled: true });
  });

  it("edits without ever showing the address on file, and leaves it alone when no new one is typed", async () => {
    api.updateWorkWebhook.mockResolvedValue({ webhook: hook({ name: "Renamed" }) });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /Edit/ }));
    const form = screen.getByRole("form", { name: "Edit webhook" });
    const address = within(form).getByLabelText("Address") as HTMLInputElement;
    expect(address.value).toBe("");
    expect(address.placeholder).toBe("Leave empty to keep the current address");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateWorkWebhook).toHaveBeenCalledTimes(1));
    const [, patch] = api.updateWorkWebhook.mock.calls[0]!;
    expect(patch).toMatchObject({ name: "Renamed", format: "SLACK", projectId: null });
    expect(patch).not.toHaveProperty("url");
    expect(await screen.findByText("Renamed")).toBeTruthy();
  });

  it("sends a new address only when one is typed", async () => {
    api.updateWorkWebhook.mockResolvedValue({ webhook: hook() });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /Edit/ }));
    const form = screen.getByRole("form", { name: "Edit webhook" });
    fireEvent.change(within(form).getByLabelText("Address"), { target: { value: "https://other.test/x" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateWorkWebhook).toHaveBeenCalled());
    expect(api.updateWorkWebhook.mock.calls[0]![1]).toMatchObject({ url: "https://other.test/x" });
  });
});

describe("rotate the secret", () => {
  it("asks first, says what it costs, then shows the new secret once", async () => {
    api.rotateWorkWebhookSecret.mockResolvedValue({ webhook: hook(), secret: "whsec_rotated" });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /New secret/ }));
    expect(c.getByText(/The old one stops working straight away/)).toBeTruthy();
    expect(api.rotateWorkWebhookSecret).not.toHaveBeenCalled();
    fireEvent.click(c.getByRole("button", { name: "Make a new secret" }));
    const reveal = await screen.findByTestId("secret-reveal");
    expect((within(reveal).getByLabelText("Signing secret") as HTMLInputElement).value).toBe("whsec_rotated");
    expect(c.queryByText(/stops working straight away/)).toBeNull();
  });

  it("can be backed out of", async () => {
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /New secret/ }));
    fireEvent.click(c.getByRole("button", { name: "Keep the old one" }));
    expect(api.rotateWorkWebhookSecret).not.toHaveBeenCalled();
    expect(c.queryByText(/stops working straight away/)).toBeNull();
  });
});

describe("delete", () => {
  it("asks first, names the consequence, then removes it", async () => {
    api.deleteWorkWebhook.mockResolvedValue(undefined);
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /^Delete$/ }));
    expect(c.getByText(/Its delivery log goes with it/)).toBeTruthy();
    expect(api.deleteWorkWebhook).not.toHaveBeenCalled();
    fireEvent.click(within(c.getByRole("group", { name: "Delete Team chat" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteWorkWebhook).toHaveBeenCalledWith("hook-1"));
    await waitFor(() => expect(screen.queryByText("Team chat")).toBeNull());
    expect(screen.getByText(EMPTY_STATE)).toBeTruthy();
  });

  it("keeps it when asked to", async () => {
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(c.getByRole("button", { name: "Keep it" }));
    expect(api.deleteWorkWebhook).not.toHaveBeenCalled();
    expect(screen.getByText("Team chat")).toBeTruthy();
  });
});

describe("the delivery log", () => {
  it("opens on demand, and says what an empty one means", async () => {
    const c = await card();
    expect(api.fetchWorkWebhookDeliveries).not.toHaveBeenCalled();
    fireEvent.click(c.getByRole("button", { name: "Delivery log" }));
    expect(await c.findByText(/Nothing has been sent yet/)).toBeTruthy();
    expect(api.fetchWorkWebhookDeliveries).toHaveBeenCalledWith("hook-1", undefined);
  });

  it("lists each delivery with its status and the response, and what a blocked one is waiting for", async () => {
    api.fetchWorkWebhookDeliveries.mockResolvedValue({
      deliveries: [
        delivery({ id: "d-1", status: "DELIVERED", lastStatusCode: 200 }),
        delivery({ id: "d-2", status: "FAILED", attempts: 2, lastStatusCode: 500, lastError: "HTTP 500", subject: "ENG-2 · Other" }),
        delivery({ id: "d-3", status: "PENDING", attempts: 0, lastStatusCode: null, lastError: EGRESS_BLOCKED_ERROR, subject: "ENG-3 · Third" }),
        delivery({ id: "d-4", status: "GIVEN_UP", attempts: 8, lastStatusCode: null, lastError: "Timed out", subject: "ENG-4 · Fourth" }),
      ],
      nextCursor: null,
    });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: "Delivery log" }));
    const log = within(await c.findByTestId("log-hook-1"));
    expect(log.getByText("Delivered")).toBeTruthy();
    expect(log.getByText("Retrying")).toBeTruthy();
    expect(log.getByText("Waiting")).toBeTruthy();
    expect(log.getByText("Gave up")).toBeTruthy();
    expect(log.getByText("Answered 200")).toBeTruthy();
    expect(log.getByText("HTTP 500")).toBeTruthy();
    expect(log.getByText("Blocked by egress setting")).toBeTruthy();
    expect(log.getByText("Timed out")).toBeTruthy();
    expect(log.getByText(/Turn on “Send work updates outside your network”/)).toBeTruthy();
    expect(log.getAllByText(/Created ·/).length).toBeGreaterThan(0); // event label, then subject
  });

  it("queues a delivery again and reloads", async () => {
    api.fetchWorkWebhookDeliveries.mockResolvedValue({
      deliveries: [delivery({ status: "GIVEN_UP", lastError: "Timed out", lastStatusCode: null })],
      nextCursor: null,
    });
    api.redeliverWorkWebhook.mockResolvedValue({ delivery: delivery({ id: "d-9", status: "PENDING" }) });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: "Delivery log" }));
    fireEvent.click(await c.findByRole("button", { name: /Send ENG-1 · Fix login again/ }));
    await waitFor(() => expect(api.redeliverWorkWebhook).toHaveBeenCalledWith("hook-1", "d-1"));
    await waitFor(() => expect(api.fetchWorkWebhookDeliveries.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("pages older rows in on request", async () => {
    api.fetchWorkWebhookDeliveries
      .mockResolvedValueOnce({ deliveries: [delivery({ id: "d-1" })], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ deliveries: [delivery({ id: "d-0", subject: "ENG-0 · Older" })], nextCursor: null });
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: "Delivery log" }));
    fireEvent.click(await c.findByRole("button", { name: "Show older" }));
    expect(await c.findByText(/ENG-0 · Older/)).toBeTruthy();
    expect(api.fetchWorkWebhookDeliveries).toHaveBeenLastCalledWith("hook-1", "cursor-1");
    expect(c.getByText(/ENG-1 · Fix login/)).toBeTruthy();
    expect(c.queryByRole("button", { name: "Show older" })).toBeNull();
  });

  it("says when the log could not be loaded", async () => {
    api.fetchWorkWebhookDeliveries.mockRejectedValue(new Error("down"));
    const c = await card();
    fireEvent.click(c.getByRole("button", { name: "Delivery log" }));
    expect((await c.findByRole("alert")).textContent).toBe("Couldn’t load the delivery log.");
  });
});
