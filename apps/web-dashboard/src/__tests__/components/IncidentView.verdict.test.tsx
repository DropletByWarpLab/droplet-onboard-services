/**
 * WARP-2980 (ADR-059 P5 PR-C, spec §8 "Incident page") — the incident page
 * wires route 18's pattern flags and verdict, and route 35's write:
 *
 *   · the pattern flags sit in the reasons card, after the counted reasons;
 *     an incident with flags and no counted reason heads the card "What
 *     Droplet would have flagged" (it flagged nothing);
 *   · trial flags are owner/admin only (spec §6.13, D19): the box sends
 *     them only to owner/admin, and the page never shows one to anyone
 *     else, even if a box did;
 *   · Expected / Not expected POST route 35 and show the incident it
 *     returns; `changed:false` is silent;
 *   · a failure is `translateError(err, "security")`, never the server's
 *     words, then a re-read;
 *   · one write at a time: while a verdict is in flight, a second press is
 *     refused and Acknowledge / Resolve… are aria-disabled too (two writes
 *     would race the incident's version); when the buttons go away, focus
 *     lands on the answer line, never on <body>.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { IncidentView, COPY } from "@/components/security/IncidentView";
import { VERDICT_COPY } from "@/components/security/VerdictBar";
import { FLAG_COPY } from "@/components/security/PatternFlagList";
import { translateError } from "@/lib/friendly-errors";
import type { IncidentDetail, IncidentPatternFlagView, SecurityModeView } from "@/lib/types";

const h = vi.hoisted(() => ({
  level: "act" as "none" | "view" | "act" | "manage",
  role: "owner" as string | null,
  toast: vi.fn(),
  getSecurityIncident: vi.fn(),
  acknowledgeSecurityIncident: vi.fn(),
  resolveSecurityIncident: vi.fn(),
  setSecurityIncidentVerdict: vi.fn(),
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
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  useAuth: () => ({ user: h.role ? { id: "u1", username: "maria", displayName: "Maria", role: h.role } : null }),
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
  setSecurityIncidentVerdict: h.setSecurityIncidentVerdict,
  getSecurityMode: h.getSecurityMode,
  fetchCameras: h.fetchCameras,
}));

const ID = "7f3c2a10-5b1e-4c8e-9a0d-2f6b3c4d5e6f";
const NOW = new Date("2026-09-23T01:31:00Z");
const at = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`;

function flag(over: Partial<IncidentPatternFlagView> = {}): IncidentPatternFlagView {
  return {
    code: "out_of_place",
    effect: "trial",
    severity: "notice",
    key: { kind: "area", zoneId: "z1", camera: null },
    evidence: { eventId: "901", camera: "back_cam", label: "person", at: at("01:14"), summary: "Person in aisle" },
    detail: { dayType: "weekday", hour: 2, daysObserved: 20, daysWithEvent: 0 },
    suppression: null,
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
    events: [],
    moreEvents: false,
    acks: [],
    notices: [],
    eventsKept: "kept",
    actionable: true,
    verdict: { state: "unreviewed", byName: null, at: null, codes: [] },
    patternFlags: [flag()],
    viewer: { level: "act", acknowledged: false, canGiveVerdict: true },
    ...over,
  };
}

/** A plain-activity incident: only a trial flag, nothing counted (every P5 code is trial in PR-B). */
const trialOnly = (over: Partial<IncidentDetail> = {}) =>
  detail({ state: "no_action", severity: "info", reasonCodes: [], reasons: [], actionable: false, ...over });

function typedError(code: string, status: number): Error {
  return Object.assign(new Error(`raw server text for ${code}`), { code, status });
}

function Wrap({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

const renderView = () => render(<IncidentView id={ID} notificationId={null} now={NOW} />, { wrapper: Wrap });

beforeEach(() => {
  vi.clearAllMocks();
  h.level = "act";
  h.role = "owner";
  h.getSecurityIncident.mockResolvedValue(detail());
  h.getSecurityMode.mockResolvedValue({ displayTimezone: "Europe/London" } as SecurityModeView);
  h.fetchCameras.mockResolvedValue([{ name: "back_cam", displayName: "Back camera" }]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the pattern flags on the incident page", () => {
  it("sit in the reasons card after the counted reasons, under 'Why Droplet flagged this'", async () => {
    renderView();
    const heading = await screen.findByRole("heading", { level: 2, name: COPY.whyTitle });
    const card = document.querySelector(`[aria-labelledby="${heading.id}"]`) as HTMLElement;
    const text = card.textContent ?? "";
    expect(text.indexOf("Someone was seen inside while the site was closed")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Not usual at this time")).toBeGreaterThan(text.indexOf("Someone was seen inside while the site was closed"));
    expect(within(card).getByTestId("pattern-flag-out_of_place-trial")).toBeInTheDocument();
  });

  it("flags and no counted reason: the card says what Droplet WOULD have flagged, never that it flagged it", async () => {
    h.getSecurityIncident.mockResolvedValue(trialOnly());
    renderView();
    expect(await screen.findByRole("heading", { level: 2, name: COPY.wouldHaveTitle })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: COPY.whyTitle })).toBeNull();
    expect(screen.getByTestId("pattern-flag-out_of_place-trial")).toBeInTheDocument();
  });

  it.each(["family", null])("a trial flag is never shown to anyone but an owner or admin (role %s), even if a box sent it", async (role) => {
    h.role = role;
    h.getSecurityIncident.mockResolvedValue(
      trialOnly({ patternFlags: [flag(), flag({ code: "long_dwell", effect: "suppressed", suppression: { id: "s1", reason: "Stocktake", state: "active" } })] }),
    );
    renderView();
    expect(await screen.findByTestId("pattern-flag-long_dwell-suppressed")).toBeInTheDocument();
    expect(screen.queryByTestId("pattern-flag-out_of_place-trial")).toBeNull();
    expect(screen.queryByText(FLAG_COPY.trial)).toBeNull();
  });

  it("an admin sees the trial flag", async () => {
    h.role = "admin";
    h.getSecurityIncident.mockResolvedValue(trialOnly());
    renderView();
    expect(await screen.findByTestId("pattern-flag-out_of_place-trial")).toBeInTheDocument();
  });

  it("no counted reason and no flag the viewer may see: no reasons card at all", async () => {
    h.role = "family";
    h.getSecurityIncident.mockResolvedValue(trialOnly({ verdict: null, viewer: { level: "act", acknowledged: false, canGiveVerdict: false } }));
    renderView();
    await screen.findByRole("heading", { level: 2, name: COPY.whatTitle });
    expect(screen.queryByRole("heading", { level: 2, name: COPY.wouldHaveTitle })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: COPY.whyTitle })).toBeNull();
  });
});

describe("Was this expected? — wiring route 35", () => {
  it("comes after the reasons and before what happened", async () => {
    renderView();
    await screen.findByRole("heading", { level: 2, name: VERDICT_COPY.title });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((x) => x.textContent);
    expect(headings.indexOf(VERDICT_COPY.title)).toBeGreaterThan(headings.indexOf(COPY.whyTitle));
    expect(headings.indexOf(VERDICT_COPY.title)).toBeLessThan(headings.indexOf(COPY.whatTitle));
  });

  it("on a trial-only incident an owner can still answer (the box says so), though there's nothing to acknowledge", async () => {
    h.getSecurityIncident.mockResolvedValue(trialOnly());
    renderView();
    expect(await screen.findByRole("button", { name: VERDICT_COPY.expected })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: COPY.acknowledge })).toBeNull();
  });

  it("Expected posts the answer, shows the incident the box returned and says it was saved", async () => {
    h.setSecurityIncidentVerdict.mockResolvedValue({
      incident: detail({ verdict: { state: "expected", byName: "Maria", at: at("01:30"), codes: ["after_hours_presence", "out_of_place"] } }),
      changed: true,
    });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: VERDICT_COPY.expected }));
    await waitFor(() => expect(h.setSecurityIncidentVerdict).toHaveBeenCalledWith(ID, "expected"));
    expect(await screen.findByText("Maria said this was expected · 2:30 AM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: VERDICT_COPY.expected })).toHaveAttribute("aria-pressed", "true");
    expect(h.toast).toHaveBeenCalledWith(VERDICT_COPY.savedExpected, "success");
  });

  it("Not expected posts not_expected; an answer that changed nothing is silent", async () => {
    h.setSecurityIncidentVerdict.mockResolvedValue({ incident: detail(), changed: false });
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: VERDICT_COPY.notExpected }));
    await waitFor(() => expect(h.setSecurityIncidentVerdict).toHaveBeenCalledWith(ID, "not_expected"));
    await waitFor(() => expect(screen.getByRole("button", { name: VERDICT_COPY.notExpected })).not.toHaveAttribute("aria-disabled"));
    expect(h.toast).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT_JUDGEABLE", 409],
    ["INCIDENT_CONFLICT", 409],
    ["AUDIT_UNAVAILABLE", 503],
    ["INCIDENT_NOT_FOUND", 404],
  ])("a %s refusal: the security domain's words, never the server's, then a re-read", async (code, status) => {
    h.setSecurityIncidentVerdict.mockRejectedValue(typedError(code, status));
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: VERDICT_COPY.expected }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledTimes(1));
    const [text, kind] = h.toast.mock.calls[0]!;
    expect(kind).toBe("error");
    expect(text).toBe(translateError(typedError(code, status), "security"));
    expect(text).not.toContain("raw server text");
    await waitFor(() => expect(h.getSecurityIncident).toHaveBeenCalledTimes(2));
  });

  it("one write at a time: a second press is refused, and Acknowledge / Resolve… wait too", async () => {
    let finish: (v: unknown) => void = () => {};
    h.setSecurityIncidentVerdict.mockReturnValue(new Promise((r) => (finish = r)));
    renderView();
    const expected = await screen.findByRole("button", { name: VERDICT_COPY.expected });
    fireEvent.click(expected);
    await waitFor(() => expect(expected).toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(expected);
    fireEvent.click(screen.getByRole("button", { name: VERDICT_COPY.notExpected }));
    expect(screen.getByRole("button", { name: COPY.acknowledge })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: COPY.acknowledge }));
    expect(h.setSecurityIncidentVerdict).toHaveBeenCalledTimes(1);
    expect(h.acknowledgeSecurityIncident).not.toHaveBeenCalled();
    finish({ incident: detail(), changed: false });
    await waitFor(() => expect(expected).not.toHaveAttribute("aria-disabled"));
  });

  it("when the box's answer takes the buttons away, focus lands on the answer line, never on <body>", async () => {
    h.setSecurityIncidentVerdict.mockResolvedValue({
      incident: detail({
        verdict: { state: "expected", byName: "Maria", at: at("01:30"), codes: ["out_of_place"] },
        viewer: { level: "act", acknowledged: false, canGiveVerdict: false },
      }),
      changed: true,
    });
    renderView();
    const expected = await screen.findByRole("button", { name: VERDICT_COPY.expected });
    expected.focus();
    fireEvent.click(expected);
    await waitFor(() => expect(screen.queryByRole("button", { name: VERDICT_COPY.expected })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("verdict-answer")));
  });

  it("at view level, no buttons (the module level fails closed)", async () => {
    h.level = "view";
    renderView();
    await screen.findByRole("heading", { level: 2, name: COPY.whyTitle });
    expect(screen.queryByRole("button", { name: VERDICT_COPY.expected })).toBeNull();
  });
});
