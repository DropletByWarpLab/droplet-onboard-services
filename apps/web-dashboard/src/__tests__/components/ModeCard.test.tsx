/**
 * WARP-2977 P2b (ADR-059 §3.6) — the site mode card on /security.
 *
 * What this file pins:
 *   - the reason line for every state, in the SITE zone (the device here is
 *     on Los Angeles time, the site on London time);
 *   - act controls exist only at act or above — never rendered at view;
 *   - Close up runs at once, and its Undo exists only when the change started
 *     from the opening hours;
 *   - Open up asks "for how long?" with 2 h preselected and each end capped at
 *     the next opening;
 *   - a refused write shows the typed copy (never err.message) and re-reads;
 *   - the stale line reads the site_mode health row's lastSeenAt;
 *   - the disclaimer is always there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act as rtlAct, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { ToastProvider } from "@/components/Toast";
import {
  COPY,
  MODE_DISCLAIMER,
  ModeCard,
  doorLocksLine,
  modeReason,
  modeToast,
  openUpEnds,
  staleLine,
  uncheckedLocksLine,
  unlockedLocksLine,
} from "@/components/security/ModeCard";
import type { SecurityHealthRow, SecurityModeActionResult, SecurityModeView } from "@/lib/types";
import { SECURITY_MODE_PATH } from "@/lib/api";

const h = vi.hoisted(() => ({
  user: { role: "owner" } as { role?: string } | null,
  modules: undefined as unknown,
  deviceTz: "America/Los_Angeles" as string | null,
  authFetch: vi.fn(),
  getSecurityMode: vi.fn(),
  postSecurityMode: vi.fn(),
  getSecurityHealth: vi.fn(),
}));

vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/auth", () => ({
  authFetch: h.authFetch,
  useAuth: () => ({ user: h.user }),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getSecurityMode: h.getSecurityMode,
  postSecurityMode: h.postSecurityMode,
  getSecurityHealth: h.getSecurityHealth,
}));

vi.mock("@/lib/security-time", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security-time")>()),
  deviceTimeZone: () => h.deviceTz,
}));

// Wed 23 Sep 2026, 17:30 in London (BST, UTC+1) — 09:30 in Los Angeles.
const NOW = new Date("2026-09-23T16:30:00Z");
const LONDON = "Europe/London";
const TOMORROW_9AM = "2026-09-24T08:00:00.000Z"; // Thu 09:00 London
const TODAY_6PM = "2026-09-23T17:00:00.000Z"; // Wed 18:00 London

function view(over: Partial<SecurityModeView> = {}): SecurityModeView {
  return {
    mode: "open",
    source: "schedule",
    manualEnd: "none",
    until: null,
    setBy: null,
    setAt: "2026-09-23T08:00:00.000Z",
    hours: { state: "set", timezone: LONDON, scheduledMode: "open", upcoming: { at: TODAY_6PM, mode: "closed" } },
    displayTimezone: LONDON,
    stale: false,
    version: 4,
    ...over,
  };
}

const closedBySchedule = (over: Partial<SecurityModeView> = {}) =>
  view({
    mode: "closed",
    hours: { state: "set", timezone: LONDON, scheduledMode: "closed", upcoming: { at: TOMORROW_9AM, mode: "open" } },
    ...over,
  });

const closedUpByStefan = (over: Partial<SecurityModeView> = {}) =>
  closedBySchedule({
    source: "manual",
    manualEnd: "next_opening",
    until: TOMORROW_9AM,
    setBy: { id: "u1", name: "Stefan" },
    setAt: "2026-09-23T16:32:00.000Z", // 5:32 PM London
    ...over,
  });

const notSet = (over: Partial<SecurityModeView> = {}) =>
  view({ hours: { state: "not_set" }, displayTimezone: null, ...over });

function siteModeRow(lastSeenAt: string | null): SecurityHealthRow {
  return { id: "site_mode", state: lastSeenAt ? "ok" : "down", detail: "", lastSeenAt };
}

function modulesAt(level: "view" | "act" | "manage") {
  return { modules: [{ id: "security", effective: true }], effectiveForUser: [{ moduleId: "security", level }] };
}

function typedError(code: string, status: number): Error {
  return Object.assign(new Error(`raw server text for ${code}`), { code, status });
}

function result(mode: SecurityModeView, changed = true): SecurityModeActionResult {
  return { mode, changed };
}

function Wrap({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ToastProvider>{children}</ToastProvider>
    </SWRConfig>
  );
}

const onModeChanged = vi.fn();

function renderCard(now: Date = NOW) {
  return render(
    <Wrap>
      <ModeCard now={now} onModeChanged={onModeChanged} />
    </Wrap>,
  );
}

/** Wait until the card shows the mode AND the /api/modules level has landed. */
async function ready() {
  await screen.findByText(COPY.title);
  await waitFor(() => expect(document.querySelector("[data-mode]")).not.toBeNull());
  await waitFor(() => expect(h.authFetch).toHaveBeenCalledWith("/api/modules"));
  await rtlAct(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { role: "owner" };
  h.modules = modulesAt("manage");
  h.deviceTz = "America/Los_Angeles";
  h.authFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => h.modules }));
  h.getSecurityMode.mockResolvedValue(view());
  h.getSecurityHealth.mockResolvedValue({ sources: [siteModeRow(NOW.toISOString())] });
});

// ── copy per state, in the site zone ──

describe("modeReason — one line per state, in the SITE zone", () => {
  it("following the hours, open: when it closes (London 6 PM, not LA 10 AM)", () => {
    expect(modeReason(view(), NOW)).toBe("Closes at 6:00 PM");
  });

  it("following the hours, closed: when it opens", () => {
    expect(modeReason(closedBySchedule(), NOW)).toBe("Opens at 9:00 AM tomorrow");
  });

  it("closed up by hand until the next opening", () => {
    expect(modeReason(closedUpByStefan(), NOW)).toBe(
      "Closed up by Stefan at 5:32 PM · Opening hours take over at 9:00 AM tomorrow",
    );
  });

  it("closed up with no opening ahead stays closed until someone changes it", () => {
    expect(modeReason(closedUpByStefan({ manualEnd: "until_changed", until: null }), NOW)).toBe(
      "Closed up by Stefan at 5:32 PM · Stays this way until someone changes it",
    );
  });

  it("opened up for a while, then back to closed", () => {
    const at = new Date("2026-09-23T18:20:00Z"); // 7:20 PM London
    const v = closedBySchedule({
      mode: "open",
      source: "manual",
      manualEnd: "at_time",
      setBy: { id: "u2", name: "Maria" },
      setAt: "2026-09-23T18:10:00.000Z",
      until: "2026-09-23T20:10:00.000Z",
    });
    expect(modeReason(v, at)).toBe("Opened by Maria at 7:10 PM · Back to closed at 9:10 PM");
  });

  it("opened up until the opening (capped): the hours take over, not 'back to closed'", () => {
    const at = new Date("2026-09-24T06:30:00Z");
    const v = closedBySchedule({
      mode: "open",
      source: "manual",
      manualEnd: "at_time",
      setBy: { id: "u2", name: "Maria" },
      setAt: "2026-09-24T06:00:00.000Z",
      until: TOMORROW_9AM,
    });
    expect(modeReason(v, at)).toBe("Opened by Maria at 7:00 AM · Opening hours take over at 9:00 AM");
  });

  it("away since a day earlier in the week, with who set it", () => {
    const v = view({
      mode: "away",
      source: "manual",
      manualEnd: "until_changed",
      setBy: { id: "u1", name: "Stefan" },
      setAt: "2026-09-18T17:02:00.000Z", // Fri 6:02 PM London
    });
    expect(modeReason(v, NOW)).toBe("Away since Fri 6:02 PM (Stefan) · Stays this way until someone changes it");
  });

  it("no opening hours: the site counts as open", () => {
    expect(modeReason(notSet(), NOW)).toBe(COPY.notSet);
  });

  it("hours that never change say so", () => {
    expect(modeReason(view({ hours: { state: "set", timezone: LONDON, scheduledMode: "open", upcoming: null } }), NOW)).toBe(
      COPY.alwaysOpen,
    );
    expect(
      modeReason(
        closedBySchedule({ hours: { state: "set", timezone: LONDON, scheduledMode: "closed", upcoming: null } }),
        NOW,
      ),
    ).toBe(COPY.neverOpens);
  });

  it("with no site zone, times follow the DEVICE zone — never UTC", () => {
    h.deviceTz = "Asia/Tokyo"; // 16:30Z = 01:30 Thu in Tokyo
    const v = closedUpByStefan({ displayTimezone: null, until: null, manualEnd: "until_changed" });
    expect(modeReason(v, NOW)).toBe("Closed up by Stefan at 1:32 AM · Stays this way until someone changes it");
  });

  it("a person no longer on record is simply not named", () => {
    expect(modeReason(closedUpByStefan({ setBy: null }), NOW)).toBe(
      "Closed up at 5:32 PM · Opening hours take over at 9:00 AM tomorrow",
    );
  });
});

describe("the card renders the reason in the site zone", () => {
  it("London's 6 PM, with a note naming the zone when the device is elsewhere", async () => {
    renderCard();
    expect(await screen.findByText("Closes at 6:00 PM")).toBeInTheDocument();
    expect(screen.queryByText(/11:00 AM|10:00 AM/)).toBeNull();
    expect(screen.getByText("Times are in Europe/London.")).toBeInTheDocument();
    expect(document.querySelector("[data-mode]")).toHaveAttribute("data-mode", "open");
    expect(screen.getByText(COPY.badgeOpen)).toHaveClass("badge");
  });

  it("no zone note when the device is already on site time", async () => {
    h.deviceTz = LONDON;
    renderCard();
    await screen.findByText("Closes at 6:00 PM");
    expect(screen.queryByText(/Times are in/)).toBeNull();
  });

  it("a failed read is an error with a retry — never a guessed Open", async () => {
    h.getSecurityMode.mockRejectedValue(typedError("MODE_UNAVAILABLE", 503));
    renderCard();
    expect(await screen.findByRole("alert")).toHaveTextContent(COPY.loadError);
    expect(screen.queryByText(COPY.badgeOpen)).toBeNull();
    expect(screen.getByText(MODE_DISCLAIMER)).toBeInTheDocument();
  });
});

describe("the disclaimer is always visible", () => {
  it("is word for word", () => {
    expect(MODE_DISCLAIMER).toBe(
      "The mode tells Droplet when the site should be empty. It doesn't lock doors, arm anything, or call anyone.",
    );
  });

  it("shows at view level, where there are no controls", async () => {
    h.user = { role: "family" };
    h.modules = modulesAt("view");
    renderCard();
    await ready();
    expect(screen.getByText(MODE_DISCLAIMER)).toBeInTheDocument();
  });

  it("shows while loading", () => {
    h.getSecurityMode.mockReturnValue(new Promise(() => {}));
    renderCard();
    expect(screen.getByText(MODE_DISCLAIMER)).toBeInTheDocument();
  });
});

// ── levels ──

describe("controls exist only at act or above", () => {
  it("view: no buttons at all — not disabled, absent", async () => {
    h.user = { role: "family" };
    h.modules = modulesAt("view");
    renderCard();
    await ready();
    expect(screen.queryByRole("button", { name: COPY.closeUp })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.moreLabel })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("view while the level is still loading: nothing rendered and then taken away", async () => {
    h.authFetch.mockReturnValue(new Promise(() => {}));
    renderCard();
    await screen.findByText("Closes at 6:00 PM");
    expect(screen.queryByRole("button", { name: COPY.closeUp })).toBeNull();
  });

  it("a family member with no per-person level gets view (fails closed)", async () => {
    h.user = { role: "family" };
    h.modules = { modules: [{ id: "security", effective: true }] };
    renderCard();
    await ready();
    expect(screen.queryByRole("button", { name: COPY.closeUp })).toBeNull();
  });

  it("act: Close up is there when the site is open", async () => {
    h.user = { role: "family" };
    h.modules = modulesAt("act");
    renderCard();
    expect(await screen.findByRole("button", { name: COPY.closeUp })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: COPY.openUp })).toBeNull();
  });

  it("Open up, not Close up, when the site is closed or away", async () => {
    h.getSecurityMode.mockResolvedValue(closedBySchedule());
    renderCard();
    expect(await screen.findByRole("button", { name: COPY.openUp })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: COPY.closeUp })).toBeNull();
  });

  it("the read-only line names the level, never the role (an admin can be narrowed below manage)", () => {
    expect(COPY.managerSetsHours).not.toMatch(/admin/i);
  });

  it("an admin is gated by their level, never by the role: narrowed to act, no manage link", async () => {
    h.user = { role: "admin" };
    h.modules = modulesAt("act");
    h.getSecurityMode.mockResolvedValue(notSet());
    renderCard();
    expect(await screen.findByRole("button", { name: COPY.closeUp })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: COPY.setHours })).toBeNull();
    expect(screen.getByText(COPY.managerSetsHours)).toBeInTheDocument();
  });

  it("an admin narrowed to view gets no controls at all", async () => {
    h.user = { role: "admin" };
    h.modules = modulesAt("view");
    h.getSecurityMode.mockResolvedValue(notSet());
    renderCard();
    await ready();
    await screen.findByText(COPY.managerSetsHours);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: COPY.setHours })).toBeNull();
  });

  it("no hours: manage gets a Set opening hours link, act gets the admin line", async () => {
    h.getSecurityMode.mockResolvedValue(notSet());
    const first = renderCard();
    const link = await screen.findByRole("link", { name: COPY.setHours });
    expect(link).toHaveAttribute("href", "/security/settings");
    expect(screen.queryByText(COPY.managerSetsHours)).toBeNull();
    first.unmount();

    h.user = { role: "family" };
    h.modules = modulesAt("act");
    renderCard();
    await screen.findByRole("button", { name: COPY.closeUp });
    expect(screen.getByText(COPY.managerSetsHours)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: COPY.setHours })).toBeNull();
  });
});

// ── Close up ──

describe("Close up", () => {
  it("runs at once, toasts the end in site time, refreshes the feed, and offers Undo after a schedule mode", async () => {
    h.postSecurityMode.mockResolvedValueOnce(result(closedUpByStefan()));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));

    await waitFor(() => expect(h.postSecurityMode).toHaveBeenCalledWith({ action: "close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const toast = await screen.findByText("Closed until 9:00 AM tomorrow.");
    expect(onModeChanged).toHaveBeenCalledTimes(1);
    // The card shows the server's answer without waiting for a re-read.
    expect(await screen.findByText(/Closed up by Stefan at 5:32 PM/)).toBeInTheDocument();

    h.postSecurityMode.mockResolvedValueOnce(result(view()));
    const toastEl = toast.closest("[data-toast]") as HTMLElement;
    fireEvent.click(within(toastEl).getByRole("button", { name: COPY.undo }));
    await waitFor(() => expect(h.postSecurityMode).toHaveBeenLastCalledWith({ action: "resume" }));
    await waitFor(() => expect(onModeChanged).toHaveBeenCalledTimes(2));
  });

  it("no Undo when the site was open by hand (resuming would not undo it)", async () => {
    const openedByHand = closedBySchedule({
      mode: "open",
      source: "manual",
      manualEnd: "at_time",
      until: "2026-09-23T18:30:00.000Z",
      setBy: { id: "u2", name: "Maria" },
      setAt: "2026-09-23T16:00:00.000Z",
    });
    h.getSecurityMode.mockResolvedValue(openedByHand);
    h.postSecurityMode.mockResolvedValueOnce(result(closedBySchedule()));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));
    const toast = await screen.findByText("Closed until 9:00 AM tomorrow.");
    expect(within(toast.closest("[data-toast]") as HTMLElement).queryByRole("button", { name: COPY.undo })).toBeNull();
  });

  it("no Undo when nothing changed", async () => {
    h.postSecurityMode.mockResolvedValueOnce(result(closedBySchedule(), false));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));
    const toast = await screen.findByText("Closed until 9:00 AM tomorrow.");
    expect(within(toast.closest("[data-toast]") as HTMLElement).queryByRole("button", { name: COPY.undo })).toBeNull();
  });

  it("409: the typed copy (never the server's text), then a re-read of the mode and the feed", async () => {
    h.postSecurityMode.mockRejectedValueOnce(typedError("MODE_CONFLICT", 409));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));
    expect(
      await screen.findByText("Someone else changed the mode just now. Check the mode and try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw server text/)).toBeNull();
    await waitFor(() => expect(h.getSecurityMode).toHaveBeenCalledTimes(2));
    expect(onModeChanged).toHaveBeenCalledTimes(1);
  });

  it("503 AUDIT_UNAVAILABLE: says nothing was changed", async () => {
    h.postSecurityMode.mockRejectedValueOnce(typedError("AUDIT_UNAVAILABLE", 503));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Droplet couldn't record that change in its activity log, so nothing was changed.",
    );
  });
});

// ── Open up ──

describe("Open up", () => {
  it("asks for how long, 2 hours preselected, each end in site time", async () => {
    h.getSecurityMode.mockResolvedValue(closedBySchedule());
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.openUp }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(COPY.openDialogTitle);
    expect(within(dialog).getByRole("radio", { name: /2 hours/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /1 hour/ })).not.toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /1 hour/ })).toHaveAccessibleName(/Until 6:30 PM/);
    expect(within(dialog).getByRole("radio", { name: /2 hours/ })).toHaveAccessibleName(/Until 7:30 PM/);
    expect(within(dialog).getByRole("radio", { name: /4 hours/ })).toHaveAccessibleName(/Until 9:30 PM/);
    expect(h.postSecurityMode).not.toHaveBeenCalled();

    h.postSecurityMode.mockResolvedValueOnce(
      result(
        closedBySchedule({
          mode: "open",
          source: "manual",
          manualEnd: "at_time",
          until: "2026-09-23T18:30:00.000Z",
          setBy: { id: "u1", name: "Stefan" },
          setAt: NOW.toISOString(),
        }),
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.openUp }));
    await waitFor(() => expect(h.postSecurityMode).toHaveBeenCalledWith({ action: "open", for: "2h" }));
    expect(await screen.findByText("Open until 7:30 PM.")).toBeInTheDocument();
    expect(onModeChanged).toHaveBeenCalledTimes(1);
  });

  it("sends the length picked", async () => {
    h.getSecurityMode.mockResolvedValue(closedBySchedule());
    h.postSecurityMode.mockResolvedValueOnce(result(closedBySchedule()));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.openUp }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: /4 hours/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.openUp }));
    await waitFor(() => expect(h.postSecurityMode).toHaveBeenCalledWith({ action: "open", for: "4h" }));
  });

  it("ends are capped at the next opening, and say so", async () => {
    const early = new Date("2026-09-24T05:30:00Z"); // 6:30 AM London; opens 9:00
    h.getSecurityMode.mockResolvedValue(closedBySchedule());
    renderCard(early);
    fireEvent.click(await screen.findByRole("button", { name: COPY.openUp }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /1 hour/ })).toHaveAccessibleName(/Until 7:30 AM$/);
    expect(within(dialog).getByRole("radio", { name: /2 hours/ })).toHaveAccessibleName(/Until 8:30 AM$/);
    expect(within(dialog).getByRole("radio", { name: /4 hours/ })).toHaveAccessibleName(
      /Until 9:00 AM, when the site opens/,
    );
  });

  it("with no hours ahead to cap it, no dialog: the server resumes the (open) opening hours", async () => {
    h.getSecurityMode.mockResolvedValue(notSet({ mode: "closed", source: "manual", manualEnd: "until_changed" }));
    h.postSecurityMode.mockResolvedValueOnce(result(notSet()));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.openUp }));
    await waitFor(() => expect(h.postSecurityMode).toHaveBeenCalledWith({ action: "open", for: "2h" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText(COPY.toastOpen)).toBeInTheDocument();
  });

  it("Cancel sends nothing", async () => {
    h.getSecurityMode.mockResolvedValue(closedBySchedule());
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.openUp }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.postSecurityMode).not.toHaveBeenCalled();
  });
});

describe("openUpEnds", () => {
  it("min(now + N, next opening)", () => {
    const early = new Date("2026-09-24T05:30:00Z");
    expect(openUpEnds(closedBySchedule(), early)).toEqual([
      { value: "1h", label: "1 hour", endsAt: "2026-09-24T06:30:00.000Z", capped: false },
      { value: "2h", label: "2 hours", endsAt: "2026-09-24T07:30:00.000Z", capped: false },
      { value: "4h", label: "4 hours", endsAt: TOMORROW_9AM, capped: true },
    ]);
  });

  it("uncapped when the hours never open again", () => {
    const v = closedBySchedule({ hours: { state: "set", timezone: LONDON, scheduledMode: "closed", upcoming: null } });
    expect(openUpEnds(v, NOW).map((e) => e.capped)).toEqual([false, false, false]);
  });
});

// ── the menu ──

describe("the More menu", () => {
  it("open by the hours: Away only", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual([COPY.away]);
  });

  it("closed by hand: Away and Back to opening hours", async () => {
    h.getSecurityMode.mockResolvedValue(closedUpByStefan());
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
      COPY.away,
      COPY.resume,
    ]);
  });

  it("away: only Back to opening hours, which resumes", async () => {
    h.getSecurityMode.mockResolvedValue(
      view({ mode: "away", source: "manual", manualEnd: "until_changed", setBy: { id: "u1", name: "Stefan" } }),
    );
    h.postSecurityMode.mockResolvedValueOnce(result(view()));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((b) => b.textContent)).toEqual([COPY.resume]);
    fireEvent.click(items[0]!);
    await waitFor(() => expect(h.postSecurityMode).toHaveBeenCalledWith({ action: "resume" }));
    expect(await screen.findByText("Back to opening hours. Open until 6:00 PM.")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Away posts away", async () => {
    h.postSecurityMode.mockResolvedValueOnce(
      result(view({ mode: "away", source: "manual", manualEnd: "until_changed" })),
    );
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: COPY.away }));
    await waitFor(() => expect(h.postSecurityMode).toHaveBeenCalledWith({ action: "away" }));
    expect(await screen.findByText(COPY.toastAway)).toBeInTheDocument();
  });

  it("Escape closes it", async () => {
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keyboard: focus lands on the first item, and the arrows, Home and End move between items", async () => {
    h.getSecurityMode.mockResolvedValue(closedUpByStefan());
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    const menu = screen.getByRole("menu");
    const [away, resume] = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(away).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(resume).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(away).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(resume).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(away).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(resume).toHaveFocus();
    expect(h.postSecurityMode).not.toHaveBeenCalled();
  });
});

// ── keyboard focus through a mode change ──

describe("focus stays where the person is", () => {
  it("while a change is in flight the control is aria-disabled, never disabled, and keeps focus as Close up becomes Open up", async () => {
    let resolve!: (r: SecurityModeActionResult) => void;
    h.postSecurityMode.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderCard();
    const closeUp = await screen.findByRole("button", { name: COPY.closeUp });
    closeUp.focus();
    fireEvent.click(closeUp);
    await waitFor(() => expect(closeUp).toHaveAttribute("aria-disabled", "true"));
    expect(closeUp).not.toBeDisabled();
    // A second activation while in flight sends nothing.
    fireEvent.click(closeUp);
    expect(h.postSecurityMode).toHaveBeenCalledTimes(1);
    await rtlAct(async () => resolve(result(closedUpByStefan())));
    const openUp = await screen.findByRole("button", { name: COPY.openUp });
    expect(openUp).toBe(closeUp); // the same node, relabelled
    expect(openUp).toHaveFocus();
    expect(openUp).not.toHaveAttribute("aria-disabled");
  });

  it("choosing a More item returns focus to More", async () => {
    h.postSecurityMode.mockResolvedValueOnce(result(view({ mode: "away", source: "manual", manualEnd: "until_changed" })));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: COPY.away }));
    await waitFor(() => expect(h.postSecurityMode).toHaveBeenCalledWith({ action: "away" }));
    expect(screen.getByRole("button", { name: COPY.moreLabel })).toHaveFocus();
  });

  it("the Open up dialog opens on the checked choice (2 hours), not the first radio", async () => {
    h.getSecurityMode.mockResolvedValue(closedBySchedule());
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.openUp }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /2 hours/ })).toHaveFocus());
  });
});

// ── a failed re-read ──

describe("a failed re-read keeps the last mode the server gave", () => {
  it("the badge and reason stay, with a note that it couldn't refresh and a Retry — not the can't-tell card", async () => {
    let swrMutate: ((key: string) => Promise<unknown>) | undefined;
    function Grab() {
      swrMutate = useSWRConfig().mutate as unknown as (key: string) => Promise<unknown>;
      return null;
    }
    render(
      <Wrap>
        <Grab />
        <ModeCard now={NOW} onModeChanged={onModeChanged} />
      </Wrap>,
    );
    await screen.findByText("Closes at 6:00 PM");
    h.getSecurityMode.mockRejectedValue(typedError("MODE_UNAVAILABLE", 503));
    await rtlAct(async () => {
      await swrMutate!(SECURITY_MODE_PATH).catch(() => undefined);
    });
    expect(await screen.findByText(COPY.refreshFailed)).toBeInTheDocument();
    expect(screen.getByText(COPY.badgeOpen)).toBeInTheDocument();
    expect(screen.getByText("Closes at 6:00 PM")).toBeInTheDocument();
    expect(screen.queryByText(COPY.loadError)).toBeNull();
    // Retry re-reads; once it answers, the note goes.
    h.getSecurityMode.mockResolvedValue(view());
    fireEvent.click(within(document.querySelector("[data-refresh-failed]") as HTMLElement).getByRole("button", { name: COPY.retry }));
    await waitFor(() => expect(screen.queryByText(COPY.refreshFailed)).toBeNull());
  });
});

// ── stale ──

describe("the stale line reads the site_mode health row", () => {
  it("names the last check in site time", async () => {
    h.getSecurityMode.mockResolvedValue(view({ stale: true }));
    h.getSecurityHealth.mockResolvedValue({ sources: [siteModeRow("2026-09-23T16:02:00.000Z")] });
    renderCard();
    expect(
      await screen.findByText(
        "Droplet hasn't checked the opening hours since 5:02 PM, so the mode may be out of date.",
      ),
    ).toBeInTheDocument();
  });

  it("never checked has its own copy", async () => {
    h.getSecurityMode.mockResolvedValue(view({ stale: true }));
    h.getSecurityHealth.mockResolvedValue({ sources: [siteModeRow(null)] });
    renderCard();
    expect(await screen.findByText(COPY.staleNever)).toBeInTheDocument();
  });

  it("not stale: no line", async () => {
    renderCard();
    await screen.findByText("Closes at 6:00 PM");
    await waitFor(() => expect(h.getSecurityHealth).toHaveBeenCalled());
    expect(document.querySelector("[data-stale]")).toBeNull();
  });

  it("staleLine: no row (header not loaded or failed) → can't confirm", () => {
    expect(staleLine(null, view(), NOW)).toBe(COPY.staleUnknown);
    expect(staleLine(siteModeRow(null), view(), NOW)).toBe(COPY.staleNever);
  });
});

// WARP-2977 P2b-2 (spec §8): a Close up or Away names the door locks still open.
describe("unlockedLocksLine — the doors still open, never 'all locked'", () => {
  it("nothing to name → no line at all (absent for people without Devices view, empty when none is known open)", () => {
    expect(unlockedLocksLine(undefined)).toBeNull();
    expect(unlockedLocksLine([])).toBeNull();
  });

  it("one, two, or the first and a count", () => {
    expect(unlockedLocksLine(["Back door lock"])).toBe("Back door lock is still unlocked.");
    expect(unlockedLocksLine(["Back door lock", "Side gate"])).toBe("Back door lock and Side gate are still unlocked.");
    expect(unlockedLocksLine(["Back door lock", "Cellar", "Side gate"])).toBe(
      "Back door lock and 2 other locks are still unlocked.",
    );
  });
});

describe("the toast names the doors still open (WARP-2977 P2b-2)", () => {
  it("Close up: the end, then the lock — and Undo is still offered", async () => {
    h.postSecurityMode.mockResolvedValueOnce({ ...result(closedUpByStefan()), unlockedLocks: ["Back door lock"] });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));
    const toast = await screen.findByText("Closed until 9:00 AM tomorrow. Back door lock is still unlocked.");
    expect(within(toast.closest("[data-toast]") as HTMLElement).getByRole("button", { name: COPY.undo })).toBeInTheDocument();
  });

  it("Away: the same line after the away copy", async () => {
    h.postSecurityMode.mockResolvedValueOnce({
      ...result(view({ mode: "away", source: "manual", manualEnd: "until_changed" })),
      unlockedLocks: ["Back door lock", "Side gate"],
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: COPY.away }));
    expect(
      await screen.findByText(`${COPY.toastAway} Back door lock and Side gate are still unlocked.`),
    ).toBeInTheDocument();
  });

  it("an empty list adds nothing — the toast never says the doors are locked", async () => {
    h.postSecurityMode.mockResolvedValueOnce({ ...result(closedUpByStefan()), unlockedLocks: [], locksChecked: true });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));
    const toast = await screen.findByText("Closed until 9:00 AM tomorrow.");
    expect(toast.closest("[data-toast]")).not.toHaveTextContent(/locked/i);
  });

  // Review F4: the server could not vouch for the locks (the smart-home service
  // is down, or nothing checked yet) — the toast says so, never "none open".
  it("the locks couldn't be checked: the toast says so after the mode's line", async () => {
    h.postSecurityMode.mockResolvedValueOnce({ ...result(closedUpByStefan()), locksChecked: false });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));
    expect(await screen.findByText(`Closed until 9:00 AM tomorrow. ${COPY.locksNotChecked}`)).toBeInTheDocument();
    expect(COPY.locksNotChecked).toBe("Droplet couldn't check the door locks.");
  });

  it("doorLocksLine: not checked wins over any names; no fields at all (no Devices view) adds nothing", () => {
    expect(doorLocksLine({ locksChecked: false })).toBe(COPY.locksNotChecked);
    expect(doorLocksLine({ locksChecked: false, unlockedLocks: ["Back door lock"], uncheckedLocks: ["Side gate"] })).toBe(
      COPY.locksNotChecked,
    );
    expect(doorLocksLine({ locksChecked: true, unlockedLocks: ["Back door lock"] })).toBe("Back door lock is still unlocked.");
    expect(doorLocksLine({ locksChecked: true, unlockedLocks: [], uncheckedLocks: [] })).toBeNull();
    expect(doorLocksLine({})).toBeNull();
  });

  // rjouffret, review of 4fa950c8: one lock with a dead battery no longer
  // hides the Back door — the toast names it, then the lock it couldn't check.
  it("one lock not reporting: the open Back door, then 'couldn't check' for the silent one — and nothing about the rest", async () => {
    h.postSecurityMode.mockResolvedValueOnce({
      ...result(closedUpByStefan()),
      locksChecked: true,
      unlockedLocks: ["Back door"],
      uncheckedLocks: ["Side gate"],
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.closeUp }));
    expect(
      await screen.findByText("Closed until 9:00 AM tomorrow. Back door is still unlocked. Droplet couldn't check Side gate."),
    ).toBeInTheDocument();
  });

  it("Away with nothing open but a lock it couldn't check: only the 'couldn't check' line", async () => {
    h.postSecurityMode.mockResolvedValueOnce({
      ...result(view({ mode: "away", source: "manual", manualEnd: "until_changed" })),
      locksChecked: true,
      unlockedLocks: [],
      uncheckedLocks: ["Garage", "Side gate"],
    });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: COPY.moreLabel }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: COPY.away }));
    const toast = await screen.findByText(`${COPY.toastAway} Droplet couldn't check Garage or Side gate.`);
    expect(toast.closest("[data-toast]")).not.toHaveTextContent(/still unlocked|all locked/i);
  });
});

describe("uncheckedLocksLine — the locks Droplet can't vouch for, never 'all locked'", () => {
  it("nothing to name → no line", () => {
    expect(uncheckedLocksLine(undefined)).toBeNull();
    expect(uncheckedLocksLine([])).toBeNull();
  });

  it("one, two, or the first and a count", () => {
    expect(uncheckedLocksLine(["Side gate"])).toBe("Droplet couldn't check Side gate.");
    expect(uncheckedLocksLine(["Garage", "Side gate"])).toBe("Droplet couldn't check Garage or Side gate.");
    expect(uncheckedLocksLine(["Annex", "Garage", "Side gate"])).toBe("Droplet couldn't check Annex and 2 other locks.");
  });
});

describe("modeToast", () => {
  it("reads the server's answer, in site time", () => {
    expect(modeToast("close", closedUpByStefan(), NOW)).toBe("Closed until 9:00 AM tomorrow.");
    expect(modeToast("close", closedUpByStefan({ manualEnd: "until_changed", until: null, hours: { state: "not_set" } }), NOW)).toBe(
      COPY.toastClosedUntilChanged,
    );
    expect(modeToast("resume", view(), NOW)).toBe("Back to opening hours. Open until 6:00 PM.");
  });
});
