/**
 * WARP-2978 (ADR-059 P3 §8) — the words an incident is shown in.
 *
 * Pure, so every rule is pinned here once and the card, the incident page and
 * the /d/security widget read the same sentences. Two rules shape it:
 *   · DS-005: a line is built ONLY from what the box sent for this viewer —
 *     no code, count or acknowledgement is inferred or filled in;
 *   · times are SITE time (the zone the page passes), never UTC.
 */
import { describe, it, expect } from "vitest";
import {
  INCIDENT_COPY,
  ackLine,
  clipExpired,
  codeSentence,
  evidenceLine,
  incidentTitle,
  incidentsEmpty,
  noticeLine,
  openedInLine,
  severityBadge,
  spanText,
  stateChip,
  stateLine,
  whatLine,
} from "@/components/security/incident-copy";
import type { IncidentNoticeView, IncidentReasonView, IncidentSummary, SecurityHealthRow } from "@/lib/types";

const TZ = "Europe/London";
// 02:31 BST on 2026-09-23.
const NOW = new Date("2026-09-23T01:31:00Z");
const at = (hhmm: string) => `2026-09-23T${hhmm}:00.000Z`;
const label = (name: string) => ({ back_cam: "Back camera", till: "Till" })[name] ?? name;

function summary(over: Partial<IncidentSummary> = {}): IncidentSummary {
  return {
    id: "i1",
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
    eventCount: 3,
    labels: { person: 3 },
    lastAck: null,
    ...over,
  };
}

function reason(over: Partial<Omit<IncidentReasonView, "evidence">> & { evidence?: Partial<IncidentReasonView["evidence"]> } = {}): IncidentReasonView {
  const { evidence, ...rest } = over;
  return {
    code: "after_hours_presence",
    severity: "alert",
    detail: { mode: "closed", modeSource: "schedule", nonOpenAt: at("01:14"), zoneKind: "restricted" },
    ...rest,
    evidence: {
      eventId: "901",
      camera: "back_cam",
      source: "frigate",
      kind: "detection",
      label: "person",
      at: at("01:14"),
      summary: "Person in aisle",
      ...evidence,
    },
  };
}

function notice(over: Partial<IncidentNoticeView> = {}): IncidentNoticeView {
  return {
    userId: "u1",
    name: "Stefan",
    outcome: "sent",
    reason: "routed",
    channels: "toast,push",
    pushOutcome: "sent",
    createdAt: at("01:15"),
    settledAt: at("01:15"),
    ...over,
  };
}

describe("the card's three lines", () => {
  it("titles by scope: the area's name, the camera's household name, or the site-wide words", () => {
    expect(incidentTitle(summary(), label)).toBe("Stock room");
    expect(incidentTitle(summary({ scope: "camera", zone: null, camera: "back_cam" }), label)).toBe("Back camera");
    expect(incidentTitle(summary({ scope: "site_threat", zone: null }), label)).toBe("Network and sign-in");
    expect(incidentTitle(summary({ scope: "site_camera_system", zone: null }), label)).toBe("Camera system");
    // A scope a later box adds renders as a generic title, never nothing.
    expect(incidentTitle(summary({ scope: "wall" as never, zone: null }), label)).toBe("Incident");
  });

  it("badges alert and notice; plain activity has none", () => {
    expect(severityBadge("alert")).toEqual({ cls: "badge danger", text: "Alert" });
    expect(severityBadge("notice")).toEqual({ cls: "badge warn", text: "Notice" });
    expect(severityBadge("info")).toBeNull();
  });

  it("line 2 is the visible codes, else the visible event count, then the site-time span", () => {
    expect(whatLine(summary(), TZ, NOW)).toBe("Someone inside after hours · 2:14 AM – 2:20 AM");
    expect(whatLine(summary({ reasonCodes: [], severity: "info", state: "no_action" }), TZ, NOW)).toBe("3 events · 2:14 AM – 2:20 AM");
    expect(whatLine(summary({ reasonCodes: [], eventCount: 1, lastActivityAt: at("01:14") }), TZ, NOW)).toBe("1 event · 2:14 AM");
    expect(whatLine(summary({ reasonCodes: ["after_hours_presence", "camera_offline"] }), TZ, NOW)).toBe(
      "Someone inside after hours, a camera stopped reporting · 2:14 AM – 2:20 AM",
    );
  });

  it("never says 0 events", () => {
    expect(whatLine(summary({ reasonCodes: [], eventCount: 0 }), TZ, NOW)).toBe("2:14 AM – 2:20 AM");
  });

  it("line 3: needs attention / acknowledged by whom and when / resolved by whom / still happening", () => {
    expect(stateLine(summary(), TZ, NOW)).toBe("Needs attention");
    expect(
      stateLine(summary({ state: "acknowledged", lastAck: { action: "acknowledge", byName: "Maria", at: at("01:17") } }), TZ, NOW),
    ).toBe("Acknowledged by Maria at 2:17 AM");
    expect(stateLine(summary({ state: "resolved", lastAck: { action: "resolve", byName: "Stefan", at: at("01:30") } }), TZ, NOW)).toBe(
      "Resolved by Stefan",
    );
    expect(stateLine(summary({ grouping: "collecting" }), TZ, NOW)).toBe("Needs attention · Still happening");
    expect(stateLine(summary({ state: "no_action", severity: "info", reasonCodes: [], grouping: "collecting" }), TZ, NOW)).toBe(
      "Still happening",
    );
    expect(stateLine(summary({ state: "no_action", severity: "info", reasonCodes: [] }), TZ, NOW)).toBe("");
  });

  it("DS-005: with no lastAck from the box, it never invents who acknowledged", () => {
    expect(stateLine(summary({ state: "acknowledged", lastAck: null }), TZ, NOW)).toBe("Acknowledged");
    expect(stateLine(summary({ state: "resolved", lastAck: null }), TZ, NOW)).toBe("Resolved");
  });

  it("a span names the day the way the mode card does (a bare time is today), and the day once when it doesn't change", () => {
    expect(spanText("2026-09-21T20:00:00.000Z", at("01:14"), TZ, NOW)).toBe("Mon 9:00 PM – 2:14 AM");
    expect(spanText("2026-09-21T20:00:00.000Z", "2026-09-21T20:10:00.000Z", TZ, NOW)).toBe("Mon 9:00 PM – 9:10 PM");
    // Under a minute apart: one time.
    expect(spanText(at("01:14"), "2026-09-23T01:14:40.000Z", TZ, NOW)).toBe("2:14 AM");
  });
});

describe("the incident page's header", () => {
  it("says what the site was when it opened", () => {
    expect(openedInLine("closed")).toBe("The site was closed");
    expect(openedInLine("away")).toBe("The site was set to away");
    expect(openedInLine("open")).toBe("The site was open");
  });

  it("the state chip: needs attention (danger for an alert), acknowledged, resolved; none for plain activity", () => {
    expect(stateChip("open", "alert")).toEqual({ cls: "badge danger", text: "Needs attention" });
    expect(stateChip("open", "notice")).toEqual({ cls: "badge warn", text: "Needs attention" });
    expect(stateChip("acknowledged", "alert")).toEqual({ cls: "badge info", text: "Acknowledged" });
    expect(stateChip("resolved", "alert")).toEqual({ cls: "badge ok", text: "Resolved" });
    expect(stateChip("no_action", "info")).toBeNull();
  });
});

describe("why Droplet flagged this", () => {
  it("one sentence per code, by what the evidence says", () => {
    expect(codeSentence(reason())).toBe("Someone was seen inside while the site was closed");
    expect(codeSentence(reason({ detail: { mode: "away", modeSource: "manual" } }))).toBe(
      "Someone was seen inside while the site was set to away",
    );
    expect(codeSentence(reason({ code: "camera_offline", severity: "notice", detail: { offlineForSec: null, backAt: null } }))).toBe(
      "A camera stopped reporting for more than a minute",
    );
    expect(
      codeSentence(reason({ code: "camera_offline", severity: "notice", evidence: { camera: null, kind: "source_offline" } })),
    ).toBe("The camera system stopped reporting for more than a minute");
    expect(codeSentence(reason({ code: "threat_signal", severity: "notice" }))).toBe("A network or sign-in warning");
    expect(codeSentence(reason({ code: "unusual_volume" as never }))).toBe("A reason Droplet flagged");
  });

  it("an after-hours evidence line: what, which camera, when, and the mode", () => {
    expect(evidenceLine(reason(), label, TZ, NOW)).toBe("Person · Back camera · 2:14 AM · Closed (opening hours)");
    expect(evidenceLine(reason({ detail: { mode: "closed", modeSource: "manual" } }), label, TZ, NOW)).toBe(
      "Person · Back camera · 2:14 AM · Closed up",
    );
    expect(evidenceLine(reason({ detail: { mode: "away", modeSource: "manual" } }), label, TZ, NOW)).toBe(
      "Person · Back camera · 2:14 AM · Away",
    );
  });

  it("a camera-offline line says how long, only when the box measured it", () => {
    const off = (detail: IncidentReasonView["detail"], camera: string | null = "back_cam") =>
      evidenceLine(reason({ code: "camera_offline", severity: "notice", detail, evidence: { camera, label: null, kind: "camera_offline" } }), label, TZ, NOW);
    expect(off({ offlineForSec: 250, backAt: at("01:18") })).toBe("Back camera · 2:14 AM · back after 4 min");
    expect(off({ offlineForSec: null, backAt: null })).toBe("Back camera · 2:14 AM");
    expect(off({ offlineForSec: null, backAt: null }, null)).toBe("Camera system · 2:14 AM");
  });

  it("a threat line carries the warning's own summary", () => {
    const r = reason({ code: "threat_signal", severity: "notice", evidence: { camera: null, label: "auth", kind: "threat", summary: "5 failed sign-ins for 'admin'" } });
    expect(evidenceLine(r, label, TZ, NOW)).toBe("Sign-in · 5 failed sign-ins for 'admin' · 2:14 AM");
  });
});

describe("who was told", () => {
  const cams = ["Back camera"];

  it("sent: to their phone when a push took it, else shown in Droplet", () => {
    expect(noticeLine(notice(), cams, TZ, NOW)).toBe("Stefan · sent to their phone at 2:15 AM");
    expect(noticeLine(notice({ channels: "toast", pushOutcome: "no_subscribers" }), cams, TZ, NOW)).toBe(
      "Stefan · shown in Droplet at 2:15 AM",
    );
  });

  it("not told: why, in the recipient's terms", () => {
    expect(noticeLine(notice({ name: "Maria", outcome: "skipped_not_visible" }), cams, TZ, NOW)).toBe(
      "Maria · not told: can't see Back camera",
    );
    expect(noticeLine(notice({ name: "Maria", outcome: "skipped_not_visible" }), [], TZ, NOW)).toBe(
      "Maria · not told: can't see the camera involved",
    );
    expect(noticeLine(notice({ name: "Jordan", outcome: "skipped_no_access" }), cams, TZ, NOW)).toBe(
      "Jordan · not told: no longer has access to Security",
    );
    expect(noticeLine(notice({ outcome: "skipped_capped" }), cams, TZ, NOW)).toBe("Stefan · not told: too many alerts in the last hour");
    expect(noticeLine(notice({ outcome: "skipped_no_address" }), cams, TZ, NOW)).toBe(
      "Stefan · not told: this account can't receive notifications",
    );
  });

  it("not reached, and still being sent", () => {
    expect(noticeLine(notice({ outcome: "not_sent", channels: "", pushOutcome: "refused_gate" }), cams, TZ, NOW)).toBe(
      "Stefan · not reached: phone notifications are turned off on this box",
    );
    expect(noticeLine(notice({ outcome: "not_sent", channels: "", pushOutcome: "no_subscribers" }), cams, TZ, NOW)).toBe(
      "Stefan · not reached: no phone is set up and Droplet wasn't open",
    );
    expect(noticeLine(notice({ outcome: "queued", channels: "", settledAt: null }), cams, TZ, NOW)).toBe("Stefan · being sent");
  });

  it("the owner told as the fallback says so", () => {
    expect(noticeLine(notice({ reason: "fallback_owner" }), cams, TZ, NOW)).toBe(
      "Stefan · sent to their phone at 2:15 AM · told because nobody chosen could be",
    );
  });
});

describe("acknowledgements", () => {
  it("who, when, the device as it reported itself, and whether it came from the alert", () => {
    expect(
      ackLine({ action: "acknowledge", byName: "Maria", at: at("01:17"), client: "Droplet for iPhone 1.4", viaNotification: true, note: "" }, TZ, NOW),
    ).toBe("Maria acknowledged · 2:17 AM · Droplet for iPhone 1.4 (as the device reported it) · from the alert notification");
    expect(ackLine({ action: "resolve", byName: "Stefan", at: at("01:30"), client: null, viaNotification: false, note: "Cleaner" }, TZ, NOW)).toBe(
      "Stefan resolved · 2:30 AM",
    );
  });
});

describe("clips", () => {
  it("expire with Frigate's 14 days", () => {
    expect(clipExpired(new Date(NOW.getTime() - 13 * 86_400_000).toISOString(), NOW)).toBe(false);
    expect(clipExpired(new Date(NOW.getTime() - 15 * 86_400_000).toISOString(), NOW)).toBe(true);
  });
});

describe("the empty incident list says which empty it is (P2a's honesty rule)", () => {
  const row = (id: SecurityHealthRow["id"], state: SecurityHealthRow["state"] = "ok"): SecurityHealthRow => ({ id, state, detail: "", lastSeenAt: null });
  const OK = [row("camera_ingest"), row("camera_system"), row("threat_mirror"), row("site_mode"), row("incidents"), row("retention")];
  const base = { filter: "attention" as const, sources: OK, healthError: false, canSeeThreats: true, area: null };

  it("every source reporting → nothing needs attention", () => {
    expect(incidentsEmpty(base)).toMatchObject({ kind: "quiet", head: INCIDENT_COPY.emptyAttention });
    expect(incidentsEmpty({ ...base, filter: "all" })).toMatchObject({ kind: "quiet", head: INCIDENT_COPY.emptyAll });
  });

  it("the incident engine down → never 'nothing needs attention'", () => {
    const sources = OK.map((s) => (s.id === "incidents" ? { ...s, state: "down" as const } : s));
    const e = incidentsEmpty({ ...base, sources });
    expect(e.kind).toBe("not-reporting");
    expect(e.head).toBe(INCIDENT_COPY.emptyNotSorting);
  });

  it("a box without the incidents row (older than P3) is not sorting either", () => {
    expect(incidentsEmpty({ ...base, sources: OK.filter((s) => s.id !== "incidents") }).kind).toBe("not-reporting");
  });

  it("the cameras down → not reporting; a quiet source → the quiet copy is qualified", () => {
    expect(incidentsEmpty({ ...base, sources: OK.map((s) => (s.id === "camera_ingest" ? { ...s, state: "down" as const } : s)) }).kind).toBe(
      "not-reporting",
    );
    const partial = incidentsEmpty({ ...base, sources: OK.map((s) => (s.id === "camera_system" ? { ...s, state: "quiet" as const } : s)) });
    expect(partial.kind).toBe("partial");
    expect(partial.body).toBe(INCIDENT_COPY.emptyPartialBody);
  });

  it("the threat check only counts for people who can see threats", () => {
    const sources = OK.map((s) => (s.id === "threat_mirror" ? { ...s, state: "down" as const } : s));
    expect(incidentsEmpty({ ...base, sources }).kind).toBe("not-reporting");
    expect(incidentsEmpty({ ...base, sources: sources.filter((s) => s.id !== "threat_mirror"), canSeeThreats: false }).kind).toBe("quiet");
  });

  it("the sources couldn't be checked → never quiet", () => {
    expect(incidentsEmpty({ ...base, sources: null, healthError: true }).kind).toBe("not-reporting");
  });

  it("an area no camera covers is its own empty state, checked first", () => {
    const e = incidentsEmpty({ ...base, area: { name: "Stock room", linkCount: 0 } });
    expect(e.kind).toBe("not-covered");
    expect(e.head).toBe("No cameras cover Stock room yet");
  });
});
