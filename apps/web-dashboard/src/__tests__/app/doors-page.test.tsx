/**
 * ADR-055 P4b — /doors, wired: the page, the real hooks, and the API helpers
 * mocked one layer below them.
 *
 * The presentational pieces are pinned in components/doors/*.test.tsx; this is
 * what only the page can show — the two reads and the writes meeting the hooks,
 * the owner/admin split reaching the controls, cursor paging end to end, and the
 * page's own answer when the box refuses the read (Doors off, or above the
 * person's role), which must be the standard "isn't available" card and never a
 * Retry that cannot help.
 *
 * States: owner, admin, empty, error, and not available.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

const h = vi.hoisted(() => ({
  role: "owner" as string,
  toast: vi.fn(),
  getDoors: vi.fn(),
  getDoorEvents: vi.fn(),
  createDoor: vi.fn(),
  patchDoor: vi.fn(),
  retireDoor: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => {
    const ReactLib = require("react");
    return ReactLib.createElement("a", { href, ...props }, children);
  },
}));
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: { title?: string; sub?: string; children: ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p data-testid="page-sub">{sub}</p> : null}
      {children}
    </div>
  ),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: h.role } }), authFetch: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getDoors: h.getDoors,
  getDoorEvents: h.getDoorEvents,
  createDoor: h.createDoor,
  patchDoor: h.patchDoor,
  retireDoor: h.retireDoor,
}));

import DoorsPage from "@/app/doors/page";
import { COPY } from "@/components/doors/door-copy";
import type { DoorEventView, DoorView } from "@/lib/types";

function Wrap({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}
const renderPage = () => render(<DoorsPage />, { wrapper: Wrap });

const apiError = (status: number) => Object.assign(new Error(`raw server text ${status}`), { status });

function door(over: Partial<DoorView> = {}): DoorView {
  return {
    id: "d1",
    name: "Front door",
    doorPositionSource: "lock",
    heldOpenSeconds: 30,
    status: "active",
    retiredAt: null,
    position: "closed",
    positionSince: "2026-09-29T18:02:00.000Z",
    claims: { forcedDoor: "latch_witnessed", heldOpen: true },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}
function event(id: string, over: Partial<DoorEventView> = {}): DoorEventView {
  return {
    id,
    doorId: "d1",
    doorName: "Front door",
    kind: "door_open",
    occurredAt: "2026-09-29T18:02:00.000Z",
    forcedClaim: null,
    troubleCode: null,
    derivedFromId: null,
    correlationKey: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "owner";
  h.getDoors.mockResolvedValue({ doors: [door(), door({ id: "d2", name: "Back door", doorPositionSource: "none", position: "not_monitored", positionSince: null })] });
  h.getDoorEvents.mockResolvedValue({ events: [event("2"), event("1", { kind: "door_closed" })], nextCursor: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/doors — owner", () => {
  it("is titled Doors, says nothing here locks or unlocks a door, and lists the doors and their activity", async () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Doors" })).toBeInTheDocument();
    expect(screen.getByTestId("page-sub")).toHaveTextContent(/Nothing here locks or unlocks a door/);
    expect(await screen.findByRole("heading", { level: 3, name: "Front door" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Back door" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: COPY.listTitle })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: COPY.activityTitle })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId("door-events")).getAllByRole("listitem")).toHaveLength(2));
    expect(h.getDoors).toHaveBeenCalledWith({ includeRetired: true });
  });

  it("sees Add, Change and Retire", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 3, name: "Front door" });
    expect(screen.getByRole("button", { name: COPY.add })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: COPY.edit })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: COPY.retire })).toHaveLength(2);
  });

  it("adds a door through the hook: the write goes out, and the list is read again", async () => {
    h.createDoor.mockResolvedValue({ door: door({ id: "d3", name: "Side door" }) });
    renderPage();
    await screen.findByRole("heading", { level: 3, name: "Front door" });
    const reads = h.getDoors.mock.calls.length;
    h.getDoors.mockResolvedValue({ doors: [door(), door({ id: "d3", name: "Side door" })] });
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const form = within(await screen.findByRole("dialog"));
    fireEvent.change(form.getByLabelText(COPY.nameLabel), { target: { value: "Side door" } });
    fireEvent.click(form.getByRole("radio", { name: /the lock/i }));
    fireEvent.click(form.getByRole("button", { name: COPY.addConfirm }));
    await waitFor(() => expect(h.createDoor).toHaveBeenCalledWith({ name: "Side door", doorPositionSource: "lock" }));
    await waitFor(() => expect(h.getDoors.mock.calls.length).toBeGreaterThan(reads));
    expect(await screen.findByRole("heading", { level: 3, name: "Side door" })).toBeInTheDocument();
    expect(h.toast).toHaveBeenCalledWith("Added Side door.", "success");
  });

  it("a 403 on a write is the friendly toast, and the page keeps standing", async () => {
    h.retireDoor.mockRejectedValue(apiError(403));
    renderPage();
    const card = (await screen.findByRole("heading", { level: 3, name: "Front door" })).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: COPY.retire }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: COPY.retireConfirm }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Only the owner can add, change or retire doors.", "error"));
    await waitFor(() => expect(screen.queryByRole("button", { name: COPY.add })).toBeNull());
    expect(screen.getByRole("heading", { level: 3, name: "Front door" })).toBeInTheDocument();
    expect(screen.queryByTestId("doors-not-available")).toBeNull();
  });
});

describe("/doors — admin", () => {
  it("reads everything and is offered no way to change a door", async () => {
    h.role = "admin";
    renderPage();
    expect(await screen.findByRole("heading", { level: 3, name: "Front door" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Back door" })).toBeInTheDocument();
    for (const name of [COPY.add, COPY.edit, COPY.retire]) expect(screen.queryByRole("button", { name })).toBeNull();
    await waitFor(() => expect(within(screen.getByTestId("door-events")).getAllByRole("listitem")).toHaveLength(2));
  });
});

describe("/doors — empty", () => {
  it("no doors and no activity: two honest empty states, neither reading as a quiet night", async () => {
    h.getDoors.mockResolvedValue({ doors: [] });
    h.getDoorEvents.mockResolvedValue({ events: [], nextCursor: null });
    renderPage();
    expect(await screen.findByText(COPY.emptyTitle)).toBeInTheDocument();
    expect(await screen.findByText(COPY.emptyEventsTitle)).toBeInTheDocument();
    expect(screen.getByText(COPY.emptyEventsBody)).toHaveTextContent(/doesn't mean nothing happened/);
  });
});

describe("/doors — error", () => {
  it("both reads down: each says so, neither shows an empty list, and the page is not the not-available card", async () => {
    h.getDoors.mockRejectedValue(apiError(503));
    h.getDoorEvents.mockRejectedValue(apiError(503));
    renderPage();
    expect(await screen.findByText(COPY.loadFailedTitle)).toBeInTheDocument();
    expect(await screen.findByText(COPY.eventsFailedTitle)).toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText(COPY.emptyTitle)).toBeNull();
    expect(screen.queryByText(COPY.emptyEventsTitle)).toBeNull();
    expect(screen.queryByTestId("doors-not-available")).toBeNull();
  });

  it("the retry re-reads the doors", async () => {
    h.getDoors.mockRejectedValueOnce(apiError(503));
    renderPage();
    const title = await screen.findByText(COPY.loadFailedTitle);
    fireEvent.click(within(title.closest("[role='alert']") as HTMLElement).getByRole("button", { name: COPY.retryLabel }));
    expect(await screen.findByRole("heading", { level: 3, name: "Front door" })).toBeInTheDocument();
  });
});

describe("/doors — not available", () => {
  it.each([
    ["404 (Doors off for this box or this person)", 404],
    ["403 (above this person's role)", 403],
  ])("a read the box refuses with %s shows the standard card and nothing else", async (_name, status) => {
    h.getDoors.mockRejectedValue(apiError(status));
    h.getDoorEvents.mockRejectedValue(apiError(status));
    renderPage();
    const card = await screen.findByTestId("doors-not-available");
    expect(within(card).getByRole("heading", { name: COPY.notAvailableTitle })).toBeInTheDocument();
    expect(within(card).getByText(COPY.notAvailableBody)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /overview/i })).toHaveAttribute("href", "/");
    expect(screen.queryByTestId("door-events")).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.add })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.retryLabel })).toBeNull();
  });

  it("uses the route guard's own words: one wording", () => {
    expect(COPY.notAvailableBody).toBe(
      "This feature is switched off for this Droplet, or it isn't part of your access. An owner or admin can turn it on.",
    );
    expect(COPY.notAvailableTitle).toBe("Doors isn't available");
  });
});

describe("/doors — paging the activity", () => {
  it("Show older asks for the page after the cursor the box gave, and appends it", async () => {
    // Keyed on the cursor, because the first page is re-read while the second loads.
    h.getDoorEvents.mockImplementation(async ({ cursor }: { cursor: string | null }) =>
      cursor === "1790000000000_2"
        ? { events: [event("1", { kind: "door_closed" })], nextCursor: null }
        : { events: [event("3"), event("2")], nextCursor: "1790000000000_2" },
    );
    renderPage();
    const log = await screen.findByTestId("door-events");
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(2));
    fireEvent.click(within(log).getByRole("button", { name: COPY.moreEvents }));
    await waitFor(() => expect(within(log).getAllByRole("listitem")).toHaveLength(3));
    expect(h.getDoorEvents).toHaveBeenCalledWith({ cursor: "1790000000000_2" });
    expect(within(log).queryByRole("button", { name: COPY.moreEvents })).toBeNull();
  });
});
