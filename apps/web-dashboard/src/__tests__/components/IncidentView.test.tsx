/**
 * WARP-2978 (ADR-059 P3 §8, P6 §6.7) — /security/incidents/:id.
 *
 * What the page must hold:
 *   · reasons first ("Why Droplet flagged this"), then the events, who was
 *     told and the acknowledgement history — each exactly as the box sent it
 *     for this viewer (DS-005): a section with nothing in it is absent;
 *   · Acknowledge and Resolve… render only at act — the module level (which
 *     fails closed) AND the box's own `viewer.level` — and only while the
 *     incident is open or acknowledged; Acknowledge also only while this
 *     person hasn't (D23);
 *   · an in-flight button is aria-disabled, never `disabled`: it keeps focus,
 *     a second press is refused, and when it goes away focus lands somewhere
 *     sensible;
 *   · a failure is `translateError(err, "security")`, never the server's
 *     message, then a re-read;
 *   · Acknowledge carries the notification the page was opened from.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act as rtlAct, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { IncidentView, COPY } from "@/components/security/IncidentView";
import { INCIDENT_COPY } from "@/components/security/incident-copy";
import type { IncidentDetail, IncidentMemberView, SecurityModeView } from "@/lib/types";

const h = vi.hoisted(() => ({
  level: "act" as "none" | "view" | "act" | "manage",
  toast: vi.fn(),
  getSecurityIncident: vi.fn(),
  acknowledgeSecurityIncident: vi.fn(),
  resolveSecurityIncident: vi.fn(),
  getSecurityMode: vi.fn(),
  fetchCameras: vi.fn(),
}));

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});
vi.mock("@/lib/hooks/useModuleGate", async (orig) => ({
  ...(await orig<typeof import("@/lib/hooks/useModuleGate")>()),
  useModuleLevel: (moduleId: string) => (moduleId === "security" ? h.level : "none"),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/lib/security-time", async (orig) => ({
  ...(await orig<typeof import("@/lib/security-time")>()),
  deviceTimeZone: () => "Europe/London",
}));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getSecurityIncident: h.getSecurityIncident,
  acknowledgeSecurityIncident: h.acknowledgeSecurityIncident,
  resolveSecurityIncident: h.resolveSecurityIncident,
  getSecurityMode: h.getSecurityMode,
  fetchCameras: h.fetchCameras,
}));

const ID = "7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f";
const NOW = new Date("2026-09-23T01:31:00Z");
const at = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`;

function member(over: Partial<IncidentMemberView> = {}): IncidentMemberView {
  return {
    id: "901",
    source: "frigate",
    kind: "detection",
    severity: "info",
    camera: "back_cam",
    labels: ["person"],
    cameraZones: ["aisle"],
    score: 0.91,
    startedAt: at("01:14"),
    endedAt: at("01:15"),
    summary: "Person in aisle",
    frigateEventId: "1727140000.1-person",
    alsoIn: [],
    ...over,
  };
}

function detail(over: Partial<IncidentDetail> = {}): IncidentDetail {
  return {
    id: ID,
    scope: "area",
    zone: { id: "z1", name: "Stock room", kind: "restricted" },
    camera: null,
    state: "open",
    severity: "alert",
    reasonCodes: ["after_hours_presence"],
    grouping: "closed",
    openedInMode: "closed",
    firstActivityAt: at("01:14"),
    lastActivityAt: at("01:20"),
    eventCount: 1,
    labels: { person: 1 },
    lastAck: null,
    reasons: [
      {
        code: "after_hours_presence",
        severity: "alert",
        evidence: { eventId: "901", camera: "back_cam", source: "frigate", kind: "detection", label: "person", at: at("01:14"), summary: "Person in aisle" },
        detail: { mode: "closed", modeSource: "schedule", nonOpenAt: at("01:14"), zoneKind: "restricted" },
      },
    ],
    events: [member()],
    moreEvents: false,
    acks: [],
    notices: [],
    eventsKept: "kept",
    actionable: true,
    viewer: { level: "act", acknowledged: false },
    ...over,
  };
}

const MODE = { displayTimezone: "Europe/London" } as SecurityModeView;

function typedError(code: string, status: number): Error {
  return Object.assign(new Error(`raw server text for ${code}`), { code, status });
}

function Wrap({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function renderView(props: { notificationId?: string | null } = {}) {
  return render(<IncidentView id={ID} notificationId={props.notificationId ?? null} now={NOW} />, { wrapper: Wrap });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.level = "act";
  h.getSecurityIncident.mockResolvedValue(detail());
  h.getSecurityMode.mockResolvedValue(MODE);
  h.fetchCameras.mockResolvedValue([{ name: "back_cam", displayName: "Back camera" }]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the page's order and content", () => {
  it("title, span, the mode it opened in and the state; reasons come before events", async () => {
    renderView();
    expect(await screen.findByRole("heading", { level: 1, name: "Stock room" })).toBeInTheDocument();
    expect(screen.getByText("2:14 AM – 2:20 AM · The site was closed")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toHaveClass("badge", "danger");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent);
    expect(headings.indexOf(COPY.whyTitle)).toBeGreaterThanOrEqual(0);
    expect(headings.indexOf(COPY.whyTitle)).toBeLessThan(headings.indexOf(COPY.whatTitle));
    expect(screen.getByText("Someone was seen inside while the site was closed")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Person · Back camera · 2:14 AM · Closed (opening hours)")).toBeInTheDocument());
  });

  it("each event: thumbnail, Clip, and the other areas it was also in", async () => {
    h.getSecurityIncident.mockResolvedValue(detail({ events: [member({ alsoIn: [{ id: "z2", name: "Till" }] })] }));
    renderView();
    const row = await screen.findByTestId("incident-event-901");
    expect(within(row).getByRole("img")).toHaveAttribute("src", "/api/cameras/events/1727140000.1-person/thumbnail");
    expect(within(row).getByRole("link", { name: "Clip" })).toHaveAttribute("href", "/api/cameras/clips/event/1727140000.1-person");
    expect(row).toHaveTextContent("Also in Till");
  });

  it("after Frigate's 14 days: Clip expired, no dead link or thumbnail", async () => {
    const old = new Date(NOW.getTime() - 20 * 86_400_000).toISOString();
    h.getSecurityIncident.mockResolvedValue(detail({ events: [member({ startedAt: old })] }));
    renderView();
    const row = await screen.findByTestId("incident-event-901");
    expect(within(row).queryByRole("link", { name: "Clip" })).toBeNull();
    expect(within(row).queryByRole("img")).toBeNull();
    expect(row).toHaveTextContent(COPY.clipExpired);
  });

  it("events trimmed after 30 days: the §6.10 sentence, and no event rows", async () => {
    h.getSecurityIncident.mockResolvedValue(detail({ events: [], eventsKept: "removed" }));
    renderView();
    expect(await screen.findByText(COPY.trimmed)).toBeInTheDocument();
    expect(COPY.trimmed).toBe(
      "The events behind this were removed after 30 days. Droplet keeps incidents for a year: when and where it happened, why it was flagged, who was told and who acknowledged it.",
    );
    expect(screen.queryByTestId("incident-event-901")).toBeNull();
  });

  it("DS-005: who was told renders exactly the notices the box sent — and is absent when it sent none", async () => {
    renderView();
    await screen.findByRole("heading", { level: 1, name: "Stock room" });
    expect(screen.queryByRole("heading", { name: COPY.toldTitle })).toBeNull();
  });

  it("owner/admin get every notice from the box; each renders as its own line", async () => {
    h.getSecurityIncident.mockResolvedValue(
      detail({
        notices: [
          { userId: "u1", name: "Stefan", outcome: "sent", reason: "routed", channels: "toast,push", pushOutcome: "sent", createdAt: at("01:15"), settledAt: at("01:15") },
          { userId: "u2", name: "Maria", outcome: "skipped_not_visible", reason: "routed", channels: "", pushOutcome: null, createdAt: at("01:15"), settledAt: null },
        ],
      }),
    );
    renderView();
    const list = await screen.findByRole("list", { name: COPY.toldTitle });
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
        "Stefan · sent to their phone at 2:15 AM",
        "Maria · not told: can't see Back camera",
      ]),
    );
  });

  it("a family viewer gets their own notice only from the box — and sees just that", async () => {
    h.getSecurityIncident.mockResolvedValue(
      detail({ notices: [{ userId: "u3", name: "Jordan", outcome: "sent", reason: "routed", channels: "toast", pushOutcome: "no_subscribers", createdAt: at("01:15"), settledAt: at("01:15") }] }),
    );
    renderView();
    const list = await screen.findByRole("list", { name: COPY.toldTitle });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Jordan · shown in Droplet at 2:15 AM"]);
  });

  it("the acknowledgement history, with a resolve's note", async () => {
    h.getSecurityIncident.mockResolvedValue(
      detail({
        state: "resolved",
        lastAck: { action: "resolve", byName: "Stefan", at: at("01:30") },
        acks: [
          { action: "acknowledge", byName: "Maria", at: at("01:17"), client: "Droplet for iPhone 1.4", viaNotification: true, note: "" },
          { action: "resolve", byName: "Stefan", at: at("01:30"), client: null, viaNotification: false, note: "It was the cleaner." },
        ],
        viewer: { level: "act", acknowledged: true },
      }),
    );
    renderView();
    const list = await screen.findByRole("list", { name: COPY.acksTitle });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(
      "Maria acknowledged · 2:17 AM · Droplet for iPhone 1.4 (as the device reported it) · from the alert notification",
    );
    expect(items[1]).toHaveTextContent("Stefan resolved · 2:30 AM");
    expect(items[1]).toHaveTextContent("It was the cleaner.");
  });

  it("plain activity (no visible code): no state chip, no buttons, no notices", async () => {
    h.getSecurityIncident.mockResolvedValue(detail({ state: "no_action", severity: "info", reasonCodes: [], reasons: [] }));
    renderView();
    await screen.findByRole("heading", { level: 1, name: "Stock room" });
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.acknowledge })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.resolve })).toBeNull();
    expect(screen.queryByRole("heading", { name: COPY.whyTitle })).toBeNull();
  });

  it("a missing incident and a hidden one read the same: not found, with the way back", async () => {
    h.getSecurityIncident.mockRejectedValue(typedError("INCIDENT_NOT_FOUND", 404));
    renderView();
    expect(await screen.findByText(COPY.notFound)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: COPY.backToSecurity })).toHaveAttribute("href", "/security");
    expect(document.body).not.toHaveTextContent("raw server text");
  });

  it("a read that fails otherwise says so, with Retry — never not-found", async () => {
    h.getSecurityIncident.mockRejectedValue(typedError("INCIDENTS_UNAVAILABLE", 503));
    renderView();
    expect(await screen.findByRole("alert")).toHaveTextContent(COPY.loadError);
    expect(screen.queryByText(COPY.notFound)).toBeNull();
    h.getSecurityIncident.mockResolvedValue(detail());
    fireEvent.click(screen.getByRole("button", { name: COPY.retry }));
    expect(await screen.findByRole("heading", { level: 1, name: "Stock room" })).toBeInTheDocument();
  });
});

describe("who may act (rendered only at act, never rendered-then-refused)", () => {
  it("at act, open: Acknowledge (primary) and Resolve…", async () => {
    renderView();
    expect(await screen.findByRole("button", { name: COPY.acknowledge })).toHaveClass("btn", "primary");
    expect(screen.getByRole("button", { name: COPY.resolve })).toBeInTheDocument();
  });

  it("below act on the module level: neither button", async () => {
    h.level = "view";
    renderView();
    await screen.findByRole("heading", { level: 1, name: "Stock room" });
    expect(screen.queryByRole("button", { name: COPY.acknowledge })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.resolve })).toBeNull();
  });

  it("below act on the box's own answer (viewer.level) — even when the module level says act: neither button", async () => {
    h.getSecurityIncident.mockResolvedValue(detail({ viewer: { level: "view", acknowledged: false } }));
    renderView();
    await screen.findByRole("heading", { level: 1, name: "Stock room" });
    expect(screen.queryByRole("button", { name: COPY.acknowledge })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.resolve })).toBeNull();
  });

  it("acknowledged by someone else: this person can still acknowledge (D23), as a secondary button", async () => {
    h.getSecurityIncident.mockResolvedValue(
      detail({ state: "acknowledged", lastAck: { action: "acknowledge", byName: "Maria", at: at("01:17") }, viewer: { level: "act", acknowledged: false } }),
    );
    renderView();
    const ack = await screen.findByRole("button", { name: COPY.acknowledge });
    expect(ack).not.toHaveClass("primary");
  });

  it("not actionable for this viewer (only lower-severity codes visible): neither button, even at act and open (PR-B review)", async () => {
    h.getSecurityIncident.mockResolvedValue(detail({ actionable: false }));
    renderView();
    await screen.findByRole("heading", { level: 1, name: "Stock room" });
    expect(screen.queryByRole("button", { name: COPY.acknowledge })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.resolve })).toBeNull();
  });

  it("a box that doesn't say it's actionable gets no buttons (fails closed)", async () => {
    const { actionable: _drop, ...rest } = detail();
    void _drop;
    h.getSecurityIncident.mockResolvedValue(rest);
    renderView();
    await screen.findByRole("heading", { level: 1, name: "Stock room" });
    expect(screen.queryByRole("button", { name: COPY.acknowledge })).toBeNull();
  });

  it("already acknowledged by this person: only Resolve…", async () => {
    h.getSecurityIncident.mockResolvedValue(detail({ state: "acknowledged", viewer: { level: "act", acknowledged: true } }));
    renderView();
    expect(await screen.findByRole("button", { name: COPY.resolve })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: COPY.acknowledge })).toBeNull();
  });

  it("resolved: nothing to act on", async () => {
    h.getSecurityIncident.mockResolvedValue(detail({ state: "resolved", viewer: { level: "act", acknowledged: true } }));
    renderView();
    await screen.findByRole("heading", { level: 1, name: "Stock room" });
    expect(screen.queryByRole("button", { name: COPY.resolve })).toBeNull();
  });
});

describe("Acknowledge", () => {
  it("sends the notification the page was opened from, and shows the box's answer", async () => {
    const after = detail({ state: "acknowledged", lastAck: { action: "acknowledge", byName: "Alex", at: at("01:31") }, viewer: { level: "act", acknowledged: true } });
    h.acknowledgeSecurityIncident.mockResolvedValue({ incident: after, changed: true });
    renderView({ notificationId: "clx9abc" });
    fireEvent.click(await screen.findByRole("button", { name: COPY.acknowledge }));
    await waitFor(() => expect(h.acknowledgeSecurityIncident).toHaveBeenCalledWith(ID, { notificationId: "clx9abc" }));
    expect(await screen.findByText("Acknowledged", { selector: ".badge" })).toBeInTheDocument();
    expect(h.toast).toHaveBeenCalledWith(COPY.acknowledgedToast, "success");
  });

  it("without one, sends none", async () => {
    h.acknowledgeSecurityIncident.mockResolvedValue({ incident: detail(), changed: true });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: COPY.acknowledge }));
    await waitFor(() => expect(h.acknowledgeSecurityIncident).toHaveBeenCalledWith(ID, { notificationId: null }));
  });

  it("already done (changed:false) is silent", async () => {
    h.acknowledgeSecurityIncident.mockResolvedValue({ incident: detail({ viewer: { level: "act", acknowledged: true } }), changed: false });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: COPY.acknowledge }));
    await waitFor(() => expect(h.acknowledgeSecurityIncident).toHaveBeenCalled());
    await rtlAct(async () => {});
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("in flight: aria-disabled, never disabled, keeps focus, and a second press is refused", async () => {
    let finish!: (v: unknown) => void;
    h.acknowledgeSecurityIncident.mockReturnValue(new Promise((r) => (finish = r)));
    renderView();
    const ack = await screen.findByRole("button", { name: COPY.acknowledge });
    ack.focus();
    fireEvent.click(ack);
    await waitFor(() => expect(ack).toHaveAttribute("aria-disabled", "true"));
    expect(ack).not.toBeDisabled();
    expect(ack).toHaveFocus();
    fireEvent.click(ack);
    expect(h.acknowledgeSecurityIncident).toHaveBeenCalledTimes(1);
    // Resolve… is inert too while the acknowledge is in flight.
    expect(screen.getByRole("button", { name: COPY.resolve })).toHaveAttribute("aria-disabled", "true");
    await rtlAct(async () => finish({ incident: detail(), changed: true }));
  });

  it("when Acknowledge goes away, focus moves to Resolve… instead of dropping to the page", async () => {
    h.acknowledgeSecurityIncident.mockResolvedValue({
      incident: detail({ state: "acknowledged", viewer: { level: "act", acknowledged: true } }),
      changed: true,
    });
    renderView();
    const ack = await screen.findByRole("button", { name: COPY.acknowledge });
    ack.focus();
    fireEvent.click(ack);
    await waitFor(() => expect(screen.queryByRole("button", { name: COPY.acknowledge })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: COPY.resolve })).toHaveFocus());
  });

  it("a lost race: the friendly copy (never the server's message), then a re-read", async () => {
    h.acknowledgeSecurityIncident.mockRejectedValue(typedError("INCIDENT_CONFLICT", 409));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: COPY.acknowledge }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    const [message, type] = h.toast.mock.calls[0]!;
    expect(type).toBe("error");
    expect(message).toBe("Someone else changed this incident at the same moment. Check it and try again.");
    expect(message).not.toContain("raw server text");
    await waitFor(() => expect(h.getSecurityIncident.mock.calls.length).toBeGreaterThan(1));
  });

  it("an audit failure: nothing was changed, and the button is usable again", async () => {
    h.acknowledgeSecurityIncident.mockRejectedValue(typedError("AUDIT_UNAVAILABLE", 503));
    renderView();
    const ack = await screen.findByRole("button", { name: COPY.acknowledge });
    fireEvent.click(ack);
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/nothing was changed/), "error"));
    await waitFor(() => expect(ack).not.toHaveAttribute("aria-disabled"));
  });
});

describe("Resolve…", () => {
  it("opens a dialog with the optional note; Resolve sends it, and focus lands on the state once both buttons are gone", async () => {
    const after = detail({ state: "resolved", lastAck: { action: "resolve", byName: "Alex", at: at("01:31") }, viewer: { level: "act", acknowledged: true } });
    h.resolveSecurityIncident.mockResolvedValue({ incident: after, changed: true });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: COPY.resolve }));
    const dialog = await screen.findByRole("dialog");
    const note = within(dialog).getByLabelText(COPY.noteLabel);
    expect(note).toHaveAttribute("maxLength", "280");
    fireEvent.change(note, { target: { value: "It was the cleaner." } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.resolveConfirm }));
    await waitFor(() => expect(h.resolveSecurityIncident).toHaveBeenCalledWith(ID, { note: "It was the cleaner." }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("incident-state")).toHaveFocus());
    expect(h.toast).toHaveBeenCalledWith(COPY.resolvedToast, "success");
  });

  it("a note the box refuses keeps the dialog (and the note) open, with the friendly copy", async () => {
    h.resolveSecurityIncident.mockRejectedValue(typedError("VALIDATION_ERROR", 400));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: COPY.resolve }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(COPY.noteLabel), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.resolveConfirm }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.not.stringContaining("raw server text"), "error"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByLabelText(COPY.noteLabel)).toHaveValue("x");
  });

  it("in flight: the dialog's Resolve is aria-disabled and refuses a second press", async () => {
    let finish!: (v: unknown) => void;
    h.resolveSecurityIncident.mockReturnValue(new Promise((r) => (finish = r)));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: COPY.resolve }));
    const confirm = within(await screen.findByRole("dialog")).getByRole("button", { name: COPY.resolveConfirm });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toHaveAttribute("aria-disabled", "true"));
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(h.resolveSecurityIncident).toHaveBeenCalledTimes(1);
    await rtlAct(async () => finish({ incident: detail(), changed: true }));
  });

  it("the note field labels itself the way the spec words it", () => {
    expect(COPY.noteLabel).toBe("What happened? Optional.");
    expect(INCIDENT_COPY.needsAttention).toBe("Needs attention");
  });
});
